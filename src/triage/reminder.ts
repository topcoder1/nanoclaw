import { getDb } from '../db.js';
import { sendTelegramMessage } from '../channels/telegram.js';
import { readEnvValue } from '../env.js';
import { logger } from '../logger.js';
import type { GmailOps } from '../gmail-ops.js';

export interface ReminderSweepOpts {
  windowHours: number;
  /**
   * Optional Gmail accessor. When provided, gmail-sourced rows get a
   * synchronous INBOX-status check before any reminder is sent — if the
   * user already archived the thread out-of-band (Gmail web/mobile/another
   * client), we resolve the row in place and suppress the reminder. This
   * closes the race window between an out-of-band archive and the
   * gmail-reconciler's eventual-consistency loop, which can take 2-4 min
   * and stalls entirely if the reconciler is hung.
   *
   * If omitted (e.g. tests), the precheck is skipped and behavior matches
   * the legacy "trust local state" path.
   */
  gmailOps?: Pick<GmailOps, 'getThreadInboxStatus'>;
  /**
   * Per-Gmail-call deadline. Defaults to 10s. A hung Google serving node
   * must not pin the sweep — on timeout we treat it as "couldn't verify"
   * and fall through to sending the reminder rather than suppressing it.
   * Suppression on a transient failure would be the worse error.
   */
  gmailCallTimeoutMs?: number;
}

const DEFAULT_GMAIL_CALL_TIMEOUT_MS = 10_000;

interface CandidateRow {
  id: string;
  title: string;
  source: string;
  thread_id: string | null;
  metadata: string | null;
  detected_at: number;
}

function parseAccount(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as { account?: unknown };
    return typeof m.account === 'string' ? m.account : null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Scan tracked_items for attention-queue items that are still open
 * (state IN ('pushed','pending')) and older than `windowHours` since detection,
 * and that have never been reminded. For each one, send a single Telegram
 * reminder and stamp `reminded_at` so we never re-send.
 *
 * For gmail-sourced rows with `opts.gmailOps` supplied, the thread's INBOX
 * status is checked synchronously before sending — if it's already out of
 * INBOX (archived elsewhere) or the user replied in-thread, the row is
 * resolved in place and no reminder fires.
 */
export async function runAttentionReminderSweep(
  opts: ReminderSweepOpts,
): Promise<void> {
  const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
  if (!chatId) return;

  const windowMs = opts.windowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const callTimeoutMs =
    opts.gmailCallTimeoutMs ?? DEFAULT_GMAIL_CALL_TIMEOUT_MS;

  const rows = getDb()
    .prepare(
      `SELECT id, title, source, thread_id, metadata, detected_at FROM tracked_items
       WHERE state IN ('pushed', 'pending')
         AND detected_at <= ?
         AND reminded_at IS NULL`,
    )
    .all(cutoff) as CandidateRow[];

  for (const r of rows) {
    // Synchronous Gmail INBOX precheck for gmail-sourced rows. We trust
    // a definitive Gmail response over the local cached state. On error
    // or timeout we fall through to the reminder — suppressing a real
    // reminder due to a transient Gmail outage is the worse failure mode.
    if (opts.gmailOps && r.source === 'gmail' && r.thread_id) {
      const account = parseAccount(r.metadata);
      if (account) {
        try {
          const status = await withTimeout(
            opts.gmailOps.getThreadInboxStatus(
              account,
              r.thread_id,
              r.detected_at,
            ),
            callTimeoutMs,
            `getThreadInboxStatus(${account}, ${r.thread_id})`,
          );
          if (status !== 'in') {
            // Thread is no longer in INBOX (or user replied) — the user
            // already handled this. Resolve in place; do NOT remind.
            // Use a CAS guard on state so we don't clobber a concurrent
            // resolution (callback-router archive, reconciler, etc.).
            getDb()
              .prepare(
                `UPDATE tracked_items
                 SET state = 'resolved',
                     resolution_method = ?,
                     resolved_at = ?
                 WHERE id = ? AND state IN ('pushed','pending')`,
              )
              .run(
                status === 'user-replied'
                  ? 'gmail:user-replied'
                  : 'gmail:external',
                Date.now(),
                r.id,
              );
            logger.info(
              { itemId: r.id, threadId: r.thread_id, account, status },
              'Triage reminder: thread already handled in Gmail → suppressed reminder',
            );
            continue;
          }
        } catch (err) {
          // Timeout or Gmail error — fall through to send the reminder.
          logger.warn(
            { err: String(err), itemId: r.id, account },
            'Triage reminder: Gmail precheck failed, sending reminder anyway',
          );
        }
      }
    }

    // Claim the item via CAS: only reminded_at=NULL rows get stamped. If two
    // sweeps (or a restarted process) see the same row, only one wins.
    // Stamping BEFORE the send means a crash mid-send means we skip the
    // reminder — preferable to double-reminding the user.
    const claim = getDb()
      .prepare(
        `UPDATE tracked_items SET reminded_at = ?
         WHERE id = ? AND reminded_at IS NULL`,
      )
      .run(Date.now(), r.id);
    if (claim.changes !== 1) continue;

    try {
      await sendTelegramMessage(
        chatId,
        `⏰ Still waiting on you: *${r.title}*`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: r.id },
        'Triage: failed to send attention reminder (already marked reminded)',
      );
    }
  }
}
