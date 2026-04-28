/**
 * Brain metrics (design §9).
 *
 * Two storage surfaces:
 *   - `cost_log`   — persistent per-operation cost rows (tokens, USD).
 *   - `system_state` — single-row key/value facts (last_reconcile, etc.).
 *
 * Plus one in-memory ring buffer for retrieval latency so `/brainhealth`
 * can surface p50/p95/p99 without writing to disk on every query.
 *
 * All functions are cheap and synchronous SQLite writes. No batching —
 * volume is low (≤ 100 events/day) and the visibility is worth the cost.
 */

import { getBrainDb } from './db.js';
import { newId } from './ulid.js';

// --- Cost logging ----------------------------------------------------------

export type CostProvider = 'openai' | 'anthropic' | 'cohere' | 'local';
export type CostOperation =
  | 'embed'
  | 'extract'
  | 'rerank'
  | 'reflect'
  | 'wiki_summary';

export interface CostEntry {
  provider: CostProvider;
  operation: CostOperation;
  units: number;
  costUsd: number;
  /** Override "now" for determinism in tests. ISO UTC. */
  nowIso?: string;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Record a single cost event. Writes one row to `cost_log`. */
export function logCost(entry: CostEntry): void {
  const db = getBrainDb();
  const nowIso = entry.nowIso ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    dayOf(nowIso),
    entry.provider,
    entry.operation,
    entry.units,
    entry.costUsd,
    nowIso,
  );
}

/** Sum cost in USD for a single YYYY-MM-DD day. */
export function getDailyCostUsd(day: string): number {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE day = ?`,
    )
    .get(day) as { total: number };
  return row.total;
}

/**
 * Sum a day's Anthropic spend across ALL operations (extract, reflect,
 * wiki_summary, …). Use this for global per-day budget gates rather than
 * per-operation checks — a spike in one operation should still pause the
 * others when the global cap is hit.
 *
 * `extract.ts:getTodaysExtractSpend` predates this and only counts
 * `extract`. Both functions live for now to preserve the extract-specific
 * gate semantics; new gates should call this one.
 */
export function getTodaysAnthropicSpend(day: string): number {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log
        WHERE day = ? AND provider = 'anthropic'`,
    )
    .get(day) as { total: number };
  return row.total;
}

/** Rolling daily average cost (USD) across the last N days, exclusive of `today`. */
export function getRollingDailyCostUsd(today: string, days = 7): number {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(DISTINCT day) AS n_days
         FROM cost_log
        WHERE day < ? AND day >= date(?, ?)`,
    )
    .get(today, today, `-${days} days`) as { total: number; n_days: number };
  if (row.n_days === 0) return 0;
  return row.total / days;
}

/** Month-to-date cost. `yearMonth` is 'YYYY-MM'. */
export function getMonthlyCostUsd(yearMonth: string): number {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE day LIKE ?`,
    )
    .get(`${yearMonth}-%`) as { total: number };
  return row.total;
}

// --- system_state key/value ------------------------------------------------

export function setSystemState(
  key: string,
  value: string,
  nowIso?: string,
): void {
  const db = getBrainDb();
  const iso = nowIso ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, iso);
}

export function getSystemState(
  key: string,
): { value: string; updated_at: string } | null {
  const db = getBrainDb();
  const row = db
    .prepare(`SELECT value, updated_at FROM system_state WHERE key = ?`)
    .get(key) as { value: string; updated_at: string } | undefined;
  return row ?? null;
}

// --- 24h rolling counters (stored in system_state) ------------------------

/**
 * Shape stored in `system_state.value` for 24h rolling counters. JSON so
 * we can extend (e.g. per-source breakdowns) without a schema change.
 */
interface RollingCounter {
  count: number;
  /** ISO timestamp of the start of the current 24h window. */
  resetAt: string;
}

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Increment a named rolling 24h counter. If the current window has
 * elapsed, the counter resets to 1 with a fresh `resetAt`. Persists in
 * `system_state` so it survives process restart.
 *
 * Used by the SSE→brain ingest canary: a zero value at /brainhealth or
 * the daily digest means no live email events reached ingestion, even
 * if raw_events has plenty of migrated rows.
 */
export function incrementSystemCounter(
  key: string,
  nowIso?: string,
): RollingCounter {
  const iso = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(iso);
  const existing = getSystemState(key);
  let next: RollingCounter;
  if (!existing) {
    next = { count: 1, resetAt: iso };
  } else {
    let parsed: RollingCounter | null = null;
    try {
      parsed = JSON.parse(existing.value) as RollingCounter;
    } catch {
      parsed = null;
    }
    if (!parsed || nowMs - Date.parse(parsed.resetAt) >= ROLLING_WINDOW_MS) {
      next = { count: 1, resetAt: iso };
    } else {
      next = { count: parsed.count + 1, resetAt: parsed.resetAt };
    }
  }
  setSystemState(key, JSON.stringify(next), iso);
  return next;
}

/**
 * Read a rolling counter. Returns `{count: 0, resetAt: null}` if the
 * window elapsed (a fresh read does NOT write — it just reports the
 * current live value). Used by /brainhealth, the digest, and the alert
 * dispatcher.
 */
export function getSystemCounter(
  key: string,
  nowIso?: string,
): { count: number; resetAt: string | null } {
  const iso = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(iso);
  const row = getSystemState(key);
  if (!row) return { count: 0, resetAt: null };
  let parsed: RollingCounter | null = null;
  try {
    parsed = JSON.parse(row.value) as RollingCounter;
  } catch {
    return { count: 0, resetAt: null };
  }
  if (!parsed || nowMs - Date.parse(parsed.resetAt) >= ROLLING_WINDOW_MS) {
    return { count: 0, resetAt: null };
  }
  return { count: parsed.count, resetAt: parsed.resetAt };
}

/** Key for the SSE→brain ingest canary counter. */
export const EMAILS_SEEN_KEY = 'emails_seen_by_brain_24h';
/** Key for the last observed email.received event (ISO timestamp). */
export const LAST_INGEST_EVENT_KEY = 'last_ingest_event_at';

// --- Retrieval latency ring buffer ----------------------------------------

const LATENCY_BUFFER_SIZE = 1000;
const latencyBuffer: number[] = [];
let latencyHead = 0;

/** Record a single recall() duration in milliseconds. */
export function recordRetrievalLatencyMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (latencyBuffer.length < LATENCY_BUFFER_SIZE) {
    latencyBuffer.push(ms);
  } else {
    latencyBuffer[latencyHead] = ms;
    latencyHead = (latencyHead + 1) % LATENCY_BUFFER_SIZE;
  }
}

/** @internal — for tests. */
export function _resetLatencyBuffer(): void {
  latencyBuffer.length = 0;
  latencyHead = 0;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Snapshot percentiles from the ring buffer. 0 if empty. */
export function getLatencyStats(): LatencyStats {
  if (latencyBuffer.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...latencyBuffer].sort((a, b) => a - b);
  const at = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  };
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  };
}

// --- Entity / KU counters (for the digest + health) ------------------------

export interface BrainCounts {
  kuTotal: number;
  kuLive: number;
  kuSuperseded: number;
  kuNeedsReview: number;
  entityTotal: number;
  rawEventsTotal: number;
  rawEventsUnprocessed: number;
  deadLetterCandidates: number;
}

export function getBrainCounts(): BrainCounts {
  const db = getBrainDb();
  const ku = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN superseded_at IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
              SUM(CASE WHEN needs_review = 1 AND superseded_at IS NULL THEN 1 ELSE 0 END) AS needsReview
         FROM knowledge_units`,
    )
    .get() as {
    total: number;
    live: number | null;
    superseded: number | null;
    needsReview: number | null;
  };
  const ent = db.prepare(`SELECT COUNT(*) AS total FROM entities`).get() as {
    total: number;
  };
  const raw = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS unprocessed,
              SUM(CASE WHEN retry_count >= 3 THEN 1 ELSE 0 END) AS deadLetter
         FROM raw_events`,
    )
    .get() as {
    total: number;
    unprocessed: number | null;
    deadLetter: number | null;
  };
  return {
    kuTotal: ku.total,
    kuLive: ku.live ?? 0,
    kuSuperseded: ku.superseded ?? 0,
    kuNeedsReview: ku.needsReview ?? 0,
    entityTotal: ent.total,
    rawEventsTotal: raw.total,
    rawEventsUnprocessed: raw.unprocessed ?? 0,
    deadLetterCandidates: raw.deadLetter ?? 0,
  };
}
