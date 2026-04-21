import type Database from 'better-sqlite3';
import type { SignCeremony, SignCeremonyState, RiskFlag, SignVendor } from './types.js';

const TERMINAL_STATES: ReadonlySet<SignCeremonyState> = new Set(['signed', 'failed', 'cancelled']);

export interface CreateCeremonyInput {
  id: string;
  emailId: string;
  vendor: SignVendor;
  signUrl: string;
  docTitle?: string | null;
}

interface Row {
  id: string;
  email_id: string;
  vendor: SignVendor;
  sign_url: string;
  doc_title: string | null;
  state: SignCeremonyState;
  summary_text: string | null;
  risk_flags_json: string | null;
  signed_pdf_path: string | null;
  failure_reason: string | null;
  failure_screenshot_path: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function rowToCeremony(r: Row): SignCeremony {
  return {
    id: r.id,
    emailId: r.email_id,
    vendor: r.vendor,
    signUrl: r.sign_url,
    docTitle: r.doc_title,
    state: r.state,
    summaryText: r.summary_text,
    riskFlags: r.risk_flags_json ? (JSON.parse(r.risk_flags_json) as RiskFlag[]) : [],
    signedPdfPath: r.signed_pdf_path,
    failureReason: r.failure_reason,
    failureScreenshotPath: r.failure_screenshot_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export function createCeremony(db: Database.Database, input: CreateCeremonyInput): SignCeremony {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, doc_title, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'detected', ?, ?)`,
  ).run(input.id, input.emailId, input.vendor, input.signUrl, input.docTitle ?? null, now, now);
  return getCeremony(db, input.id)!;
}

export function getCeremony(db: Database.Database, id: string): SignCeremony | null {
  const row = db.prepare('SELECT * FROM sign_ceremonies WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToCeremony(row) : null;
}

export function listByEmail(db: Database.Database, emailId: string): SignCeremony[] {
  const rows = db
    .prepare('SELECT * FROM sign_ceremonies WHERE email_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(emailId) as Row[];
  return rows.map(rowToCeremony);
}

/**
 * Attempt to transition from `from` → `to`. Returns true if the row was
 * updated (i.e. current state matched `from`), false otherwise. Does NOT
 * throw on state mismatch — that's idempotent no-op (replay protection).
 * DOES throw if the transition violates a CHECK constraint (e.g. signed
 * without signed_pdf_path).
 */
export function transitionState(
  db: Database.Database,
  id: string,
  from: SignCeremonyState,
  to: SignCeremonyState,
): boolean {
  const now = Date.now();
  const completedAt = TERMINAL_STATES.has(to) ? now : null;
  const result = db
    .prepare(
      `UPDATE sign_ceremonies SET state = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND state = ?`,
    )
    .run(to, now, completedAt, id, from);
  return result.changes > 0;
}

export function updateSummary(
  db: Database.Database,
  id: string,
  summary: string[],
  riskFlags: RiskFlag[],
): void {
  db.prepare(
    `UPDATE sign_ceremonies SET summary_text = ?, risk_flags_json = ?, updated_at = ? WHERE id = ?`,
  ).run(summary.join('\n'), JSON.stringify(riskFlags), Date.now(), id);
}

export function updateSignedPdf(db: Database.Database, id: string, path: string): void {
  db.prepare(
    `UPDATE sign_ceremonies SET signed_pdf_path = ?, updated_at = ? WHERE id = ?`,
  ).run(path, Date.now(), id);
}

/**
 * Atomic: set failure_reason + failure_screenshot_path AND transition to
 * 'failed' state in one statement (CHECK invariant needs both set
 * together with completed_at).
 */
export function updateFailure(
  db: Database.Database,
  id: string,
  reason: string,
  screenshotPath: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE sign_ceremonies SET
      state = 'failed',
      failure_reason = ?,
      failure_screenshot_path = ?,
      updated_at = ?,
      completed_at = ?
     WHERE id = ? AND state NOT IN ('signed','failed','cancelled')`,
  ).run(reason, screenshotPath, now, now, id);
}
