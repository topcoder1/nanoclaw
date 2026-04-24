/**
 * "Important" flag on knowledge_units — user feedback from the brain
 * miniapp that boosts a KU in retrieval ranking (see retrieve.ts final
 * score formula).
 *
 * Two stores must stay in sync:
 *   1. `knowledge_units.important` (SQLite, 0/1) — read synchronously by
 *      `loadKuRows` in retrieve.ts for the `important_boost` score term.
 *   2. Qdrant point payload `important: boolean` — reserved for future
 *      Qdrant-side filtering / boosting. Set lazily via setPayload.
 *
 * SQLite writes go through the shared AsyncWriteQueue so they respect the
 * serializer. Qdrant writes are fire-and-forget (logged on error) — the
 * SQLite row is the source of truth for retrieval scoring; Qdrant payload
 * is best-effort.
 */

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { AsyncWriteQueue } from './queue.js';
import { setPayload } from './qdrant.js';

interface ImportantBump {
  kuId: string;
  important: boolean;
}

let queue: AsyncWriteQueue<ImportantBump> | null = null;

function getQueue(): AsyncWriteQueue<ImportantBump> {
  if (queue) return queue;
  const db = getBrainDb();
  queue = new AsyncWriteQueue<ImportantBump>(
    async (batch) => {
      const stmt = db.prepare(
        `UPDATE knowledge_units SET important = ? WHERE id = ?`,
      );
      const txn = db.transaction((bumps: ImportantBump[]) => {
        for (const b of bumps) stmt.run(b.important ? 1 : 0, b.kuId);
      });
      txn(batch);
    },
    { maxBatchSize: 20, maxLatencyMs: 50 },
  );
  return queue;
}

/** @internal — tests only. Drain and clear the singleton queue. */
export async function _shutdownImportantQueue(): Promise<void> {
  if (queue) {
    await queue.shutdown();
    queue = null;
  }
}

/**
 * Mark a KU as important (or not). Idempotent — setting the same value
 * twice is a no-op at the DB level. Writes the SQLite row via the shared
 * AsyncWriteQueue and fires a best-effort Qdrant `setPayload` update.
 *
 * Resolves once the SQLite write has been flushed. Qdrant errors are
 * logged but do not reject — the SQLite column is the source of truth
 * for retrieval scoring.
 */
export async function markImportant(
  kuId: string,
  important: boolean,
): Promise<void> {
  await getQueue().enqueue({ kuId, important });
  try {
    await setPayload(kuId, { important });
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        kuId,
        important,
      },
      'markImportant: Qdrant setPayload failed — SQLite updated, payload skew will reconcile lazily',
    );
  }
}

/**
 * Synchronous read of the `important` flag. Returns `false` for missing
 * KUs so callers never need to null-check.
 */
export function getImportant(kuId: string): boolean {
  const db = getBrainDb();
  const row = db
    .prepare(`SELECT important FROM knowledge_units WHERE id = ?`)
    .get(kuId) as { important: number } | undefined;
  return row?.important === 1;
}
