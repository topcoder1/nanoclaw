/**
 * Legacy cutover tombstone (design §4 Phase C).
 *
 * Writes a one-time `system_state.legacy_cutover_at` row on first brain init.
 * 30 days later, the weekly digest / health check surfaces a Telegram
 * reminder that it's time to run `scripts/drop-legacy.ts --confirm`.
 *
 * Idempotent — the row is inserted only if absent. If it already exists we
 * just read it. Re-setting would reset the 30-day clock, which is wrong.
 */

import { getBrainDb } from './db.js';

export const LEGACY_CUTOVER_KEY = 'legacy_cutover_at';
export const LEGACY_CUTOVER_DAYS = 30;

/**
 * Set the cutover timestamp on first call. Safe to call on every brain init.
 * Returns the ISO date that's now stored — either the freshly-inserted one
 * or the pre-existing one.
 */
export function ensureLegacyCutoverTombstone(nowIso?: string): string {
  const db = getBrainDb();
  const existing = db
    .prepare(`SELECT value FROM system_state WHERE key = ?`)
    .get(LEGACY_CUTOVER_KEY) as { value: string } | undefined;
  if (existing) return existing.value;
  const iso = nowIso ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(LEGACY_CUTOVER_KEY, iso, iso);
  return iso;
}

/**
 * `true` once ≥ LEGACY_CUTOVER_DAYS have passed since the tombstone was set.
 * Used by the weekly digest + /brainhealth to trigger the drop-legacy
 * reminder. Returns `false` if the tombstone is missing entirely.
 */
export function isLegacyCutoverDue(nowMs: number = Date.now()): boolean {
  const db = getBrainDb();
  const row = db
    .prepare(`SELECT value FROM system_state WHERE key = ?`)
    .get(LEGACY_CUTOVER_KEY) as { value: string } | undefined;
  if (!row) return false;
  const setAt = Date.parse(row.value);
  if (Number.isNaN(setAt)) return false;
  const elapsedMs = nowMs - setAt;
  return elapsedMs >= LEGACY_CUTOVER_DAYS * 24 * 60 * 60 * 1000;
}

/** @returns stored ISO timestamp, or null if no tombstone present. */
export function getLegacyCutoverAt(): string | null {
  const db = getBrainDb();
  const row = db
    .prepare(`SELECT value FROM system_state WHERE key = ?`)
    .get(LEGACY_CUTOVER_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}
