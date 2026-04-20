import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

export interface MuteInput {
  threadId: string;
  account: string;
  reason?: string;
}

export function isThreadMuted(
  db: Database.Database,
  threadId: string,
): boolean {
  try {
    const row = db
      .prepare('SELECT 1 FROM muted_threads WHERE thread_id = ?')
      .get(threadId);
    return !!row;
  } catch (err) {
    // Fail open: a DB blip must not silently drop inbound email.
    logger.error(
      { err, threadId, component: 'mute-filter' },
      'isThreadMuted errored — allowing intake to proceed',
    );
    return false;
  }
}

export function muteThread(
  db: Database.Database,
  input: MuteInput,
): { muted: boolean; cascaded: number } {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO muted_threads (thread_id, account, muted_at, reason)
     VALUES (?, ?, ?, ?)`,
  ).run(input.threadId, input.account, now, input.reason ?? null);

  const res = db
    .prepare(
      `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'mute:retroactive',
             resolved_at = ?
       WHERE thread_id = ? AND state != 'resolved'`,
    )
    .run(now, input.threadId);

  return { muted: true, cascaded: res.changes };
}

export function unmuteThread(
  db: Database.Database,
  threadId: string,
): boolean {
  const res = db
    .prepare('DELETE FROM muted_threads WHERE thread_id = ?')
    .run(threadId);
  return res.changes > 0;
}
