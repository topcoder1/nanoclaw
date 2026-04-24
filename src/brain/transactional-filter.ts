/**
 * Prefilter for brain extraction: skip transactional / low-value emails.
 *
 * Two independent checks (either triggers a skip):
 *
 * 1. **Sender / subject heuristics.** RFC-style transactional patterns —
 *    `no-reply@`, `billing@`, `receipts@`, and subject markers like
 *    "receipt", "invoice", "order confirmation". Catches receipts/newsletters
 *    without needing full email headers (which aren't in the event payload).
 *
 * 2. **Triage classification.** If nanoclaw's triage already tagged the
 *    thread as `digest` or the item as `queue='archive_candidate'`, the
 *    brain shouldn't waste an LLM-tier extraction on it. Reuses work already
 *    done upstream. Tolerant of timing — if classification isn't set yet
 *    (race between triage + brain), this check is a no-op and the heuristic
 *    filter above still applies.
 */
import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

const TRANSACTIONAL_SENDER_RE =
  /^(no-?reply|do-?not-?reply|notifications?|billing|receipts?|invoicing|invoices?|orders?|payments?|mailer-?daemon|postmaster|automailer|autoresponder|support|alerts?|team|hello|info|news|newsletter)@/i;

const TRANSACTIONAL_SUBJECT_RE =
  /\b(receipt|invoice|statement|order\s+(confirmation|#|number|placed)|payment\s+(received|confirmation|failed|successful)|subscription\s+(renewal|renewed|cancelled)|your\s+order|thanks?\s+for\s+your\s+(purchase|order|payment|subscription)|shipment|shipped|tracking\s+number|billing|auto-?submitted|unsubscribe)\b/i;

export type TransactionalSkipReason =
  | 'sender_pattern'
  | 'subject_pattern'
  | 'classification_digest';

export function matchTransactionalHeuristic(email: {
  sender?: string;
  subject?: string;
}): TransactionalSkipReason | null {
  if (email.sender && TRANSACTIONAL_SENDER_RE.test(email.sender.trim())) {
    return 'sender_pattern';
  }
  if (email.subject && TRANSACTIONAL_SUBJECT_RE.test(email.subject)) {
    return 'subject_pattern';
  }
  return null;
}

/**
 * Check nanoclaw's `tracked_items` for a classification that says "don't
 * waste extraction on this". Returns null if no matching row, or if the
 * classification is still pending (triage hasn't run yet).
 */
export function matchLowValueClassification(
  nanoclawDb: Database.Database,
  threadId: string,
): TransactionalSkipReason | null {
  try {
    const row = nanoclawDb
      .prepare(
        `SELECT classification, queue FROM tracked_items
         WHERE thread_id = ?
         ORDER BY detected_at DESC
         LIMIT 1`,
      )
      .get(threadId) as
      | { classification: string | null; queue: string | null }
      | undefined;
    if (!row) return null;
    if (row.queue === 'archive_candidate') return 'classification_digest';
    if (row.classification === 'digest') return 'classification_digest';
    return null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), threadId },
      'transactional-filter: tracked_items lookup failed (non-fatal)',
    );
    return null;
  }
}

export function shouldSkipBrainExtraction(
  nanoclawDb: Database.Database | null,
  email: { thread_id: string; sender?: string; subject?: string },
): TransactionalSkipReason | null {
  const heuristic = matchTransactionalHeuristic(email);
  if (heuristic) return heuristic;
  if (nanoclawDb) {
    const classification = matchLowValueClassification(
      nanoclawDb,
      email.thread_id,
    );
    if (classification) return classification;
  }
  return null;
}
