/**
 * Alert dispatcher schedule (design §9).
 *
 * `alerts.ts:evaluateAlerts()` is pure: given a snapshot of the brain
 * state, it returns the alerts that should fire right now. It does NOT
 * deliver — that's this module's job.
 *
 * Every `intervalMs` we:
 *   1. Gather context (last reconcile report, provider_last_ok, last
 *      backup-failed timestamp, legacy-cutover due).
 *   2. Call evaluateAlerts(context).
 *   3. For each fired alert, format a Markdown message and call deliver().
 *
 * Throttling lives in evaluateAlerts (one per category per hour via
 * system_state). A re-fire after the window simply returns the alert
 * again on the next tick.
 *
 * The `deliver` callback is injected so index.ts can reuse the same
 * Telegram wrapper that the weekly digest uses.
 */

import { logger } from '../logger.js';

import {
  evaluateAlerts,
  type Alert,
  type EvaluateInput,
} from './alerts.js';
import { getSystemState } from './metrics.js';
import { getProviderLastOkMs, PROVIDER_LAST_OK_KEY } from './provider-probe.js';
import type { ReconcileReport } from './reconcile.js';

export const DEFAULT_ALERT_INTERVAL_MS = 5 * 60 * 1000;
export const LAST_RECONCILE_REPORT_KEY = 'last_reconcile_report';

export type AlertDeliver = (markdown: string) => void | Promise<void>;

export interface AlertSchedulerOptions {
  intervalMs?: number;
  /** Inject a clock for deterministic tests. */
  nowFn?: () => Date;
}

function readReconcileReport(): ReconcileReport | null {
  const row = getSystemState(LAST_RECONCILE_REPORT_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ReconcileReport;
  } catch {
    return null;
  }
}

function readLastProviderOkIso(): string | null {
  const row = getSystemState(PROVIDER_LAST_OK_KEY);
  return row?.value ?? null;
}

function buildContext(nowIso: string): EvaluateInput {
  return {
    nowIso,
    reconcile: readReconcileReport(),
    lastProviderOkIso: readLastProviderOkIso(),
  };
}

function formatAlert(a: Alert): string {
  const icon = a.severity === 'critical' ? '🚨' : '⚠️';
  return `${icon} *Brain alert:* \`${a.category}\`\n${a.message}`;
}

/**
 * Single dispatch cycle — used internally by the schedule and exposed for
 * tests. Returns the alerts that fired this tick.
 */
export async function dispatchAlertsOnce(
  deliver: AlertDeliver,
  nowIso: string = new Date().toISOString(),
): Promise<Alert[]> {
  const fired = evaluateAlerts(buildContext(nowIso));
  for (const a of fired) {
    try {
      await deliver(formatAlert(a));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), category: a.category },
        'alert delivery failed',
      );
    }
  }
  return fired;
}

/**
 * Run the dispatcher on a fixed interval. Returns a stop function.
 * Fires one tick immediately so a just-crossed threshold is noticed
 * without waiting a full `intervalMs`.
 */
export function startAlertsSchedule(
  deliver: AlertDeliver,
  opts: AlertSchedulerOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_ALERT_INTERVAL_MS;
  const nowFn = opts.nowFn ?? (() => new Date());
  const run = (): void => {
    void dispatchAlertsOnce(deliver, nowFn().toISOString());
  };
  run();
  const handle = setInterval(run, intervalMs);
  return () => clearInterval(handle);
}

/** @internal — exported for tests that want to peek at the helpers. */
export { readReconcileReport, readLastProviderOkIso };

// Re-export for callers — keeps the wired-alert surface colocated.
export { getProviderLastOkMs };
