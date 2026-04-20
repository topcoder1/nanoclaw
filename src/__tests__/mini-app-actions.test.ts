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
