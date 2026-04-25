/**
 * Brain miniapp — auto-recall mute routes (v3.1).
 *
 * Covers POST /brain/auto-recall/mutes (add) + /mutes/delete (remove)
 * and the corresponding rendering in /brain/queries (mute button next to
 * agent-auto rows + the "Auto-recall mutes" panel).
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

function seedAgentAutoQuery(db: Database.Database, queryText: string): void {
  db.prepare(
    `INSERT INTO ku_queries (id, query_text, caller, account, scope,
                             result_count, duration_ms, recorded_at)
     VALUES (?, ?, 'agent-auto', NULL, NULL, 0, 5, ?)`,
  ).run(`Q-${Math.random().toString(36).slice(2, 10)}`, queryText, new Date().toISOString());
}

describe('Brain miniapp — auto-recall mutes', () => {
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

  it('POST /brain/auto-recall/mutes inserts a row and 303-redirects', async () => {
    const res = await request(app)
      .post('/brain/auto-recall/mutes')
      .type('form')
      .send({ pattern: 'sentry alerts' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/brain/queries');

    const row = brainDb
      .prepare('SELECT pattern, reason FROM auto_recall_mutes WHERE pattern = ?')
      .get('sentry alerts') as { pattern: string; reason: string | null };
    expect(row.pattern).toBe('sentry alerts');
    expect(row.reason).toBeNull();
  });

  it('POST /brain/auto-recall/mutes is idempotent (INSERT OR REPLACE)', async () => {
    await request(app)
      .post('/brain/auto-recall/mutes')
      .type('form')
      .send({ pattern: 'foo' });
    await request(app)
      .post('/brain/auto-recall/mutes')
      .type('form')
      .send({ pattern: 'foo', reason: 'noisy' });
    const rows = brainDb
      .prepare('SELECT pattern, reason FROM auto_recall_mutes')
      .all() as Array<{ pattern: string; reason: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe('noisy');
  });

  it('POST /brain/auto-recall/mutes rejects empty pattern', async () => {
    const res = await request(app)
      .post('/brain/auto-recall/mutes')
      .type('form')
      .send({ pattern: '   ' });
    expect(res.status).toBe(400);
    const count = brainDb
      .prepare('SELECT COUNT(*) AS n FROM auto_recall_mutes')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('POST /brain/auto-recall/mutes/delete removes the row and 303-redirects', async () => {
    brainDb
      .prepare(
        'INSERT INTO auto_recall_mutes (pattern, reason, created_at) VALUES (?, NULL, ?)',
      )
      .run('drop me', new Date().toISOString());
    const res = await request(app)
      .post('/brain/auto-recall/mutes/delete')
      .type('form')
      .send({ pattern: 'drop me' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/brain/queries');
    const count = brainDb
      .prepare('SELECT COUNT(*) AS n FROM auto_recall_mutes')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('GET /brain/queries renders a mute button on agent-auto rows', async () => {
    seedAgentAutoQuery(brainDb, 'show me sentry alerts for today');
    const res = await request(app).get('/brain/queries');
    expect(res.status).toBe(200);
    expect(res.text).toContain('show me sentry alerts for today');
    expect(res.text).toContain('class="mute-btn"');
    expect(res.text).toContain('action="/brain/auto-recall/mutes"');
  });

  it('GET /brain/queries does NOT show a mute button when the pattern is already muted', async () => {
    const txt = 'show me sentry alerts for today';
    seedAgentAutoQuery(brainDb, txt);
    // Mute the first 40 chars (matches what the button would suggest).
    brainDb
      .prepare(
        'INSERT INTO auto_recall_mutes (pattern, reason, created_at) VALUES (?, NULL, ?)',
      )
      .run(txt.slice(0, 40), new Date().toISOString());

    const res = await request(app).get('/brain/queries');
    expect(res.status).toBe(200);
    // The "Auto-recall mutes" management panel renders the existing mute,
    // so the form action appears once for the unmute button — but the
    // per-row mute button should NOT appear since this exact pattern is
    // already muted.
    const muteAddCount = (
      res.text.match(/action="\/brain\/auto-recall\/mutes"/g) ?? []
    ).length;
    expect(muteAddCount).toBe(0);
    // Sanity: the unmute action IS present.
    expect(res.text).toContain('action="/brain/auto-recall/mutes/delete"');
  });

  it('GET /brain/queries shows the mute management panel even when empty', async () => {
    const res = await request(app).get('/brain/queries');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Auto-recall mutes');
    expect(res.text).toContain('No mutes yet');
  });
});
