/**
 * Brain miniapp — /brain/ku/:id detail page tests.
 *
 * POST feedback endpoints live in their own file (mini-app-brain-feedback).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function seedFullKu(
  db: Database.Database,
  id: string,
  opts: Partial<{
    text: string;
    source_type: string;
    source_ref: string;
    confidence: number;
    needs_review: number;
    important: number;
    superseded_at: string | null;
    extraction_chain: string | null;
    scope: string | null;
    topic_key: string | null;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, confidence,
        valid_from, recorded_at, superseded_at, topic_key, extraction_chain,
        needs_review, important)
     VALUES (?, ?, ?, ?, 'work', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.text ?? 'sample text',
    opts.source_type ?? 'email',
    opts.source_ref ?? `ref-${id}`,
    opts.scope ?? null,
    opts.confidence ?? 0.75,
    '2026-04-01T00:00:00Z',
    '2026-04-01T00:00:00Z',
    opts.superseded_at ?? null,
    opts.topic_key ?? null,
    opts.extraction_chain ?? null,
    opts.needs_review ?? 0,
    opts.important ?? 0,
  );
}

describe('Brain miniapp — /brain/ku/:id', () => {
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

  afterEach(() => {
    // Let the lazily-scheduled access-bump queue flush before the DB
    // closes. maxLatencyMs=50 so a short wait covers us.
    return new Promise((r) => setTimeout(r, 100));
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/brain/ku/nope');
    expect(res.status).toBe(404);
    expect(res.text).toContain('KU not found');
  });

  it('renders header, meta, full text, entity pills, chain links', async () => {
    seedFullKu(brainDb, 'K1', {
      text: 'Acme signed the MSA on Monday.\nPricing tier 3.',
      confidence: 0.88,
      important: 1,
      topic_key: 'deals/acme',
      extraction_chain: JSON.stringify(['KSRC_a', 'KSRC_b']),
    });
    brainDb
      .prepare(
        `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
         VALUES ('E_acme', 'company', ?, ?, ?)`,
      )
      .run(JSON.stringify({ name: 'Acme Corp' }), '2026-04-01', '2026-04-01');
    brainDb
      .prepare(
        `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('K1', 'E_acme', 'subject')`,
      )
      .run();

    const res = await request(app).get('/brain/ku/K1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Acme signed the MSA on Monday.');
    expect(res.text).toContain('Pricing tier 3.');
    expect(res.text).toContain('confidence 0.88');
    expect(res.text).toContain('⭐ important');
    expect(res.text).toContain('deals/acme');
    // entity pill with link
    expect(res.text).toContain('href="/brain/entities/E_acme"');
    expect(res.text).toContain('Acme Corp');
    // extraction chain
    expect(res.text).toContain('href="/brain/ku/KSRC_a"');
    expect(res.text).toContain('href="/brain/ku/KSRC_b"');
  });

  it('shows approve button only for needs_review=1 KUs', async () => {
    seedFullKu(brainDb, 'K_clean', { needs_review: 0 });
    seedFullKu(brainDb, 'K_dirty', { needs_review: 1 });

    const clean = await request(app).get('/brain/ku/K_clean');
    const dirty = await request(app).get('/brain/ku/K_dirty');
    // The approve <button> markup is only emitted when needs_review=1.
    expect(clean.text).not.toContain('id="btn-approve"');
    expect(dirty.text).toContain('id="btn-approve"');
    // The "needs_review" status pill also only appears on the dirty one.
    expect(clean.text).not.toContain('>needs_review<');
    expect(dirty.text).toContain('>needs_review<');
  });

  it('reject button is disabled when KU already superseded', async () => {
    seedFullKu(brainDb, 'K_dead', { superseded_at: '2026-04-10' });
    const res = await request(app).get('/brain/ku/K_dead');
    expect(res.text).toMatch(/id="btn-reject"[^>]*disabled/);
    expect(res.text).toContain('Rejected');
  });

  it('escapes user-controlled KU text', async () => {
    seedFullKu(brainDb, 'K_xss', { text: '<script>alert(1)</script>' });
    const res = await request(app).get('/brain/ku/K_xss');
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('bumps access_count + last_accessed_at on view', async () => {
    seedFullKu(brainDb, 'K_seen');
    const before = brainDb
      .prepare(
        `SELECT access_count, last_accessed_at FROM knowledge_units WHERE id = 'K_seen'`,
      )
      .get() as { access_count: number; last_accessed_at: string | null };
    expect(before.access_count).toBe(0);
    expect(before.last_accessed_at).toBeNull();

    await request(app).get('/brain/ku/K_seen');
    // Wait for the write queue to flush (maxLatencyMs = 50).
    await new Promise((r) => setTimeout(r, 120));

    const after = brainDb
      .prepare(
        `SELECT access_count, last_accessed_at FROM knowledge_units WHERE id = 'K_seen'`,
      )
      .get() as { access_count: number; last_accessed_at: string | null };
    expect(after.access_count).toBe(1);
    expect(after.last_accessed_at).not.toBeNull();
  });

  it('email source renders a gmail deep link', async () => {
    seedFullKu(brainDb, 'K_email', {
      source_type: 'email',
      source_ref: 'thread-abcd1234',
    });
    const res = await request(app).get('/brain/ku/K_email');
    expect(res.text).toContain(
      'https://mail.google.com/mail/u/0/#inbox/thread-abcd1234',
    );
  });

  it('non-email source does not render a source deep link', async () => {
    seedFullKu(brainDb, 'K_other', {
      source_type: 'manual',
      source_ref: 'notebook/2026-04-11',
    });
    const res = await request(app).get('/brain/ku/K_other');
    expect(res.text).not.toContain('Open source →');
  });
});
