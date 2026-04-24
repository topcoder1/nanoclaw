/**
 * Brain miniapp — /brain/review queue tests.
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

function seedKu(
  db: Database.Database,
  id: string,
  text: string,
  opts: {
    needs_review?: number;
    confidence?: number;
    superseded?: boolean;
    recorded_at?: string;
  } = {},
): void {
  const rec = opts.recorded_at ?? '2026-04-01T00:00:00Z';
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        confidence, needs_review, superseded_at)
     VALUES (?, ?, 'email', ?, 'work', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    text,
    `ref-${id}`,
    rec,
    rec,
    opts.confidence ?? 0.5,
    opts.needs_review ?? 1,
    opts.superseded ? rec : null,
  );
}

describe('Brain miniapp — /brain/review', () => {
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

  it('empty state message when the queue is clean', async () => {
    const res = await request(app).get('/brain/review');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Nothing to review — the brain is tidy');
  });

  it('lists only needs_review=1 AND superseded_at IS NULL rows', async () => {
    seedKu(brainDb, 'K_dirty', 'needs review text', { needs_review: 1 });
    seedKu(brainDb, 'K_clean', 'already reviewed', { needs_review: 0 });
    seedKu(brainDb, 'K_dead', 'superseded dirty', {
      needs_review: 1,
      superseded: true,
    });

    const res = await request(app).get('/brain/review');
    expect(res.text).toContain('needs review text');
    expect(res.text).not.toContain('already reviewed');
    expect(res.text).not.toContain('superseded dirty');
  });

  it('sorts by confidence ASC (lowest-confidence / highest-uncertainty first)', async () => {
    seedKu(brainDb, 'K_high', 'high confidence', { confidence: 0.85 });
    seedKu(brainDb, 'K_low', 'low confidence', { confidence: 0.15 });
    seedKu(brainDb, 'K_mid', 'mid confidence', { confidence: 0.5 });

    const res = await request(app).get('/brain/review');
    const idxLow = res.text.indexOf('low confidence');
    const idxMid = res.text.indexOf('mid confidence');
    const idxHigh = res.text.indexOf('high confidence');
    expect(idxLow).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxHigh);
  });

  it('each row has approve + reject buttons and links to detail', async () => {
    seedKu(brainDb, 'K1', 'some text');
    const res = await request(app).get('/brain/review');
    expect(res.text).toContain('data-ku-id="K1"');
    expect(res.text).toContain('btn-approve');
    expect(res.text).toContain('btn-reject');
    expect(res.text).toContain('href="/brain/ku/K1"');
  });

  it('escapes user-controlled KU text', async () => {
    seedKu(brainDb, 'K_xss', '<img src=x onerror=1>');
    const res = await request(app).get('/brain/review');
    expect(res.text).not.toContain('<img src=x onerror=1>');
    expect(res.text).toContain('&lt;img src=x onerror=1&gt;');
  });
});
