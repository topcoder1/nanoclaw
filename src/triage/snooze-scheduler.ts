import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import { logger } from '../logger.js';

export interface SnoozeSchedulerOpts {
  db: Database.Database;
  eventBus: EventBus;
  intervalMs?: number;
}

export function startSnoozeScheduler(opts: SnoozeSchedulerOpts): () => void {
  const interval = opts.intervalMs ?? 60_000;

  function tick(): void {
    const now = Date.now();
    const ready = opts.db
      .prepare(
        `SELECT s.item_id, s.original_state, s.original_queue, ti.title
           FROM snoozed_items s
           LEFT JOIN tracked_items ti ON ti.id = s.item_id
          WHERE s.wake_at <= ?`,
      )
      .all(now) as Array<{
      item_id: string;
      original_state: string;
      original_queue: string | null;
      title: string | null;
    }>;

    for (const row of ready) {
      try {
        const restore = opts.db.prepare(
          `UPDATE tracked_items SET state = ?, queue = ? WHERE id = ?`,
        );
        const remove = opts.db.prepare(
          `DELETE FROM snoozed_items WHERE item_id = ?`,
        );
        opts.db.transaction(() => {
          restore.run(row.original_state, row.original_queue, row.item_id);
          remove.run(row.item_id);
        })();
        opts.eventBus.emit('email.snooze.waked', {
          type: 'email.snooze.waked',
          source: 'snooze-scheduler',
          timestamp: now,
          payload: {
            itemId: row.item_id,
            subject: row.title ?? '(no subject)',
          },
        });
        logger.info(
          { itemId: row.item_id, component: 'snooze-scheduler' },
          'Snooze waked',
        );
      } catch (err) {
        logger.error(
          { err, itemId: row.item_id, component: 'snooze-scheduler' },
          'Snooze wake failed',
        );
      }
    }
  }

  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
}
