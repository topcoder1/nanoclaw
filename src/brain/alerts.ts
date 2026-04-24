/**
 * Alert dispatcher (design §9 thresholds).
 *
 * Thresholds (all configurable via constants — change requires redeploy):
 *   - provider unreachable > 15 min            → alert 'provider_unreachable'
 *   - cost today > 2× rolling 7-day avg        → alert 'cost_spike'
 *   - Qdrant ↔ SQLite drift > 1%               → alert 'qdrant_drift'
 *   - monthly spend > $10                      → alert 'monthly_budget'
 *   - legacy cutover window elapsed, no        → alert 'legacy_drop_reminder'
 *     reminder in last 7 days
 *   - backup failed in last 24h                → alert 'backup_failed'
 *
 * Alerts are throttled to one per category per hour via `system_state`
 * key `alert:<category>` storing the last-fired ISO timestamp (exception:
 * legacy_drop_reminder uses its own 7-day cadence).
 *
 * The actual notification mechanism (Telegram) is injected — this module
 * only decides whether and when to fire.
 */

import { logger } from '../logger.js';

import { isLegacyCutoverDue } from './drop-legacy-tombstone.js';
import {
  getDailyCostUsd,
  getMonthlyCostUsd,
  getRollingDailyCostUsd,
  getSystemState,
  setSystemState,
} from './metrics.js';
import type { ReconcileReport } from './reconcile.js';

export type AlertCategory =
  | 'provider_unreachable'
  | 'cost_spike'
  | 'qdrant_drift'
  | 'monthly_budget'
  | 'legacy_drop_reminder'
  | 'backup_failed';

export interface Alert {
  category: AlertCategory;
  message: string;
  firedAt: string;
  severity: 'warn' | 'critical';
}

export const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
export const COST_SPIKE_MULTIPLIER = 2;
export const DRIFT_THRESHOLD = 0.01; // 1 %
export const MONTHLY_BUDGET_USD = 10;
export const PROVIDER_DOWN_THRESHOLD_MS = 15 * 60 * 1000;
export const BACKUP_FAILED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const LEGACY_DROP_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// system_state tombstone for the legacy-drop weekly reminder. Stored
// separately from the per-category throttle so the 7-day cadence is
// obvious to anyone grep'ing system_state.
export const LEGACY_DROP_REMINDER_KEY = 'legacy_drop_reminded_at';
export const LAST_BACKUP_FAILED_KEY = 'last_backup_failed_at';

function canFire(category: AlertCategory, nowMs: number): boolean {
  const row = getSystemState(`alert:${category}`);
  if (!row) return true;
  const last = Date.parse(row.value);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= ALERT_THROTTLE_MS;
}

function markFired(category: AlertCategory, nowIso: string): void {
  setSystemState(`alert:${category}`, nowIso, nowIso);
}

export interface EvaluateInput {
  nowIso?: string;
  /** If provided, evaluate drift + reachability from a reconcile report. */
  reconcile?: ReconcileReport | null;
  /** Last time the embedding provider was observed reachable (ISO). */
  lastProviderOkIso?: string | null;
}

/**
 * Pure evaluation: returns the alerts that WOULD be fired right now given
 * the current cost/drift/provider state. Side-effect: marks each fired
 * alert in system_state so it won't fire again within the throttle window.
 *
 * Caller (scheduler) then forwards these to Telegram.
 */
export function evaluateAlerts(input: EvaluateInput = {}): Alert[] {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const today = nowIso.slice(0, 10);
  const yearMonth = nowIso.slice(0, 7);
  const fired: Alert[] = [];

  // --- Cost spike ---
  const todayCost = getDailyCostUsd(today);
  const rollingAvg = getRollingDailyCostUsd(today, 7);
  if (
    rollingAvg > 0 &&
    todayCost > COST_SPIKE_MULTIPLIER * rollingAvg &&
    canFire('cost_spike', nowMs)
  ) {
    fired.push({
      category: 'cost_spike',
      severity: 'warn',
      firedAt: nowIso,
      message: `Today's cost $${todayCost.toFixed(2)} is > ${COST_SPIKE_MULTIPLIER}× rolling 7d avg $${rollingAvg.toFixed(2)}`,
    });
    markFired('cost_spike', nowIso);
  }

  // --- Monthly budget ---
  const monthCost = getMonthlyCostUsd(yearMonth);
  if (monthCost > MONTHLY_BUDGET_USD && canFire('monthly_budget', nowMs)) {
    fired.push({
      category: 'monthly_budget',
      severity: 'warn',
      firedAt: nowIso,
      message: `Month-to-date cost $${monthCost.toFixed(2)} exceeds budget $${MONTHLY_BUDGET_USD}`,
    });
    markFired('monthly_budget', nowIso);
  }

  // --- Qdrant drift ---
  if (
    input.reconcile &&
    input.reconcile.qdrantReachable &&
    input.reconcile.sqliteLiveCount > 0 &&
    input.reconcile.driftRatio > DRIFT_THRESHOLD &&
    canFire('qdrant_drift', nowMs)
  ) {
    const r = input.reconcile;
    fired.push({
      category: 'qdrant_drift',
      severity: 'warn',
      firedAt: nowIso,
      message: `Qdrant drift ${(r.driftRatio * 100).toFixed(2)}% — missing=${r.missingInQdrant.length} orphan=${r.orphanInQdrant.length} live=${r.sqliteLiveCount}`,
    });
    markFired('qdrant_drift', nowIso);
  }

  // --- Provider unreachable ---
  if (input.lastProviderOkIso) {
    const lastOkMs = Date.parse(input.lastProviderOkIso);
    if (
      !Number.isNaN(lastOkMs) &&
      nowMs - lastOkMs > PROVIDER_DOWN_THRESHOLD_MS &&
      canFire('provider_unreachable', nowMs)
    ) {
      fired.push({
        category: 'provider_unreachable',
        severity: 'critical',
        firedAt: nowIso,
        message: `Embedding provider unreachable for > 15 min (last OK ${input.lastProviderOkIso})`,
      });
      markFired('provider_unreachable', nowIso);
    }
  }

  // --- Legacy drop reminder (design §4 Phase C) ---
  // Separate 7-day cadence — not the 1-hour throttle — so the reminder
  // arrives once a week until the operator runs drop-legacy.ts.
  if (isLegacyCutoverDue(nowMs)) {
    const row = getSystemState(LEGACY_DROP_REMINDER_KEY);
    const lastMs = row ? Date.parse(row.value) : NaN;
    const overdue =
      !row || Number.isNaN(lastMs) ||
      nowMs - lastMs >= LEGACY_DROP_REMINDER_INTERVAL_MS;
    if (overdue) {
      fired.push({
        category: 'legacy_drop_reminder',
        severity: 'warn',
        firedAt: nowIso,
        message:
          'Legacy cutover window elapsed — run `scripts/drop-legacy.ts --confirm` to retire messages.db.',
      });
      setSystemState(LEGACY_DROP_REMINDER_KEY, nowIso, nowIso);
    }
  }

  // --- Backup failed (last 24h) ---
  const backupRow = getSystemState(LAST_BACKUP_FAILED_KEY);
  if (backupRow) {
    const failedMs = Date.parse(backupRow.value);
    if (
      !Number.isNaN(failedMs) &&
      nowMs - failedMs <= BACKUP_FAILED_LOOKBACK_MS &&
      canFire('backup_failed', nowMs)
    ) {
      fired.push({
        category: 'backup_failed',
        severity: 'warn',
        firedAt: nowIso,
        message: `Nightly backup failed at ${backupRow.value} — check logs and rerun scripts/brain-p2-smoke.ts:backup step.`,
      });
      markFired('backup_failed', nowIso);
    }
  }

  if (fired.length > 0) {
    logger.warn({ count: fired.length, categories: fired.map((a) => a.category) }, 'brain alerts fired');
  }
  return fired;
}
