import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventBus } from '../../event-bus.js';
import { startSnoozeScheduler } from '../snooze-scheduler.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracked_items (
      id TEXT PRIMARY KEY, state TEXT, queue TEXT, title TEXT
    );
    CREATE TABLE snoozed_items (
      item_id TEXT PRIMARY KEY, snoozed_at INTEGER NOT NULL,
      wake_at INTEGER NOT NULL, original_state TEXT NOT NULL,
      original_queue TEXT
    );
  `);
  return db;
}

describe('snooze-scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tick restores state + emits event when wake_at has passed', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const emitted: any[] = [];
    bus.on('email.snooze.waked', (e) => emitted.push(e));

    db.prepare(
      'INSERT INTO tracked_items (id, state, queue, title) VALUES (?,?,?,?)',
    ).run('i1', 'snoozed', null, 'Payroll');
    const past = Date.now() - 1000;
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
       VALUES (?,?,?,?,?)`,
    ).run('i1', past - 1000, past, 'pushed', 'attention');

    const stop = startSnoozeScheduler({ db, eventBus: bus, intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(60_000);

    const item = db
      .prepare('SELECT state, queue FROM tracked_items WHERE id=?')
      .get('i1') as { state: string; queue: string | null } | undefined;
    expect(item).toEqual({ state: 'pushed', queue: 'attention' });
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM snoozed_items')
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'email.snooze.waked',
      payload: { itemId: 'i1', subject: 'Payroll' },
    });

    stop();
  });

  it('future wake_at is skipped', async () => {
    const db = freshDb();
    const bus = new EventBus();
    db.prepare('INSERT INTO tracked_items (id, state) VALUES (?,?)').run(
      'i1',
      'snoozed',
    );
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state)
       VALUES (?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 3600_000, 'pushed');

    const stop = startSnoozeScheduler({ db, eventBus: bus, intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(60_000);

    const item = db
      .prepare('SELECT state FROM tracked_items WHERE id=?')
      .get('i1') as { state: string };
    expect(item.state).toBe('snoozed');
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM snoozed_items')
      .get() as { n: number };
    expect(remaining.n).toBe(1);

    stop();
  });

  it('stop() halts further ticks', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const emitted: any[] = [];
    bus.on('email.snooze.waked', (e) => emitted.push(e));
    db.prepare('INSERT INTO tracked_items (id, state) VALUES (?,?)').run(
      'i1',
      'snoozed',
    );
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state) VALUES (?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 30_000, 'pushed');

    const stop = startSnoozeScheduler({ db, eventBus: bus, intervalMs: 60000 });
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emitted).toHaveLength(0);
  });
});
