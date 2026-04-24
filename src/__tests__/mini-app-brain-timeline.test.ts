/**
 * Brain miniapp — /brain/timeline tests.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMiniAppServer } from '../mini-app/server.js';

const SCHEMA_PATH = path.resolve(__dirname, '..', 'brain', 'schema.sql');

function makeBrainDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function makeMessagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracked_items (
      id TEXT PRIMARY KEY, source TEXT, source_id TEXT, group_name TEXT,
      state TEXT, queue TEXT, title TEXT, thread_id TEXT, detected_at INTEGER,
      metadata TEXT, classification TEXT, sender_kind TEXT, subtype TEXT,
      action_intent TEXT
    );
  `);
  return db;
}

function seedRaw(
  db: Database.Database,
  id: string,
  sourceType: string,
  sourceRef: string,
  receivedAt: string,
  opts: { processed_at?: string | null; process_error?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO raw_events
       (id, source_type, source_ref, payload, received_at, processed_at, process_error)
     VALUES (?, ?, ?, X'', ?, ?, ?)`,
  ).run(
    id,
    sourceType,
    sourceRef,
    receivedAt,
    opts.processed_at ?? null,
    opts.process_error ?? null,
  );
}

function seedKu(
  db: Database.Database,
  id: string,
  text: string,
  sourceRef: string,
  recordedAt = '2026-04-01T00:00:00Z',
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        confidence)
     VALUES (?, ?, 'email', ?, 'work', ?, ?, 0.9)`,
  ).run(id, text, sourceRef, recordedAt, recordedAt);
}

describe('Brain miniapp — /brain/timeline', () => {
  let brainDb: Database.Database;
  let app: ReturnType<typeof createMiniAppServer>;

  beforeEach(() => {
    brainDb = makeBrainDb();
    app = createMiniAppServer({
      port: 0,
      db: makeMessagesDb(),
      brainDb,
    });
  });

  it('empty state when no events', async () => {
    const res = await request(app).get('/brain/timeline');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No events match this filter');
  });

  it('lists raw_events newest first with status pill', async () => {
    seedRaw(
      brainDb,
      'r_older',
      'email',
      'thread-OLDER',
      '2026-04-01T00:00:00Z',
      { processed_at: '2026-04-01T00:00:01Z' },
    );
    seedRaw(brainDb, 'r_newer', 'gong', 'call-NEWER', '2026-04-02T00:00:00Z');
    const res = await request(app).get('/brain/timeline');
    const idxNewer = res.text.indexOf('call-NEWER');
    const idxOlder = res.text.indexOf('thread-OLDER');
    expect(idxNewer).toBeGreaterThan(-1);
    expect(idxOlder).toBeGreaterThan(-1);
    expect(idxNewer).toBeLessThan(idxOlder);
    // Status pills: processed for r_older, pending for r_newer.
    expect(res.text).toContain('>processed<');
    expect(res.text).toContain('>pending<');
  });

  it('correlates KUs to raw events by source_ref with clickable snippets', async () => {
    seedRaw(brainDb, 'r1', 'email', 'thread-A', '2026-04-01T00:00:00Z');
    seedKu(brainDb, 'K_ext_1', 'extracted fact one about Acme', 'thread-A');
    seedKu(brainDb, 'K_ext_2', 'extracted fact two about pricing', 'thread-A');
    const res = await request(app).get('/brain/timeline');
    expect(res.text).toContain('extracted fact one about Acme');
    expect(res.text).toContain('extracted fact two about pricing');
    expect(res.text).toContain('href="/brain/ku/K_ext_1"');
    expect(res.text).toContain('href="/brain/ku/K_ext_2"');
  });

  it('source filter narrows the result set', async () => {
    seedRaw(brainDb, 'r_email', 'email', 'thread-e', '2026-04-01T00:00:00Z');
    seedRaw(brainDb, 'r_gong', 'gong', 'call-g', '2026-04-02T00:00:00Z');
    const res = await request(app).get('/brain/timeline?source=gong');
    expect(res.text).toContain('call-g');
    expect(res.text).not.toContain('thread-e');
  });

  it('pagination works when there are more than 50 events', async () => {
    const stmt = brainDb.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'email', ?, X'', ?)`,
    );
    for (let i = 0; i < 55; i++) {
      const receivedAt = `2026-04-${String(30 - (i % 30)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`;
      stmt.run(`e${i}`, `ref-${i}`, receivedAt);
    }
    const pg1 = await request(app).get('/brain/timeline?page=1');
    const pg2 = await request(app).get('/brain/timeline?page=2');
    expect(pg1.text).toContain('Page 1 of 2');
    expect(pg2.text).toContain('Page 2 of 2');
    // pg1 should contain at least one ref-1..N, pg2 should contain ref-50+
    const pg1Refs = (pg1.text.match(/ref-\d+/g) ?? []).length;
    const pg2Refs = (pg2.text.match(/ref-\d+/g) ?? []).length;
    expect(pg1Refs).toBe(50);
    expect(pg2Refs).toBe(5);
  });

  it('escapes user-supplied source_ref', async () => {
    seedRaw(
      brainDb,
      'r_xss',
      'email',
      '<script>alert(1)</script>',
      '2026-04-01T00:00:00Z',
    );
    const res = await request(app).get('/brain/timeline');
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
