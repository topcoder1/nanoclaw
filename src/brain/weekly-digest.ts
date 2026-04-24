/**
 * Brain digest (design §9 — "Weekly digest includes: cost YTD,
 * ingestion volume, top-retrieved KUs, new entities, any drift alerts.").
 *
 * Composes a Markdown report covering a configurable window. Self-contained
 * — pulls everything from `brain.db`. Never calls out to external services.
 *
 * Triggered by `scripts/brain-weekly-digest.ts` /
 * `scripts/brain-daily-digest.ts` (manual) or `startDigestSchedule(cadence)`
 * (cron: Sunday 09:00 local for weekly, every day 09:00 local for daily).
 *
 * During the 30-day measurement phase we can flip to daily via the
 * `BRAIN_DIGEST_CADENCE=daily` env var (see `src/config.ts`).
 *
 * Sections (in order):
 *   1. Cost       — window / MTD / 7-day avg
 *   2. Ingestion  — raw_events in window, processed ratio
 *   3. Top-retrieved KUs — by access_count bumped in window
 *   4. New entities
 *   5. Drift / alerts — last reconcile report
 *   6. Missed? — unprocessed raw_events older than 24h (warn)
 *   7. Dead-letter candidates (retry_count ≥ 3)
 *   8. Re-eval trigger status
 */

import { getBrainDb } from './db.js';
import { escapeMarkdown } from './markdown.js';
import {
  getBrainCounts,
  getMonthlyCostUsd,
  getRollingDailyCostUsd,
  getSystemState,
} from './metrics.js';
import { getBrainHealthReport } from './health.js';

/** Digest window cadence. Weekly (7d) is the default; daily (24h) is used
 *  during the 30-day measurement phase. */
export type DigestCadence = 'weekly' | 'daily';

export interface WeeklyDigestInput {
  /** End of window (exclusive). Defaults to now. */
  nowIso?: string;
  /** Override window length in days. Defaults to cadence default
   *  (7 for weekly, 1 for daily). */
  windowDays?: number;
  /** Cadence (defaults to 'weekly' for backward compatibility). */
  cadence?: DigestCadence;
}

export interface WeeklyDigestSummary {
  windowStartIso: string;
  windowEndIso: string;
  cadence: DigestCadence;
  costWeekUsd: number;
  costMonthUsd: number;
  rolling7dAvgUsd: number;
  ingestedRawEvents: number;
  processedRawEvents: number;
  topRetrievedKus: Array<{ id: string; text: string; access_count: number }>;
  newEntityCount: number;
  deadLetterCount: number;
  staleUnprocessedCount: number;
  firedTriggers: string[];
  reconcileStats: unknown | null;
}

function windowStart(nowIso: string, days: number): string {
  const t = Date.parse(nowIso) - days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString();
}

function defaultWindowDays(cadence: DigestCadence): number {
  return cadence === 'daily' ? 1 : 7;
}

export function collectWeeklyDigest(
  input: WeeklyDigestInput = {},
): WeeklyDigestSummary {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const cadence: DigestCadence = input.cadence ?? 'weekly';
  const days = input.windowDays ?? defaultWindowDays(cadence);
  const startIso = windowStart(nowIso, days);
  const db = getBrainDb();
  const today = nowIso.slice(0, 10);
  const yearMonth = nowIso.slice(0, 7);

  // Cost for the window: sum rows with day between startIso.slice(0,10) and today
  const costWeek = (
    db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log
          WHERE day >= ? AND day <= ?`,
      )
      .get(startIso.slice(0, 10), today) as { total: number }
  ).total;
  const costMonth = getMonthlyCostUsd(yearMonth);
  const rolling = getRollingDailyCostUsd(today, 7);

  const rawStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN processed_at IS NOT NULL THEN 1 ELSE 0 END) AS processed
         FROM raw_events
        WHERE received_at >= ? AND received_at <= ?`,
    )
    .get(startIso, nowIso) as { total: number; processed: number | null };

  const topKus = db
    .prepare(
      `SELECT id, text, access_count FROM knowledge_units
        WHERE last_accessed_at IS NOT NULL
          AND last_accessed_at >= ?
          AND last_accessed_at <= ?
        ORDER BY access_count DESC
        LIMIT 5`,
    )
    .all(startIso, nowIso) as Array<{
    id: string;
    text: string;
    access_count: number;
  }>;

  const newEntities = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM entities WHERE created_at >= ? AND created_at <= ?`,
      )
      .get(startIso, nowIso) as { n: number }
  ).n;

  const counts = getBrainCounts();
  const staleUnprocessed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM raw_events
          WHERE processed_at IS NULL AND received_at < ?`,
      )
      .get(
        new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString(),
      ) as {
      n: number;
    }
  ).n;

  const reconcileStatsRow = getSystemState('last_qdrant_reconcile_stats');
  let reconcileStats: unknown | null = null;
  if (reconcileStatsRow) {
    try {
      reconcileStats = JSON.parse(reconcileStatsRow.value);
    } catch {
      reconcileStats = null;
    }
  }

  const health = getBrainHealthReport(nowIso);
  const firedTriggers = health.reEvalTriggers
    .filter((t) => t.fired)
    .map((t) => t.id);

  return {
    windowStartIso: startIso,
    windowEndIso: nowIso,
    cadence,
    costWeekUsd: costWeek,
    costMonthUsd: costMonth,
    rolling7dAvgUsd: rolling,
    ingestedRawEvents: rawStats.total,
    processedRawEvents: rawStats.processed ?? 0,
    topRetrievedKus: topKus,
    newEntityCount: newEntities,
    deadLetterCount: counts.deadLetterCandidates,
    staleUnprocessedCount: staleUnprocessed,
    firedTriggers,
    reconcileStats,
  };
}

/**
 * Format the digest as Markdown, suitable for Telegram. Bounded length —
 * caps top-KU previews at 120 chars each so the whole message stays under
 * the Telegram 4096-char ceiling.
 */
export function formatWeeklyDigestMarkdown(
  s: WeeklyDigestSummary = collectWeeklyDigest(),
): string {
  const lines: string[] = [];
  const startDay = s.windowStartIso.slice(0, 10);
  const endDay = s.windowEndIso.slice(0, 10);
  const isDaily = s.cadence === 'daily';
  const title = isDaily ? 'Brain daily digest' : 'Brain weekly digest';
  const windowLabel = isDaily ? 'last 24h' : 'last 7d';
  const costLabel = isDaily ? '24h' : 'week';
  lines.push(`📰 *${title}* — ${startDay} → ${endDay}`);

  lines.push(
    `\n*Cost:* ${costLabel} $${s.costWeekUsd.toFixed(4)}  ` +
      `7d-avg $${s.rolling7dAvgUsd.toFixed(4)}  MTD $${s.costMonthUsd.toFixed(2)}`,
  );

  const ingestPct =
    s.ingestedRawEvents === 0
      ? 100
      : (s.processedRawEvents / s.ingestedRawEvents) * 100;
  lines.push(
    `\n*Ingestion (${windowLabel}):* ${s.ingestedRawEvents} raw events  ` +
      `(${s.processedRawEvents} processed, ${ingestPct.toFixed(1)}%)`,
  );

  if (s.topRetrievedKus.length > 0) {
    lines.push(`\n*Top retrieved KUs (${windowLabel}):*`);
    for (let i = 0; i < s.topRetrievedKus.length; i++) {
      const k = s.topRetrievedKus[i];
      const snippet = k.text.length > 120 ? k.text.slice(0, 119) + '…' : k.text;
      // escape: KU text is user-generated and may contain *, _, `, [
      // that would otherwise break the surrounding Markdown.
      lines.push(`  ${i + 1}. [${k.access_count}×] ${escapeMarkdown(snippet)}`);
    }
  } else {
    const emptyLabel = isDaily
      ? `\n*Top retrieved KUs:* none in last 24h`
      : `\n*Top retrieved KUs:* none this week`;
    lines.push(emptyLabel);
  }

  lines.push(`\n*New entities (${windowLabel}):* ${s.newEntityCount}`);

  if (s.reconcileStats) {
    const st = s.reconcileStats as {
      sqliteLiveCount?: number;
      missingInQdrant?: unknown[];
      orphanInQdrant?: unknown[];
      driftRatio?: number;
      qdrantReachable?: boolean;
    };
    const drift =
      typeof st.driftRatio === 'number'
        ? (st.driftRatio * 100).toFixed(2)
        : '?';
    lines.push(
      `\n*Last reconcile:* live=${st.sqliteLiveCount ?? '?'}  ` +
        `missing=${st.missingInQdrant?.length ?? '?'}  ` +
        `orphan=${st.orphanInQdrant?.length ?? '?'}  drift=${drift}%  ` +
        `reachable=${st.qdrantReachable ? 'yes' : 'no'}`,
    );
  } else {
    lines.push(`\n*Last reconcile:* never`);
  }

  if (s.staleUnprocessedCount > 0) {
    const missedHeader = isDaily
      ? `\n⚠️ *Yesterday's low-access KUs — review?* ${s.staleUnprocessedCount} raw_events still unprocessed after 24h`
      : `\n⚠️ *Missed:* ${s.staleUnprocessedCount} raw_events still unprocessed after 24h`;
    lines.push(missedHeader);
  }
  if (s.deadLetterCount > 0) {
    lines.push(
      `\n⚠️ *Dead-letter:* ${s.deadLetterCount} raw_events hit retry ≥ 3`,
    );
  }

  if (s.firedTriggers.length > 0) {
    lines.push(`\n*Re-eval triggers fired:* ${s.firedTriggers.join(', ')}`);
  } else {
    lines.push(`\n*Re-eval triggers:* none fired ✅`);
  }

  return lines.join('\n');
}

export interface WeeklyDigestScheduleOptions {
  checkIntervalMs?: number;
  /** Inject a clock for deterministic tests. */
  nowFn?: () => Date;
}

/**
 * Start a schedule for the digest. Checks every hour; fires whenever the
 * current time matches the cadence window AND we haven't fired inside the
 * debounce window (tracked in system_state so a restart inside the window
 * still delivers).
 *
 *   - `weekly`: Sunday 09:00–11:59 local, 23h debounce, `last_weekly_digest`.
 *   - `daily` : every day 09:00–11:59 local, 22h debounce, `last_daily_digest`.
 *
 * The on-startup fire (HIGH-1 fix) is preserved: a fresh boot inside the
 * window delivers immediately rather than waiting for the first hourly tick.
 */
export function startDigestSchedule(
  cadence: DigestCadence,
  deliver: (markdown: string) => void | Promise<void>,
  opts: WeeklyDigestScheduleOptions | number = {},
): () => void {
  const options: WeeklyDigestScheduleOptions =
    typeof opts === 'number' ? { checkIntervalMs: opts } : opts;
  const checkIntervalMs = options.checkIntervalMs ?? 60 * 60 * 1000;
  const nowFn = options.nowFn ?? (() => new Date());
  const stateKey =
    cadence === 'daily' ? 'last_daily_digest' : 'last_weekly_digest';
  // Debounce: just under the cadence period so we fire once per cycle even
  // if the check window is 3h wide.
  const debounceMs =
    cadence === 'daily' ? 22 * 60 * 60 * 1000 : 23 * 60 * 60 * 1000;
  const run = (): void => {
    const now = nowFn();
    const inWindow = now.getHours() >= 9 && now.getHours() < 12;
    if (!inWindow) return;
    if (cadence === 'weekly' && now.getDay() !== 0) return;
    const last = getSystemState(stateKey);
    if (last) {
      const lastMs = Date.parse(last.value);
      if (!Number.isNaN(lastMs) && now.getTime() - lastMs < debounceMs) {
        return;
      }
    }
    try {
      const md = formatWeeklyDigestMarkdown(
        collectWeeklyDigest({ cadence, nowIso: now.toISOString() }),
      );
      void Promise.resolve(deliver(md)).catch(() => undefined);
      // Record delivery time via setSystemState.
      const db = getBrainDb();
      const iso = now.toISOString();
      db.prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(stateKey, iso, iso);
    } catch {
      // deliver() or format failure shouldn't stop the scheduler.
    }
  };
  run();
  const handle = setInterval(run, checkIntervalMs);
  return () => clearInterval(handle);
}

/**
 * Backward-compatible wrapper — identical to the pre-cadence API so existing
 * call sites keep working. New code should call `startDigestSchedule(cadence, …)`.
 */
export function startWeeklyDigestSchedule(
  deliver: (markdown: string) => void | Promise<void>,
  opts: WeeklyDigestScheduleOptions | number = {},
): () => void {
  return startDigestSchedule('weekly', deliver, opts);
}
