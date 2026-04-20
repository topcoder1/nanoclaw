import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createMiniAppServer } from '../mini-app/server.js';
import { runMigrations } from '../db.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedItem(
  db: Database.Database,
  id: string,
  threadId: string,
  account: string,
) {
  db.prepare(
    `INSERT INTO tracked_items (id, source, source_id, group_name, state, queue, classification,
      title, thread_id, detected_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'gmail',
    'gmail:' + id,
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

describe('mini-app actions — mute', () => {
  let db: Database.Database;
  let gmailOps: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn(),
      getMessageMeta: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      sendDraft: vi.fn(),
    };
  });

  it('POST /api/email/:id/mute inserts row, cascade-resolves, archives', async () => {
    seedItem(db, 'item-1', 'thread-xyz', 'alice@example.com');
    seedItem(db, 'item-2', 'thread-xyz', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });

    const res = await request(app).post('/api/email/item-1/mute').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const muted = db
      .prepare('SELECT account FROM muted_threads WHERE thread_id=?')
      .get('thread-xyz') as { account: string };
    expect(muted.account).toBe('alice@example.com');
    expect(gmailOps.archiveThread).toHaveBeenCalledWith(
      'alice@example.com',
      'thread-xyz',
    );
    const resolved = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tracked_items WHERE thread_id=? AND state='resolved'",
      )
      .get('thread-xyz') as { n: number };
    expect(resolved.n).toBe(2);
  });

  it('POST /api/email/:id/mute returns 404 when item missing', async () => {
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).post('/api/email/does-not-exist/mute');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('ITEM_NOT_FOUND');
  });

  it('DELETE /api/email/:id/mute removes row', async () => {
    seedItem(db, 'item-1', 'thread-xyz', 'alice@example.com');
    db.prepare(
      `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
    ).run('thread-xyz', 'alice@example.com', Date.now());

    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).delete('/api/email/item-1/mute');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM muted_threads')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('mini-app actions — snooze', () => {
  let db: Database.Database;
  let gmailOps: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn(),
      getMessageMeta: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      sendDraft: vi.fn(),
    };
  });

  it('POST /api/email/:id/snooze with preset duration writes row and updates state', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const now = Date.now();

    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: '1h' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wake_at).toBeGreaterThanOrEqual(now + 3600_000 - 5000);
    expect(res.body.wake_at).toBeLessThanOrEqual(now + 3600_000 + 5000);

    const snooze = db
      .prepare(
        'SELECT wake_at, original_state, original_queue FROM snoozed_items WHERE item_id=?',
      )
      .get('i1') as {
      wake_at: number;
      original_state: string;
      original_queue: string;
    };
    expect(snooze.original_state).toBe('pushed');
    expect(snooze.original_queue).toBe('attention');

    const item = db
      .prepare('SELECT state FROM tracked_items WHERE id=?')
      .get('i1') as { state: string };
    expect(item.state).toBe('snoozed');
  });

  it('POST /api/email/:id/snooze with custom wake_at', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const wakeAt = Date.now() + 4 * 3600_000;

    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: 'custom', wake_at: new Date(wakeAt).toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.wake_at).toBe(wakeAt);
  });

  it('POST /api/email/:id/snooze with invalid duration → 400', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: 'six-years' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  it('POST /api/email/:id/snooze caps at 90 days', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({
        duration: 'custom',
        wake_at: new Date(Date.now() + 100 * 86400_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  it('DELETE /api/email/:id/snooze restores state', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET state=? WHERE id=?').run(
      'snoozed',
      'i1',
    );
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
       VALUES (?,?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 3600_000, 'pushed', 'attention');
    const app = createMiniAppServer({ port: 0, db, gmailOps });

    const res = await request(app).delete('/api/email/i1/snooze');
    expect(res.status).toBe(200);
    const item = db
      .prepare('SELECT state, queue FROM tracked_items WHERE id=?')
      .get('i1') as { state: string; queue: string };
    expect(item.state).toBe('pushed');
    expect(item.queue).toBe('attention');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM snoozed_items')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('mini-app actions — unsubscribe', () => {
  let db: Database.Database;
  let gmailOps: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      sendEmail: vi.fn().mockResolvedValue(undefined),
      getMessageMeta: vi.fn().mockResolvedValue({
        subject: 'test',
        from: 'a',
        to: 'b',
        date: '',
        body: '',
        headers: {
          'List-Unsubscribe': '<https://news.example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
      getMessageBody: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      sendDraft: vi.fn(),
    };
  });

  it('POST /api/email/:id/unsubscribe one-click path', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET source_id=? WHERE id=?').run(
      'gmail:thread-1',
      'i1',
    );
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      fetchImpl: fetchMock as any,
    });

    const res = await request(app).post('/api/email/i1/unsubscribe');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.method).toBe('one-click');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://news.example.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(gmailOps.archiveThread).toHaveBeenCalledWith(
      'alice@example.com',
      'thread-1',
    );
    const log = db
      .prepare('SELECT method, status FROM unsubscribe_log WHERE item_id=?')
      .get('i1') as { method: string; status: number };
    expect(log).toEqual({ method: 'one-click', status: 200 });
  });

  it('POST /api/email/:id/unsubscribe returns NO_UNSUBSCRIBE_HEADER when absent', async () => {
    gmailOps.getMessageMeta = vi.fn().mockResolvedValue({
      subject: '',
      from: '',
      to: '',
      date: '',
      body: '',
      headers: {},
    });
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).post('/api/email/i1/unsubscribe');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_UNSUBSCRIBE_HEADER');
  });
});

describe('mini-app actions — canned reply', () => {
  let db: Database.Database;
  let gmailOps: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn(),
      sendEmail: vi.fn(),
      getMessageBody: vi.fn(),
      getMessageMeta: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      createDraftReply: vi.fn().mockResolvedValue({ draftId: 'd-1' }),
      sendDraft: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('POST /api/email/:id/canned-reply creates draft + schedules send', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET source_id=? WHERE id=?').run(
      'gmail:thread-1',
      'i1',
    );
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/canned-reply')
      .send({ kind: 'thanks' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.draftId).toBe('d-1');
    expect(res.body.sendAt).toBeGreaterThan(Date.now());
    expect(gmailOps.createDraftReply).toHaveBeenCalledWith(
      'alice@example.com',
      expect.objectContaining({
        threadId: 'thread-1',
        body: expect.stringContaining('Thanks!'),
      }),
    );
  });

  it('POST /api/email/:id/canned-reply rejects unknown kind', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/canned-reply')
      .send({ kind: 'shrug' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KIND');
  });
});

describe('mini-app actions — draft-with-ai', () => {
  let db: Database.Database;
  let gmailOps: any;
  let spawnAgentMock: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn(),
      sendEmail: vi.fn(),
      getMessageBody: vi.fn(),
      getMessageMeta: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      createDraftReply: vi.fn(),
      sendDraft: vi.fn(),
    };
    spawnAgentMock = vi.fn().mockResolvedValue({ taskId: 'task-abc' });
  });

  it('POST /api/email/:id/draft-with-ai returns taskId', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app)
      .post('/api/email/i1/draft-with-ai')
      .send({ intent: 'thanks but decline' });
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe('task-abc');
    expect(spawnAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('thanks but decline'),
      }),
    );
  });

  it('POST /api/email/:id/draft-with-ai rejects intent > 500 chars', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app)
      .post('/api/email/i1/draft-with-ai')
      .send({ intent: 'x'.repeat(501) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('INVALID_INTENT');
  });

  it('POST /api/email/:id/draft-with-ai returns 409 when a task is already running', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      spawnAgentTask: spawnAgentMock,
    });
    await request(app).post('/api/email/i1/draft-with-ai').send({});
    const res = await request(app).post('/api/email/i1/draft-with-ai').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TASK_ALREADY_RUNNING');
  });

  it('GET /api/draft-status/:taskId returns status', async () => {
    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app).get('/api/draft-status/unknown-task');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
  });
});
