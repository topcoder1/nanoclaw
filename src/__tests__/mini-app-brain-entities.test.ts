/**
 * Brain miniapp — /brain/entities directory + detail route tests.
 *
 * No retrieval deps; SQLite + templating only.
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

function seedEntity(
  db: Database.Database,
  id: string,
  type: string,
  canonical: Record<string, unknown> | null = null,
  ts = '2026-04-01T00:00:00Z',
): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, type, canonical ? JSON.stringify(canonical) : null, ts, ts);
}

function seedKu(
  db: Database.Database,
  id: string,
  text: string,
  recordedAt = '2026-04-01T00:00:00Z',
  opts: { superseded?: boolean; confidence?: number } = {},
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        confidence, superseded_at)
     VALUES (?, ?, 'email', ?, 'work', ?, ?, ?, ?)`,
  ).run(
    id,
    text,
    `ref-${id}`,
    recordedAt,
    recordedAt,
    opts.confidence ?? 1.0,
    opts.superseded ? recordedAt : null,
  );
}

function link(
  db: Database.Database,
  kuId: string,
  entityId: string,
  role = 'mentioned',
): void {
  db.prepare(
    `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
  ).run(kuId, entityId, role);
}

describe('Brain miniapp — /brain/entities directory', () => {
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

  it('GET /brain/entities renders 200 with all entities', async () => {
    seedEntity(brainDb, 'E_alice', 'person', { name: 'Alice Smith' });
    seedEntity(brainDb, 'E_acme', 'company', { name: 'Acme Corp' });
    const res = await request(app).get('/brain/entities');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice Smith');
    expect(res.text).toContain('Acme Corp');
    expect(res.text).toContain('href="/brain/entities/E_alice"');
    expect(res.text).toContain('href="/brain/entities/E_acme"');
  });

  it('sorts entities by KU count descending', async () => {
    seedEntity(brainDb, 'E_pop', 'person', { name: 'Popular' });
    seedEntity(brainDb, 'E_rare', 'person', { name: 'Rare' });
    seedKu(brainDb, 'K1', 't');
    seedKu(brainDb, 'K2', 't');
    seedKu(brainDb, 'K3', 't');
    link(brainDb, 'K1', 'E_pop');
    link(brainDb, 'K2', 'E_pop');
    link(brainDb, 'K3', 'E_pop');
    link(brainDb, 'K1', 'E_rare');

    const res = await request(app).get('/brain/entities');
    const idxPop = res.text.indexOf('Popular');
    const idxRare = res.text.indexOf('Rare');
    expect(idxPop).toBeGreaterThan(-1);
    expect(idxRare).toBeGreaterThan(-1);
    expect(idxPop).toBeLessThan(idxRare);
    expect(res.text).toContain('3 KUs');
    expect(res.text).toContain('1 KU');
  });

  it('type filter narrows to the requested entity type', async () => {
    seedEntity(brainDb, 'E_alice', 'person', { name: 'Alice' });
    seedEntity(brainDb, 'E_acme', 'company', { name: 'Acme' });

    const res = await request(app).get('/brain/entities?type=company');
    expect(res.text).toContain('Acme');
    expect(res.text).not.toContain('href="/brain/entities/E_alice"');
  });

  it('empty state renders when no entities match', async () => {
    const res = await request(app).get('/brain/entities?type=product');
    expect(res.text).toContain('No entities match this filter yet');
  });

  it('escapes entity canonical names', async () => {
    seedEntity(brainDb, 'E_bad', 'person', { name: '<img src=x onerror=1>' });
    const res = await request(app).get('/brain/entities');
    expect(res.text).not.toContain('<img src=x onerror=1>');
    expect(res.text).toContain('&lt;img src=x onerror=1&gt;');
  });
});

describe('Brain miniapp — /brain/entities/:id detail', () => {
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

  it('returns 404 for a missing entity id', async () => {
    const res = await request(app).get('/brain/entities/nope');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Entity not found');
  });

  it('renders name, type badge, and metadata', async () => {
    seedEntity(
      brainDb,
      'E_alice',
      'person',
      { name: 'Alice Smith' },
      '2026-04-10T12:00:00Z',
    );
    const res = await request(app).get('/brain/entities/E_alice');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice Smith');
    expect(res.text).toContain('person');
    expect(res.text).toContain('E_alice');
    expect(res.text).toContain('2026-04-10T12:00:00Z');
  });

  it('renders aliases section with validity intervals', async () => {
    seedEntity(brainDb, 'E1', 'person', { name: 'A' });
    brainDb
      .prepare(
        `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, valid_until, confidence)
         VALUES
           ('a1', 'E1', 'hubspot', 'email', 'a@old.com', '2024-01-01', '2025-06-01', 0.9),
           ('a2', 'E1', 'hubspot', 'email', 'a@new.com', '2025-06-01', NULL, 0.95)`,
      )
      .run();

    const res = await request(app).get('/brain/entities/E1');
    expect(res.text).toContain('a@old.com');
    expect(res.text).toContain('2025-06-01');
    expect(res.text).toContain('a@new.com');
  });

  it('renders incoming and outgoing relationships', async () => {
    seedEntity(brainDb, 'E1', 'person', { name: 'Alice' });
    seedEntity(brainDb, 'E2', 'company', { name: 'Acme' });
    seedEntity(brainDb, 'E3', 'person', { name: 'Bob' });
    brainDb
      .prepare(
        `INSERT INTO entity_relationships
           (rel_id, from_entity_id, relationship, to_entity_id, valid_from, confidence)
         VALUES
           ('r1', 'E1', 'works_at', 'E2', '2025-01-01', 0.95),
           ('r2', 'E3', 'reports_to', 'E1', '2025-03-01', 0.9)`,
      )
      .run();

    const res = await request(app).get('/brain/entities/E1');
    expect(res.text).toContain('works_at');
    expect(res.text).toContain('href="/brain/entities/E2"');
    expect(res.text).toContain('reports_to');
    expect(res.text).toContain('href="/brain/entities/E3"');
  });

  it('renders timeline of linked KUs in reverse chronological order', async () => {
    seedEntity(brainDb, 'E1', 'person', { name: 'Alice' });
    seedKu(brainDb, 'K_older', 'older ku text', '2025-01-01T00:00:00Z');
    seedKu(brainDb, 'K_newer', 'newer ku text', '2026-04-01T00:00:00Z');
    link(brainDb, 'K_older', 'E1');
    link(brainDb, 'K_newer', 'E1');

    const res = await request(app).get('/brain/entities/E1');
    const idxNewer = res.text.indexOf('newer ku text');
    const idxOlder = res.text.indexOf('older ku text');
    expect(idxNewer).toBeLessThan(idxOlder);
    expect(res.text).toContain('href="/brain/ku/K_older"');
    expect(res.text).toContain('href="/brain/ku/K_newer"');
  });

  it('flags superseded KUs in the timeline', async () => {
    seedEntity(brainDb, 'E1', 'person', { name: 'Alice' });
    seedKu(brainDb, 'K_dead', 'retired fact', '2025-01-01T00:00:00Z', {
      superseded: true,
    });
    link(brainDb, 'K_dead', 'E1');

    const res = await request(app).get('/brain/entities/E1');
    expect(res.text).toContain('retired fact');
    expect(res.text).toContain('superseded');
  });
});
