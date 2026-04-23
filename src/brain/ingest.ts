/**
 * Brain ingestion — P0 capture only (v2 §12).
 *
 * Subscribes to `email.received` on the event bus. Writes one row to
 * `raw_events` per inbound email thread. Idempotent on (source_type, source_ref)
 * via UNIQUE — a second event for the same Gmail thread_id is skipped silently.
 *
 * No extraction, no entity resolution, no embedding. Those land in P1/P2.
 * `processed_at` stays NULL so downstream processors can pick these up later.
 */

import type Database from 'better-sqlite3';

import { eventBus } from '../event-bus.js';
import type { EmailReceivedEvent } from '../events.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { AsyncWriteQueue } from './queue.js';
import { newId } from './ulid.js';

interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  payload: Buffer;
  received_at: string;
}

let unsubscribe: (() => void) | null = null;
let queue: AsyncWriteQueue<RawEventRow> | null = null;

function flushRawEvents(db: Database.Database, batch: RawEventRow[]): void {
  // OR IGNORE honors the UNIQUE(source_type, source_ref) constraint without
  // throwing — idempotent re-ingestion of the same Gmail thread is a no-op.
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO raw_events
       (id, source_type, source_ref, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: RawEventRow[]) => {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const result = stmt.run(
        row.id,
        row.source_type,
        row.source_ref,
        row.payload,
        row.received_at,
      );
      if (result.changes > 0) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  });
  const { inserted, skipped } = insertMany(batch);
  if (skipped > 0) {
    logger.debug(
      { inserted, skipped, batchSize: batch.length },
      'raw_events batch flushed (skipped duplicates)',
    );
  } else {
    logger.debug(
      { inserted, batchSize: batch.length },
      'raw_events batch flushed',
    );
  }
}

/**
 * Start the P0 brain ingest listener. Safe to call multiple times — second
 * call is a no-op if already started.
 */
export function startBrainIngest(): void {
  if (unsubscribe) return;

  const db = getBrainDb();
  queue = new AsyncWriteQueue<RawEventRow>(async (batch) => {
    flushRawEvents(db, batch);
  });

  unsubscribe = eventBus.on('email.received', (event: EmailReceivedEvent) => {
    // Capture queue reference atomically — if shutdown races with in-flight
    // dispatch, we avoid calling `.enqueue` on a null target.
    const q = queue;
    if (!q) return;
    const receivedAt = new Date(event.timestamp).toISOString();
    for (const email of event.payload.emails) {
      const threadId = email.thread_id;
      if (!threadId) {
        logger.warn(
          { subject: email.subject },
          'email.received entry missing thread_id — skipping brain capture',
        );
        continue;
      }
      const row: RawEventRow = {
        id: newId(),
        source_type: 'email',
        source_ref: threadId,
        payload: Buffer.from(JSON.stringify(email), 'utf8'),
        received_at: receivedAt,
      };
      q.enqueue(row).catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), threadId },
          'raw_events enqueue failed — dead-lettered',
        );
      });
    }
  });

  logger.info('Brain ingest started (raw_events capture only)');
}

/**
 * Drain the in-flight queue and unsubscribe. Exposed for orderly shutdown
 * and for tests.
 */
export async function stopBrainIngest(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (queue) {
    await queue.shutdown();
    queue = null;
  }
}
