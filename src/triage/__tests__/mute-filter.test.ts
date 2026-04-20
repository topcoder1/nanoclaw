import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { isThreadMuted, muteThread, unmuteThread } from '../mute-filter.js';

describe('mute-filter', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        muted_at INTEGER NOT NULL,
        reason TEXT
      );
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT,
        resolution_method TEXT, resolved_at INTEGER
      );
    `);
  });

  it('isThreadMuted returns false for unmuted thread', () => {
    expect(isThreadMuted(db, 'thread-abc')).toBe(false);
  });

  it('muteThread inserts a muted_threads row and cascade-resolves tracked_items', () => {
    db.prepare(
      'INSERT INTO tracked_items (id, thread_id, state) VALUES (?, ?, ?)',
    ).run('i1', 'thread-abc', 'pushed');
    db.prepare(
      'INSERT INTO tracked_items (id, thread_id, state) VALUES (?, ?, ?)',
    ).run('i2', 'thread-abc', 'queued');

    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });

    expect(isThreadMuted(db, 'thread-abc')).toBe(true);
    const rows = db
      .prepare('SELECT id, state, resolution_method FROM tracked_items')
      .all() as Array<{ id: string; state: string; resolution_method: string }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'i1', state: 'resolved', resolution_method: 'mute:retroactive' },
        { id: 'i2', state: 'resolved', resolution_method: 'mute:retroactive' },
      ]),
    );
  });

  it('muteThread is idempotent — second call on same thread is a no-op', () => {
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    const first = db
      .prepare('SELECT muted_at FROM muted_threads WHERE thread_id=?')
      .get('thread-abc') as { muted_at: number };
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    const second = db
      .prepare('SELECT muted_at FROM muted_threads WHERE thread_id=?')
      .get('thread-abc') as { muted_at: number };
    expect(second.muted_at).toBe(first.muted_at);
  });

  it('unmuteThread deletes the row and returns true if it existed', () => {
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    expect(unmuteThread(db, 'thread-abc')).toBe(true);
    expect(isThreadMuted(db, 'thread-abc')).toBe(false);
  });

  it('unmuteThread returns false when no such row', () => {
    expect(unmuteThread(db, 'unknown')).toBe(false);
  });
});
