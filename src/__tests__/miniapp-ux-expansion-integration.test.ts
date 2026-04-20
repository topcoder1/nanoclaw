import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createMiniAppServer } from '../mini-app/server.js';
import { startSnoozeScheduler } from '../triage/snooze-scheduler.js';
import { EventBus } from '../event-bus.js';
import { runMigrations, _initTestDatabase, getDb } from '../db.js';
import { classifyFromSSE } from '../sse-classifier.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedItem(
  db: Database.Database,
  id: string,
  threadId: string,
  account: string,
): void {
  db.prepare(
    `INSERT INTO tracked_items (id, source, source_id, group_name, state, queue, classification,
      title, thread_id, detected_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'gmail',
    'gmail:' + threadId,
    'main',
    'pushed',
    'attention',
    'digest',
    'Test subject',
    threadId,
    Date.now(),
    JSON.stringify({ account }),
  );
}

describe('ux-expansion integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('snooze flow end-to-end: snooze → wake tick → event fires', async () => {
    const db = freshDb();
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on('email.snooze.waked', (e) => events.push(e));

    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps: { archiveThread: vi.fn() } as never,
    });
    const wakeAt = new Date(Date.now() + 3600_000).toISOString();
    const r1 = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: 'custom', wake_at: wakeAt });
    expect(r1.body.ok).toBe(true);

    const stop = startSnoozeScheduler({
      db,
      eventBus: bus,
      intervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(3700_000);
    stop();

    expect(events).toHaveLength(1);
    const row = db
      .prepare('SELECT state FROM tracked_items WHERE id=?')
      .get('i1') as { state: string };
    expect(row.state).toBe('pushed');
  });

  it('mute flow: muted thread is skipped by classifyFromSSE', () => {
    vi.useRealTimers();
    _initTestDatabase();
    const db = getDb();
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    // Item state irrelevant for mute filter; just prove the filter fires.
    db.prepare(
      `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
    ).run('thread-1', 'alice@example.com', Date.now());

    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM tracked_items').get() as {
        n: number;
      }
    ).n;
    const results = classifyFromSSE(
      [
        {
          thread_id: 'thread-1',
          account: 'alice@example.com',
          subject: 'spammy follow-up',
          sender: 'a@x.com',
        },
      ],
      'main',
    );
    expect(results).toEqual([]);
    const after = (
      db.prepare('SELECT COUNT(*) AS n FROM tracked_items').get() as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
  });
});
