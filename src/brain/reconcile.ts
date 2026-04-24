/**
 * Qdrant ↔ SQLite consistency reconciliation (design §9).
 *
 * Live KUs in SQLite should have exactly one Qdrant point each (in the active
 * brain collection, under the active model_version). Reconcile finds drift:
 *   - `missing_in_qdrant` — SQLite row with no Qdrant point. Can be fixed by
 *      re-embedding (see `scripts/reembed-all.ts`).
 *   - `orphan_in_qdrant`  — Qdrant point with no matching live SQLite KU.
 *      Safe to delete.
 *
 * Writes the run summary to `system_state` under keys:
 *   last_qdrant_reconcile      (ISO)
 *   last_qdrant_reconcile_stats (JSON of ReconcileReport)
 *
 * The scheduler (registered in `src/index.ts`) wires this to cron.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

import { QDRANT_URL } from '../config.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { BRAIN_COLLECTION, kuPointId } from './qdrant.js';
import { setSystemState } from './metrics.js';

export interface ReconcileReport {
  ranAt: string;
  sqliteLiveCount: number;
  qdrantPointCount: number;
  missingInQdrant: string[]; // KU ids present in SQLite but absent from Qdrant
  orphanInQdrant: string[]; // Qdrant point ids (UUIDv5) with no SQLite match
  driftRatio: number; // |missing|+|orphan| / sqliteLiveCount  (0 if sqlite empty)
  qdrantReachable: boolean;
}

export interface ReconcileOptions {
  /** Tests inject an in-memory client. Defaults to real Qdrant via QDRANT_URL. */
  qdrantClient?: QdrantClient | null;
  /** Override "now" for determinism in tests. */
  nowIso?: string;
}

function getClient(opts: ReconcileOptions): QdrantClient | null {
  if (opts.qdrantClient !== undefined) return opts.qdrantClient;
  if (!QDRANT_URL) return null;
  return new QdrantClient({ url: QDRANT_URL });
}

/**
 * Scan SQLite + Qdrant and return a drift report. Always safe to run.
 * Does not fix anything — caller decides. Writes summary to system_state.
 */
export async function reconcileQdrant(
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const ranAt = opts.nowIso ?? new Date().toISOString();
  const db = getBrainDb();
  const liveRows = db
    .prepare(`SELECT id FROM knowledge_units WHERE superseded_at IS NULL`)
    .all() as { id: string }[];
  const liveIds = new Set(liveRows.map((r) => r.id));
  const sqliteLiveCount = liveIds.size;

  const client = getClient(opts);
  const report: ReconcileReport = {
    ranAt,
    sqliteLiveCount,
    qdrantPointCount: 0,
    missingInQdrant: [],
    orphanInQdrant: [],
    driftRatio: 0,
    qdrantReachable: false,
  };

  if (!client) {
    logger.info('reconcileQdrant: QDRANT_URL not set — skipping Qdrant side');
    report.missingInQdrant = [...liveIds];
    report.driftRatio = sqliteLiveCount === 0 ? 0 : 1;
    setSystemState('last_qdrant_reconcile', ranAt, ranAt);
    setSystemState(
      'last_qdrant_reconcile_stats',
      JSON.stringify(report),
      ranAt,
    );
    return report;
  }

  // Scroll all points in the brain collection. At P2 scale (thousands) this
  // is fine as a single pass; at >100K we'd paginate with the `offset`
  // returned by scroll (tracked by re-eval trigger: working_set_kus > 100K).
  const qdrantKuIds = new Set<string>();
  const qdrantPointIdsByKu = new Map<string, string>();
  try {
    // Use scroll with a generous page size. Loop in case of future growth.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let offset: any = undefined;
    const pageSize = 512;
    // Guard against runaway loops with a generous max of 1M points.
    for (let pages = 0; pages < 2000; pages++) {
      const res = (await client.scroll(BRAIN_COLLECTION, {
        limit: pageSize,
        with_payload: true,
        with_vector: false,
        offset,
      })) as {
        points: Array<{
          id: string | number;
          payload?: Record<string, unknown> | null;
        }>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        next_page_offset?: any;
      };
      for (const p of res.points) {
        const payload = (p.payload ?? {}) as { ku_id?: unknown };
        const kuId = typeof payload.ku_id === 'string' ? payload.ku_id : null;
        if (kuId) {
          qdrantKuIds.add(kuId);
          qdrantPointIdsByKu.set(kuId, String(p.id));
        } else {
          // Payload missing ku_id — orphan under any definition.
          report.orphanInQdrant.push(String(p.id));
        }
      }
      if (!res.next_page_offset) break;
      offset = res.next_page_offset;
    }
    report.qdrantReachable = true;
    report.qdrantPointCount = qdrantKuIds.size + report.orphanInQdrant.length;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'reconcileQdrant: Qdrant scroll failed — report incomplete',
    );
    // Mark unreachable; we still record the run so the weekly digest sees it.
    setSystemState('last_qdrant_reconcile', ranAt, ranAt);
    setSystemState(
      'last_qdrant_reconcile_stats',
      JSON.stringify(report),
      ranAt,
    );
    return report;
  }

  for (const id of liveIds) {
    if (!qdrantKuIds.has(id)) report.missingInQdrant.push(id);
  }
  for (const id of qdrantKuIds) {
    if (!liveIds.has(id)) {
      const pointId = qdrantPointIdsByKu.get(id) ?? kuPointId(id);
      report.orphanInQdrant.push(pointId);
    }
  }

  const totalDrift =
    report.missingInQdrant.length + report.orphanInQdrant.length;
  report.driftRatio = sqliteLiveCount === 0 ? 0 : totalDrift / sqliteLiveCount;

  setSystemState('last_qdrant_reconcile', ranAt, ranAt);
  setSystemState('last_qdrant_reconcile_stats', JSON.stringify(report), ranAt);
  // Also persist under the alert-dispatcher key so the scheduled
  // dispatcher picks up drift without needing in-memory state.
  setSystemState('last_reconcile_report', JSON.stringify(report), ranAt);
  return report;
}

/**
 * Start a simple nightly reconcile loop. Every 24h it runs `reconcileQdrant`
 * and evaluates alerts off the result. Returns a stop function for graceful
 * shutdown. No-op if QDRANT_URL is not set (scheduler still runs but each
 * iteration logs the drift between SQLite and a missing Qdrant).
 */
export function startReconcileSchedule(
  intervalMs: number = 24 * 60 * 60 * 1000,
): () => void {
  const run = async (): Promise<void> => {
    try {
      await reconcileQdrant();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'reconcile schedule tick failed',
      );
    }
  };
  // Don't block startup — kick off the first run immediately but unawaited.
  void run();
  const handle = setInterval(() => {
    void run();
  }, intervalMs);
  return () => clearInterval(handle);
}
