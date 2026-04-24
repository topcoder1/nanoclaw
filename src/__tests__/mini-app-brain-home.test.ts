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

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'brain',
  'schema.sql',
);

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
    expect(res.text).not.toMatch(/href="\/brain\/review">[^<]*<span class="count">/);
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
});
