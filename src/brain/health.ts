/**
 * `/brainhealth` Telegram command + structured health report (design §9).
 *
 * Returns a one-shot snapshot of brain state:
 *   - row counts (KUs live/superseded, entities, raw_events unprocessed,
 *     dead-letter candidates)
 *   - last reconcile run + drift status
 *   - cost: today vs 7-day rolling avg, MTD vs monthly budget
 *   - retrieval latency (p50/p95/p99) from the in-memory ring buffer
 *   - re-evaluation triggers status (design §13) so deferred features
 *     surface the moment their condition is close to firing
 *
 * Shape is kept small and JSON-serializable so it is easy to unit-test.
 */

import {
  getBrainCounts,
  getDailyCostUsd,
  getLatencyStats,
  getMonthlyCostUsd,
  getRollingDailyCostUsd,
  getSystemState,
  type BrainCounts,
  type LatencyStats,
} from './metrics.js';
import {
  getLegacyCutoverAt,
  isLegacyCutoverDue,
} from './drop-legacy-tombstone.js';
import { escapeMarkdown } from './markdown.js';
import {
  COST_SPIKE_MULTIPLIER,
  DRIFT_THRESHOLD,
  MONTHLY_BUDGET_USD,
} from './alerts.js';

export interface ReEvalTriggerStatus {
  /** Design §13 trigger id. */
  id: string;
  description: string;
  /** Current numeric value relevant to the trigger (NaN if not computable). */
  current: number;
  /** Threshold at which re-evaluation is required. */
  threshold: number;
  /** `true` when current crossed the threshold. */
  fired: boolean;
}

export interface BrainHealthReport {
  generatedAt: string;
  counts: BrainCounts;
  cost: {
    todayUsd: number;
    rolling7dAvgUsd: number;
    todayRatioOfAvg: number; // Infinity if avg=0 and today>0; 0 if today=0
    monthToDateUsd: number;
    monthlyBudgetUsd: number;
    monthlyBudgetUtilization: number; // fraction 0..∞
  };
  latency: LatencyStats;
  reconcile: {
    lastRunAt: string | null;
    lastStats: unknown | null;
    driftThreshold: number;
  };
  legacy: {
    cutoverAt: string | null;
    cutoverDue: boolean;
  };
  reEvalTriggers: ReEvalTriggerStatus[];
}

/**
 * Build a structured health report. Cheap enough to call on every
 * `/brainhealth` invocation.
 */
export function getBrainHealthReport(nowIso?: string): BrainHealthReport {
  const iso = nowIso ?? new Date().toISOString();
  const today = iso.slice(0, 10);
  const yearMonth = iso.slice(0, 7);
  const counts = getBrainCounts();
  const todayUsd = getDailyCostUsd(today);
  const rolling = getRollingDailyCostUsd(today, 7);
  const mtd = getMonthlyCostUsd(yearMonth);
  const lastReconcileRow = getSystemState('last_qdrant_reconcile');
  const lastStatsRow = getSystemState('last_qdrant_reconcile_stats');
  let lastStats: unknown | null = null;
  if (lastStatsRow) {
    try {
      lastStats = JSON.parse(lastStatsRow.value);
    } catch {
      lastStats = null;
    }
  }

  const triggers: ReEvalTriggerStatus[] = [
    {
      id: 'splink_entity_count',
      description: 'entities > 10,000 → build Splink dedup',
      current: counts.entityTotal,
      threshold: 10_000,
      fired: counts.entityTotal > 10_000,
    },
    {
      id: 'tier_demotion_working_set',
      description: 'live KUs > 100,000 → build tier demotion',
      current: counts.kuLive,
      threshold: 100_000,
      fired: counts.kuLive > 100_000,
    },
    {
      id: 'monthly_budget',
      description: 'MTD cost > $10 → re-evaluate LLM budget',
      current: mtd,
      threshold: MONTHLY_BUDGET_USD,
      fired: mtd > MONTHLY_BUDGET_USD,
    },
    {
      id: 'legacy_cutover',
      description: 'legacy cutover window elapsed → drop-legacy.ts --confirm',
      current: isLegacyCutoverDue(Date.parse(iso)) ? 1 : 0,
      threshold: 1,
      fired: isLegacyCutoverDue(Date.parse(iso)),
    },
  ];

  return {
    generatedAt: iso,
    counts,
    cost: {
      todayUsd,
      rolling7dAvgUsd: rolling,
      todayRatioOfAvg:
        rolling === 0 ? (todayUsd > 0 ? Number.POSITIVE_INFINITY : 0) : todayUsd / rolling,
      monthToDateUsd: mtd,
      monthlyBudgetUsd: MONTHLY_BUDGET_USD,
      monthlyBudgetUtilization: mtd / MONTHLY_BUDGET_USD,
    },
    latency: getLatencyStats(),
    reconcile: {
      lastRunAt: lastReconcileRow?.value ?? null,
      lastStats,
      driftThreshold: DRIFT_THRESHOLD,
    },
    legacy: {
      cutoverAt: getLegacyCutoverAt(),
      cutoverDue: isLegacyCutoverDue(Date.parse(iso)),
    },
    reEvalTriggers: triggers,
  };
}

// --- Telegram `/brainhealth` handler --------------------------------------

export type BrainHealthFn = typeof getBrainHealthReport;

export interface BrainHealthCommandOptions {
  /** Injected for tests; defaults to the real report. */
  reportFn?: BrainHealthFn;
}

/**
 * Format the health report as Markdown for Telegram. Small enough to fit
 * inside the 4096-char limit even with worst-case numbers.
 */
export function handleBrainHealthCommand(
  opts: BrainHealthCommandOptions = {},
): string {
  const fn = opts.reportFn ?? getBrainHealthReport;
  const r = fn();
  const lines: string[] = [];
  lines.push('🧠 *Brain health*');
  lines.push(
    `\n*Counts:* KU live=${r.counts.kuLive} sup=${r.counts.kuSuperseded} ` +
      `review=${r.counts.kuNeedsReview}  ent=${r.counts.entityTotal}  ` +
      `raw_unproc=${r.counts.rawEventsUnprocessed}  dead=${r.counts.deadLetterCandidates}`,
  );
  const ratio = Number.isFinite(r.cost.todayRatioOfAvg)
    ? r.cost.todayRatioOfAvg.toFixed(2)
    : '∞';
  lines.push(
    `\n*Cost:* today $${r.cost.todayUsd.toFixed(4)} ` +
      `(${ratio}× 7d avg $${r.cost.rolling7dAvgUsd.toFixed(4)})  ` +
      `MTD $${r.cost.monthToDateUsd.toFixed(2)} / $${r.cost.monthlyBudgetUsd}` +
      (r.cost.todayRatioOfAvg > COST_SPIKE_MULTIPLIER ? '  ⚠️ spike' : ''),
  );
  lines.push(
    `\n*Latency (ms):* n=${r.latency.count} p50=${r.latency.p50.toFixed(0)} ` +
      `p95=${r.latency.p95.toFixed(0)} p99=${r.latency.p99.toFixed(0)}`,
  );
  lines.push(
    `\n*Reconcile:* last=${r.reconcile.lastRunAt ?? 'never'} ` +
      `drift_threshold=${(r.reconcile.driftThreshold * 100).toFixed(1)}%`,
  );
  lines.push(
    `\n*Legacy cutover:* at=${r.legacy.cutoverAt ?? '(not set)'} ` +
      `due=${r.legacy.cutoverDue ? 'YES — run scripts/drop-legacy.ts --confirm' : 'no'}`,
  );
  const firing = r.reEvalTriggers.filter((t) => t.fired);
  if (firing.length === 0) {
    lines.push(`\n*Re-eval triggers:* none fired ✅`);
  } else {
    lines.push(`\n*Re-eval triggers fired:* ${firing.length}`);
    for (const t of firing) {
      // description is currently a hardcoded string per trigger, but
      // escape defensively in case a future trigger interpolates user
      // data (e.g. entity names) into it.
      lines.push(`  • \`${t.id}\` — ${escapeMarkdown(t.description)}`);
    }
  }
  return lines.join('\n');
}
