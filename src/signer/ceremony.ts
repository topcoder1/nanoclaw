import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import type { EventBus } from '../event-bus.js';
import type {
  SignApprovedEvent,
  SignCancelledEvent,
  SignFieldInputProvidedEvent,
  SignFieldInputNeededEvent,
} from '../events.js';
import { logger } from '../logger.js';
import { getProfile } from './profile.js';
import {
  getCeremony,
  transitionState,
  updateFailure,
  updateSignedPdf,
} from './ceremony-repo.js';
import { resolveExecutor, isWhitelistedUrl } from './executor-registry.js';
import { archivePathFor, failureScreenshotPathFor, postReceipt } from './receipt.js';
import { renderDoubleConfirmCard } from './card-renderer.js';

export interface OrchestratorDeps {
  db: Database.Database;
  bus: EventBus;
  groupRoot: string;
  chatId: string;
  connectBrowser: () => Promise<Browser>;
  sendText: (
    chatId: string,
    text: string,
    opts?: unknown,
  ) => Promise<{ message_id: number } | void>;
  sendDocument: (chatId: string, filePath: string, opts?: unknown) => Promise<void>;
  sendPhoto: (chatId: string, filePath: string, opts?: unknown) => Promise<void>;
}

const CEREMONY_DEADLINE_MS = 90_000;
const MAX_CONCURRENT_SIGNING = 3;

let signingSlots = 0;

export function startCeremonyOrchestrator(deps: OrchestratorDeps): () => void {
  const unsubApprove = deps.bus.on('sign.approved', (evt) => {
    void handleApproved(deps, evt);
  });
  const unsubCancel = deps.bus.on('sign.cancelled', (evt) => {
    void handleCancelled(deps, evt);
  });

  return () => {
    unsubApprove();
    unsubCancel();
  };
}

async function handleCancelled(deps: OrchestratorDeps, evt: SignCancelledEvent): Promise<void> {
  const c = getCeremony(deps.db, evt.payload.ceremonyId);
  if (!c) return;
  if (['signed', 'failed', 'cancelled'].includes(c.state)) return;
  transitionState(deps.db, c.id, c.state, 'cancelled');
}

async function handleApproved(deps: OrchestratorDeps, evt: SignApprovedEvent): Promise<void> {
  const { db, bus, chatId, sendText } = deps;
  const ceremonyId = evt.payload.ceremonyId;
  const c = getCeremony(db, ceremonyId);
  if (!c) {
    logger.warn({ ceremonyId }, 'sign.approved for unknown ceremony');
    return;
  }

  // State-based routing:
  //   summarized + high flags → transition to approval_requested, post double-confirm
  //   summarized + no flags   → transition to approved, run ceremony
  //   approval_requested      → transition to approved, run ceremony
  //   approved                → replay-safe no-op; only one signing should run
  //   anything else           → ignore
  const hasHighFlags = c.riskFlags.some((f) => f.severity === 'high');

  if (c.state === 'summarized' && hasHighFlags) {
    const ok = transitionState(db, c.id, 'summarized', 'approval_requested');
    if (!ok) return;
    const card = renderDoubleConfirmCard({ ...c, state: 'approval_requested' });
    const result = await sendText(chatId, card.text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: card.buttons },
    });
    const msgId = result && typeof result === 'object' && 'message_id' in result
      ? (result as { message_id: number }).message_id
      : 0;
    bus.emit('sign.approval_requested', {
      type: 'sign.approval_requested',
      source: 'signer',
      timestamp: Date.now(),
      payload: { ceremonyId: c.id, telegramMessageId: msgId },
    });
    return;
  }

  let ok = false;
  if (c.state === 'summarized') {
    ok = transitionState(db, c.id, 'summarized', 'approved');
  } else if (c.state === 'approval_requested') {
    ok = transitionState(db, c.id, 'approval_requested', 'approved');
  } else if (c.state === 'approved') {
    // already approved; only run ceremony if not yet signing
    ok = true;
  } else {
    return;
  }
  if (!ok) return;

  // approved → signing (atomic claim — idempotency guard)
  const claim = transitionState(db, c.id, 'approved', 'signing');
  if (!claim) return; // already being signed

  if (signingSlots >= MAX_CONCURRENT_SIGNING) {
    // Back off; revert to approved so another worker can pick up later.
    transitionState(db, c.id, 'signing', 'approved');
    return;
  }
  signingSlots++;

  bus.emit('sign.signing_started', {
    type: 'sign.signing_started',
    source: 'signer',
    timestamp: Date.now(),
    payload: { ceremonyId: c.id },
  });

  const start = Date.now();
  const aborter = new AbortController();
  const deadline = setTimeout(() => aborter.abort(), CEREMONY_DEADLINE_MS);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let screenshotPath: string | null = null;

  try {
    const profile = getProfile(db);
    if (!profile) throw new Error('no_signer_profile');

    const executor = resolveExecutor(c.vendor);
    if (!isWhitelistedUrl(executor, c.signUrl)) {
      throw new Error('url_not_whitelisted');
    }

    browser = await deps.connectBrowser();
    context = await browser.newContext();

    const pendingInputs = new Map<string, (value: string | null) => void>();
    const unsubInput = bus.on('sign.field_input_provided', (e: SignFieldInputProvidedEvent) => {
      if (e.payload.ceremonyId !== c.id) return;
      const pending = pendingInputs.get(e.payload.fieldLabel);
      if (pending) {
        pendingInputs.delete(e.payload.fieldLabel);
        pending(e.payload.value);
      }
    });

    try {
      const result = await executor.sign({
        ceremony: c,
        profile,
        context,
        signal: aborter.signal,
        onFieldInputNeeded: async (req: SignFieldInputNeededEvent['payload']) => {
          bus.emit('sign.field_input_needed', {
            type: 'sign.field_input_needed',
            source: 'signer',
            timestamp: Date.now(),
            payload: req,
          });
          const waiter = new Promise<string | null>((resolve) => {
            pendingInputs.set(req.fieldLabel, resolve);
          });
          const remaining = CEREMONY_DEADLINE_MS - (Date.now() - start);
          const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(remaining, 0)));
          return Promise.race([waiter, timeout]);
        },
      });

      // Executor succeeded — download PDF and archive.
      const pages = context.pages();
      const page = pages[pages.length - 1] ?? (await context.newPage());
      const destPath = archivePathFor(deps.groupRoot, c.id, c.docTitle);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await executor.downloadSignedPdf(page, destPath);
      updateSignedPdf(db, c.id, destPath);
      transitionState(db, c.id, 'signing', 'signed');

      bus.emit('sign.completed', {
        type: 'sign.completed',
        source: 'signer',
        timestamp: Date.now(),
        payload: {
          ceremonyId: c.id,
          signedPdfPath: destPath,
          durationMs: Date.now() - start,
        },
      });

      await postReceipt({
        db,
        ceremonyId: c.id,
        outcome: 'signed',
        chatId,
        sendText: async (...args) => {
          await deps.sendText(...args);
        },
        sendDocument: deps.sendDocument,
      });

      void result;
    } finally {
      unsubInput();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    // Try to capture a screenshot from any open page
    try {
      if (context) {
        const pages = context.pages();
        if (pages.length > 0) {
          screenshotPath = failureScreenshotPathFor(deps.groupRoot, c.id);
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          const buf = await pages[pages.length - 1].screenshot();
          fs.writeFileSync(screenshotPath, buf);
        }
      }
    } catch (shotErr) {
      logger.warn({ err: shotErr, ceremonyId: c.id }, 'screenshot capture failed');
    }

    updateFailure(db, c.id, reason, screenshotPath);

    bus.emit('sign.failed', {
      type: 'sign.failed',
      source: 'signer',
      timestamp: Date.now(),
      payload: { ceremonyId: c.id, reason, screenshotPath },
    });

    await postReceipt({
      db,
      ceremonyId: c.id,
      outcome: 'failed',
      chatId,
      sendText: async (...args) => {
        await deps.sendText(...args);
      },
      sendDocument: deps.sendDocument,
      sendPhoto: deps.sendPhoto,
    }).catch((e) => logger.warn({ err: e, ceremonyId: c.id }, 'postReceipt(failed) threw'));
  } finally {
    clearTimeout(deadline);
    signingSlots--;
    if (context) await context.close().catch(() => undefined);
  }
}
