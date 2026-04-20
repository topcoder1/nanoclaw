import express from 'express';
import type Database from 'better-sqlite3';
import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';
import { muteThread, unmuteThread } from '../triage/mute-filter.js';
import {
  pickUnsubscribeMethod,
  executeUnsubscribe,
} from '../triage/unsubscribe-executor.js';
import type { PendingSendRegistry } from './pending-send.js';

export interface ActionDeps {
  db: Database.Database;
  gmailOps?: GmailOps;
  fetchImpl?: typeof globalThis.fetch;
  pendingSendRegistry?: PendingSendRegistry;
}

const signatureCache = new Map<string, string>();

function firstNameFor(account: string): string {
  const cached = signatureCache.get(account);
  if (cached) return cached;
  const local = account.split('@')[0] || 'me';
  const first = (local.split(/[._-]/)[0] || 'me').replace(/^./, (c) =>
    c.toUpperCase(),
  );
  signatureCache.set(account, first);
  return first;
}

const CANNED: Record<string, (name: string) => string> = {
  thanks: (n) => `Thanks!\n\n${n}`,
  'got-it': (n) => `Got it — thanks.\n\n${n}`,
  'will-do': (n) => `Will do. Thanks,\n\n${n}`,
};

export function createActionsRouter(deps: ActionDeps): express.Router {
  const router = express.Router();

  function lookupItem(
    id: string,
  ): { id: string; thread_id: string | null; account: string | null } | null {
    const row = deps.db
      .prepare('SELECT id, thread_id, metadata FROM tracked_items WHERE id = ?')
      .get(id) as
      | { id: string; thread_id: string | null; metadata: string | null }
      | undefined;
    if (!row) return null;
    let account: string | null = null;
    if (row.metadata) {
      try {
        account =
          (JSON.parse(row.metadata) as { account?: string }).account ?? null;
      } catch {
        logger.debug(
          { id, component: 'mini-app-actions' },
          'metadata JSON.parse failed',
        );
      }
    }
    return { id: row.id, thread_id: row.thread_id, account };
  }

  router.post('/api/email/:id/mute', async (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id || !item.account) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found or missing thread/account',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    muteThread(deps.db, {
      threadId: item.thread_id,
      account: item.account,
    });
    if (deps.gmailOps) {
      try {
        await deps.gmailOps.archiveThread(item.account, item.thread_id);
      } catch (err) {
        logger.error(
          { err, id: req.params.id, component: 'mini-app-actions' },
          'Mute archive failed',
        );
      }
    }
    res.json({ ok: true });
  });

  router.delete('/api/email/:id/mute', (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    unmuteThread(deps.db, item.thread_id);
    res.json({ ok: true });
  });

  router.post('/api/email/:id/snooze', (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    const body = (req.body ?? {}) as { duration?: string; wake_at?: string };
    const parsed = resolveWakeAt(body.duration ?? '', body.wake_at);
    if (!parsed.ok) {
      res.status(400).json({
        ok: false,
        error: parsed.reason,
        code: 'INVALID_DURATION',
      });
      return;
    }

    const existing = deps.db
      .prepare('SELECT state, queue FROM tracked_items WHERE id = ?')
      .get(item.id) as { state: string; queue: string | null };

    deps.db.transaction(() => {
      deps.db
        .prepare(
          `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET
             snoozed_at = excluded.snoozed_at,
             wake_at = excluded.wake_at,
             original_state = excluded.original_state,
             original_queue = excluded.original_queue`,
        )
        .run(
          item.id,
          Date.now(),
          parsed.wake_at,
          existing.state,
          existing.queue,
        );
      deps.db
        .prepare(`UPDATE tracked_items SET state = 'snoozed' WHERE id = ?`)
        .run(item.id);
    })();

    res.json({ ok: true, wake_at: parsed.wake_at });
  });

  router.post('/api/email/:id/unsubscribe', async (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id || !item.account) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    if (!deps.gmailOps) {
      res.status(503).json({
        ok: false,
        error: 'Gmail not configured',
        code: 'GMAIL_UNAVAILABLE',
      });
      return;
    }

    const row = deps.db
      .prepare('SELECT source_id FROM tracked_items WHERE id = ?')
      .get(req.params.id) as { source_id: string | null } | undefined;
    const rawGmailId = row?.source_id ?? null;
    const gmailId = rawGmailId?.startsWith('gmail:')
      ? rawGmailId.slice('gmail:'.length)
      : (rawGmailId ?? item.thread_id);

    let headers: Record<string, string> = {};
    try {
      const meta = await deps.gmailOps.getMessageMeta(item.account, gmailId);
      headers = meta?.headers ?? {};
    } catch (err) {
      logger.error(
        { err, id: req.params.id, component: 'mini-app-actions' },
        'Unsubscribe: failed to fetch headers',
      );
    }

    const method = pickUnsubscribeMethod(headers);
    if (method.kind === 'none') {
      res.status(422).json({
        ok: false,
        error: 'No List-Unsubscribe header present',
        code: 'NO_UNSUBSCRIBE_HEADER',
      });
      return;
    }

    const result = await executeUnsubscribe({
      method,
      account: item.account,
      fetch: deps.fetchImpl ?? fetch,
      gmailOps: deps.gmailOps,
    });

    deps.db
      .prepare(
        `INSERT INTO unsubscribe_log (item_id, method, url, status, error, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.params.id,
        result.method,
        result.url ?? null,
        result.status,
        result.error ?? null,
        Date.now(),
      );

    try {
      await deps.gmailOps.archiveThread(item.account, item.thread_id);
    } catch (err) {
      logger.error(
        { err, id: req.params.id, component: 'mini-app-actions' },
        'Unsubscribe: archive failed',
      );
    }

    const succeeded = result.status >= 200 && result.status < 400;
    if (!succeeded && result.status !== 0) {
      res.status(502).json({
        ok: false,
        error: `Remote returned ${result.status}`,
        code: 'UNSUBSCRIBE_REMOTE_FAILED',
        method: result.method,
      });
      return;
    }
    res.json({ ok: true, method: result.method, status: result.status });
  });

  router.delete('/api/email/:id/snooze', (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    const snooze = deps.db
      .prepare(
        `SELECT original_state, original_queue FROM snoozed_items WHERE item_id = ?`,
      )
      .get(item.id) as
      | { original_state: string; original_queue: string | null }
      | undefined;
    if (!snooze) {
      res.json({ ok: true });
      return;
    }
    deps.db.transaction(() => {
      deps.db
        .prepare(`UPDATE tracked_items SET state = ?, queue = ? WHERE id = ?`)
        .run(snooze.original_state, snooze.original_queue, item.id);
      deps.db
        .prepare(`DELETE FROM snoozed_items WHERE item_id = ?`)
        .run(item.id);
    })();
    res.json({ ok: true });
  });

  router.post('/api/email/:id/canned-reply', async (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id || !item.account) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    const kind = ((req.body as { kind?: string } | undefined)?.kind ?? '') as
      | string
      | '';
    const builder = CANNED[kind];
    if (!builder) {
      res.status(400).json({
        ok: false,
        error: `unknown kind: ${kind || '(empty)'}`,
        code: 'INVALID_KIND',
      });
      return;
    }
    if (!deps.gmailOps || !deps.pendingSendRegistry) {
      res.status(503).json({
        ok: false,
        error: 'dependencies missing',
        code: 'INTERNAL',
      });
      return;
    }
    const body = builder(firstNameFor(item.account));
    let draftId: string;
    try {
      const result = await deps.gmailOps.createDraftReply(item.account, {
        threadId: item.thread_id,
        body,
      });
      draftId = result.draftId;
    } catch (err) {
      logger.error(
        { err, id: req.params.id, component: 'mini-app-actions' },
        'canned-reply: createDraftReply failed',
      );
      res.status(502).json({
        ok: false,
        error: 'createDraftReply failed',
        code: 'DRAFT_CREATE_FAILED',
      });
      return;
    }
    const { sendAt } = deps.pendingSendRegistry.schedule(
      draftId,
      item.account,
      10_000,
      async (id, acct) => {
        try {
          await deps.gmailOps!.sendDraft(acct, id);
        } catch (err) {
          logger.error(
            { err, draftId: id, component: 'mini-app-actions' },
            'canned-reply send failed',
          );
        }
      },
    );
    res.json({ ok: true, draftId, sendAt });
  });

  return router;
}

const MAX_SNOOZE_MS = 90 * 86400_000;

function resolveWakeAt(
  duration: string,
  customIso: string | undefined,
): { ok: true; wake_at: number } | { ok: false; reason: string } {
  const now = Date.now();
  switch (duration) {
    case '1h':
      return { ok: true, wake_at: now + 3600_000 };
    case 'tomorrow-8am': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'next-monday-8am': {
      const d = new Date(now);
      const daysUntilMonday = (1 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilMonday);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'next-week': {
      const d = new Date(now);
      d.setDate(d.getDate() + 7);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'custom': {
      if (!customIso) return { ok: false, reason: 'custom requires wake_at' };
      const t = Date.parse(customIso);
      if (Number.isNaN(t))
        return { ok: false, reason: 'invalid wake_at ISO string' };
      if (t <= now)
        return { ok: false, reason: 'wake_at must be in the future' };
      if (t > now + MAX_SNOOZE_MS)
        return { ok: false, reason: 'wake_at exceeds 90-day cap' };
      return { ok: true, wake_at: t };
    }
    default:
      return { ok: false, reason: `unknown duration: ${duration}` };
  }
}
