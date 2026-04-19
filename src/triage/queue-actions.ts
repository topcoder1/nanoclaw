import { getDb } from '../db.js';
import { recordExample } from './examples.js';
import { recordSkip } from './prefilter.js';
import { TRIAGE_DEFAULTS } from './config.js';
import { logger } from '../logger.js';
import type { GmailOps } from '../gmail-ops.js';

interface ItemRow {
  id: string;
  source: string;
  classification: string | null;
  title: string;
  thread_id: string | null;
  metadata: string | null;
  model_tier: number | null;
}

function getItem(id: string): ItemRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, source, classification, title, thread_id, metadata, model_tier FROM tracked_items WHERE id = ?`,
    )
    .get(id) as ItemRow | undefined;
}

function parseSender(metadata: string | null): string {
  try {
    const m = metadata ? JSON.parse(metadata) : {};
    return String(m.sender ?? '');
  } catch {
    return '';
  }
}

function parseAccount(metadata: string | null): string | null {
  try {
    const m = metadata ? JSON.parse(metadata) : {};
    return typeof m.account === 'string' ? m.account : null;
  } catch {
    return null;
  }
}

export interface HandleArchiveOpts {
  gmailOps?: Pick<GmailOps, 'archiveThread'>;
}

export interface HandleArchiveResult {
  archived: boolean;
  reason?: 'missing' | 'gmail_failed' | 'gmail_unavailable';
  error?: string;
}

/**
 * Archive a tracked item from a Telegram button / attention card.
 *
 * For gmail-sourced items with an account + thread_id, this archives the
 * thread in Gmail first and only resolves locally if Gmail succeeds. This
 * preserves the "Gmail is source of truth" invariant — a local resolve
 * without a Gmail archive would cause the reconciler to immediately
 * re-surface the item (it'd still be in INBOX).
 *
 * Non-gmail items (or gmail items missing metadata) resolve locally
 * as before.
 */
export async function handleArchive(
  itemId: string,
  opts: HandleArchiveOpts = {},
): Promise<HandleArchiveResult> {
  const item = getItem(itemId);
  if (!item) return { archived: false, reason: 'missing' };

  // Source-of-truth archive in Gmail for gmail-sourced items.
  if (item.source === 'gmail' && item.thread_id) {
    const account = parseAccount(item.metadata);
    if (account && opts.gmailOps) {
      try {
        await opts.gmailOps.archiveThread(account, item.thread_id);
      } catch (err) {
        logger.warn(
          {
            itemId,
            account,
            threadId: item.thread_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'handleArchive: Gmail archive failed, leaving item queued',
        );
        return {
          archived: false,
          reason: 'gmail_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (!opts.gmailOps) {
      logger.warn(
        { itemId },
        'handleArchive: gmailOps unavailable, resolving locally only',
      );
    }
  }

  getDb()
    .prepare(
      `UPDATE tracked_items SET state = 'resolved', resolution_method = 'manual:button', resolved_at = ? WHERE id = ?`,
    )
    .run(Date.now(), itemId);

  // Only promote to skip-list if this item was triage-classified. Legacy
  // archive actions on pre-triage items must not pollute the skip-list.
  const sender = parseSender(item.metadata);
  if (sender && item.model_tier !== null) {
    const { promoted } = recordSkip(
      sender,
      TRIAGE_DEFAULTS.skiplistPromotionHits,
    );
    if (promoted) {
      logger.info({ sender }, 'Triage: sender promoted to skip-list');
    }
  }

  if (item.classification) {
    // Archive from an attention card is effectively an override: the
    // classifier put this item in attention and the user chose to archive
    // — so the routing was wrong. Record as a negative example so the
    // learning loop can correct. This consolidates the former
    // "Move to archive queue" button's role into plain "Archive".
    recordExample({
      kind: 'negative',
      trackedItemId: itemId,
      emailSummary: item.title,
      agentQueue: item.classification,
      userQueue: 'archive_candidate',
      reasons: ['user archived from attention card'],
    });
  }

  return { archived: true };
}

export function handleDismiss(itemId: string): void {
  getDb()
    .prepare(
      `UPDATE tracked_items SET state = 'resolved', resolution_method = 'manual:button', resolved_at = ? WHERE id = ?`,
    )
    .run(Date.now(), itemId);
}

export type SnoozeDuration = '1h' | 'tomorrow';

export function handleSnooze(itemId: string, duration: SnoozeDuration): void {
  const now = Date.now();
  let untilMs: number;
  if (duration === '1h') {
    untilMs = now + 60 * 60 * 1000;
  } else {
    // "tomorrow" → 8am next day
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    untilMs = tomorrow.getTime();
  }
  getDb()
    .prepare(
      `UPDATE tracked_items SET state = 'held', metadata = json_set(COALESCE(metadata, '{}'), '$.snoozed_until', ?) WHERE id = ?`,
    )
    .run(untilMs, itemId);
}

export type OverrideQueue = 'attention' | 'archive_candidate';

export function handleOverride(itemId: string, userQueue: OverrideQueue): void {
  const item = getItem(itemId);
  if (!item || !item.classification) return;

  recordExample({
    kind: 'negative',
    trackedItemId: itemId,
    emailSummary: item.title,
    agentQueue: item.classification,
    userQueue,
    reasons: [`user override to ${userQueue}`],
  });
}
