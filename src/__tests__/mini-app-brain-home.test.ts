/**
 * Brain miniapp — skeleton + home page smoke tests.
 *
 * Covers the shared shell (nav links, review badge) that every brain
 * route inherits. Per-route content assertions live in their own files.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';

import { createMiniAppServer } from '../mini-app/server.js';

const SCHEMA_PATH = path.resolve(__dirname, '..', 'brain', 'schema.sql');

function makeBrainDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function makeMessagesDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal schema — createActionsRouter / root route don't hit this
  // during brain tests, but server.ts opens a connection for queue stats.
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

describe('Brain miniapp — skeleton', () => {
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

  it('GET /brain returns 200 HTML', async () => {
    const res = await request(app).get('/brain');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
  });

  it('GET /brain renders the shared nav with all five tabs', async () => {
    const res = await request(app).get('/brain');
    expect(res.text).toContain('🧠 Brain');
    expect(res.text).toContain('href="/brain"');
    expect(res.text).toContain('href="/brain/search"');
    expect(res.text).toContain('href="/brain/entities"');
    expect(res.text).toContain('href="/brain/review"');
    expect(res.text).toContain('href="/brain/timeline"');
  });

  it('GET /brain highlights the Home tab as active', async () => {
    const res = await request(app).get('/brain');
    // Only one nav link should carry the `active` class on the home page.
    expect(res.text).toMatch(/<a href="\/brain" class="active">/);
  });

  it('review badge is hidden when queue is empty', async () => {
    const res = await request(app).get('/brain');
    // The review link should NOT carry a badge count span.
    expect(res.text).not.toMatch(
      /href="\/brain\/review">[^<]*<span class="count">/,
    );
  });

  it('review badge shows the count when queue is non-empty', async () => {
    // Seed two needs_review=1 KUs, one of them already superseded (should
    // NOT be counted).
    brainDb
      .prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, account, valid_from, recorded_at,
            confidence, needs_review, superseded_at)
         VALUES
           ('k1', 't1', 'email', 'work', '2026-04-01', '2026-04-01', 0.5, 1, NULL),
           ('k2', 't2', 'email', 'work', '2026-04-01', '2026-04-01', 0.5, 1, NULL),
           ('k3', 't3', 'email', 'work', '2026-04-01', '2026-04-01', 0.5, 1, '2026-04-02')`,
      )
      .run();

    const res = await request(app).get('/brain');
    expect(res.text).toContain('<span class="count">(2)</span>');
  });

  it('home page renders the search form posting to /brain/search', async () => {
    const res = await request(app).get('/brain');
    expect(res.text).toMatch(
      /<form class="searchbox" action="\/brain\/search" method="get">/,
    );
    expect(res.text).toContain('name="q"');
  });

  it('home page renders stats: KU live, superseded, entities, fresh/migrated, cost', async () => {
    const nowIso = new Date().toISOString();
    brainDb
      .prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, account, valid_from, recorded_at,
            confidence, superseded_at)
         VALUES
           ('a', 't', 'email', 'work', ?, ?, 1.0, NULL),
           ('b', 't', 'email', 'work', ?, ?, 1.0, NULL),
           ('c', 't', 'email', 'work', ?, ?, 1.0, ?)`,
      )
      .run(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);
    brainDb
      .prepare(
        `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
         VALUES ('e1', 'person', ?, ?)`,
      )
      .run(nowIso, nowIso);
    brainDb
      .prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
         VALUES ('r1', 'email', 'thread-1', X'', ?)`,
      )
      .run(nowIso);
    const today = nowIso.slice(0, 10);
    brainDb
      .prepare(
        `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
         VALUES ('c1', ?, 'openai', 'embed', 100, 0.12, ?)`,
      )
      .run(today, nowIso);

    const res = await request(app).get('/brain');
    expect(res.text).toContain('2 KUs live');
    expect(res.text).toContain('1 superseded');
    expect(res.text).toContain('1 entity');
    expect(res.text).toContain('1 fresh (24h)');
    expect(res.text).toContain('0 migrated');
    expect(res.text).toContain('$0.12 MTD');
  });

  it('home page splits raw_events into fresh (email, 24h) vs migrated buckets', async () => {
    const nowIso = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    brainDb
      .prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
         VALUES
           ('f1', 'email', 'thread-fresh-1', X'', ?),
           ('f2', 'email', 'thread-fresh-2', X'', ?),
           ('f_old', 'email', 'thread-old', X'', ?),
           ('m1', 'tracked_item', 'ti-1', X'', ?),
           ('m2', 'commitment', 'co-1', X'', ?),
           ('m3', 'acted_email', 'ae-1', X'', ?),
           ('m4', 'auto_capture', 'ac-1', X'', ?),
           ('m5', 'auto_capture', 'ac-2', X'', ?)`,
      )
      .run(nowIso, nowIso, old, old, old, old, old, old);

    const res = await request(app).get('/brain');
    // 2 fresh email events in the last 24h (the 48h-old email doesn't count).
    expect(res.text).toContain('2 fresh (24h)');
    // 5 migrated rows total regardless of age.
    expect(res.text).toContain('5 migrated');
  });

  it('home page recent-activity section lists raw_events newest first', async () => {
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    brainDb
      .prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
         VALUES ('r_old', 'email', 'thread-OLDER', X'', ?),
                ('r_new', 'gong', 'call-NEWER', X'', ?)`,
      )
      .run(older, newer);

    const res = await request(app).get('/brain');
    const idxNewer = res.text.indexOf('call-NEWER');
    const idxOlder = res.text.indexOf('thread-OLDER');
    expect(idxNewer).toBeGreaterThan(-1);
    expect(idxOlder).toBeGreaterThan(-1);
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('home page escapes user-supplied source_ref', async () => {
    brainDb
      .prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
         VALUES ('x', 'email', ?, X'', ?)`,
      )
      .run('<script>alert(1)</script>', new Date().toISOString());

    const res = await request(app).get('/brain');
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('GET /api/brain/status returns JSON fingerprint', async () => {
    const nowIso = new Date().toISOString();
    brainDb
      .prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, account, valid_from, recorded_at, confidence)
         VALUES ('k1', 't', 'email', 'work', ?, ?, 1.0)`,
      )
      .run(nowIso, nowIso);

    const res = await request(app).get('/api/brain/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('json');
    expect(res.body).toEqual({
      ku: 1,
      entities: 0,
      review: 0,
      recent: [],
    });
  });
});
