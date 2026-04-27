/**
 * Recall-time citation enrichment.
 *
 * Pure helpers, no side effects. The recall pipeline keeps KU rows lean —
 * subject and sender are not stored on `knowledge_units`, they live in the
 * raw_events.payload JSON. At display time we do one indexed lookup per
 * top-N hit on `(source_type, source_ref)` to pull the human-readable bits
 * back. Cheap (default N=5; the index covers it) and avoids the schema
 * churn of denormalising subject/sender onto every KU.
 *
 * Why this lives in `brain/` and not `mini-app/`: the same enrichment is
 * needed by the chat `/recall` reply, which can't depend on UI code.
 */

import type Database from 'better-sqlite3';

/**
 * Build a Gmail deep-link URL for a thread. Mirrors the rationale in
 * `mini-app/brain-routes.ts:buildGmailDeepLink` — `?authuser=<email>` is
 * the only form that survives Google's redirect for Workspace accounts.
 *
 * Returns a bare `/mail/#all/<id>` URL when the email is unknown.
 */
export function buildGmailDeepLink(
  email: string | null,
  threadId: string,
): string {
  const id = encodeURIComponent(threadId);
  if (!email) return `https://mail.google.com/mail/#all/${id}`;
  return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(email)}#all/${id}`;
}

export interface Citation {
  /** Email subject, when the source is an email and the payload has it. */
  subject: string | null;
  /** Sender email address, when present in the payload. */
  senderEmail: string | null;
  /** Best-effort deep link. Email → Gmail; other sources → null. */
  url: string | null;
}

const EMPTY: Citation = { subject: null, senderEmail: null, url: null };

/**
 * Best-effort enrichment for a recall hit. Reads the raw_events.payload row
 * keyed by `(source_type, source_ref)`. Failures (missing row, bad JSON,
 * unknown alias) are swallowed and return null fields — citations are a
 * trust-building nicety, never load-bearing.
 *
 * `resolveAlias` maps the email account alias on the payload (e.g.
 * `'personal'`, `'attaxion'`) to the canonical mailbox address used in the
 * Gmail deep link. Wired to `gmailOpsRouter.emailAddressForAlias` in
 * production; pass `() => null` in tests where the alias isn't available.
 */
export function enrichCitation(
  db: Database.Database,
  sourceType: string,
  sourceRef: string | null,
  resolveAlias: (alias: string) => string | null,
): Citation {
  if (!sourceRef) return EMPTY;
  if (sourceType !== 'email') return EMPTY;

  let payload: { subject?: unknown; sender?: unknown; account?: unknown };
  try {
    const row = db
      .prepare(
        `SELECT payload FROM raw_events
          WHERE source_type = 'email' AND source_ref = ?
          LIMIT 1`,
      )
      .get(sourceRef) as { payload: Buffer | string } | undefined;
    if (!row) return EMPTY;
    const text =
      typeof row.payload === 'string'
        ? row.payload
        : row.payload.toString('utf8');
    payload = JSON.parse(text) as typeof payload;
  } catch {
    return EMPTY;
  }

  const subject =
    typeof payload.subject === 'string' && payload.subject.trim().length > 0
      ? payload.subject.trim()
      : null;
  const senderEmail =
    typeof payload.sender === 'string' && payload.sender.trim().length > 0
      ? payload.sender.trim()
      : null;

  let mailbox: string | null = null;
  if (typeof payload.account === 'string' && payload.account.trim()) {
    mailbox = resolveAlias(payload.account.trim());
  }

  return {
    subject,
    senderEmail,
    url: buildGmailDeepLink(mailbox, sourceRef),
  };
}
