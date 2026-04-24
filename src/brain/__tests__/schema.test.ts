import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// NOTE: schema.sql is read from `src/brain/schema.sql` via import.meta.url in
// db.ts. Vitest runs in the repo root, so we load it from disk directly here.

const SCHEMA_PATH = path.resolve(__dirname, '..', 'schema.sql');

function openWithSchema(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

describe('brain schema', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-schema-'));
    dbPath = path.join(tmpDir, 'brain.db');
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all expected tables', () => {
    db = openWithSchema(dbPath);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    const required = [
      'entities',
      'entity_aliases',
      'entity_relationships',
      'entity_merge_log',
      'knowledge_units',
      'ku_entities',
      'raw_events',
      'system_state',
      'cost_log',
    ];
    for (const name of required) {
      expect(names).toContain(name);
    }
    // ku_fts virtual table is visible in sqlite_master as well.
    expect(names).toContain('ku_fts');
  });

  it('creates all expected indexes', () => {
    db = openWithSchema(dbPath);
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`,
      )
      .all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    const required = [
      'idx_entity_type',
      'idx_alias_entity',
      'idx_alias_field_value',
      'idx_alias_source',
      'idx_rel_from',
      'idx_rel_to',
      'idx_ku_account',
      'idx_ku_source',
      'idx_ku_topic',
      'idx_ku_superseded',
      'idx_ku_recorded',
      'idx_ku_needs_review',
      'idx_ku_entities_entity',
      'idx_raw_unprocessed',
      'idx_cost_day',
    ];
    for (const idx of required) {
      expect(names.has(idx)).toBe(true);
    }
  });

  it('enforces entity_type CHECK constraint', () => {
    db = openWithSchema(dbPath);
    const stmt = db.prepare(
      `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    // Valid value is accepted.
    expect(() => stmt.run('e1', 'person', 'now', 'now')).not.toThrow();
    // Invalid value throws.
    expect(() => stmt.run('e2', 'robot', 'now', 'now')).toThrow();
  });

  it('enforces knowledge_units.account CHECK constraint', () => {
    db = openWithSchema(dbPath);
    const stmt = db.prepare(
      `INSERT INTO knowledge_units
        (id, text, source_type, account, valid_from, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run('k1', 't', 'email', 'work', 'now', 'now'),
    ).not.toThrow();
    expect(() => stmt.run('k2', 't', 'email', 'other', 'now', 'now')).toThrow();
  });

  it('enforces raw_events UNIQUE(source_type, source_ref)', () => {
    db = openWithSchema(dbPath);
    const stmt = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run('r1', 'email', 'thread-1', Buffer.from('{}'), 'now');
    expect(() =>
      stmt.run('r2', 'email', 'thread-1', Buffer.from('{}'), 'now'),
    ).toThrow(/UNIQUE/);
  });

  it('FTS5 triggers keep ku_fts in sync', () => {
    db = openWithSchema(dbPath);
    db.prepare(
      `INSERT INTO knowledge_units
        (id, text, source_type, account, valid_from, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('k1', 'alpha bravo charlie', 'email', 'work', 'now', 'now');

    const hit = db
      .prepare(`SELECT rowid FROM ku_fts WHERE ku_fts MATCH 'bravo'`)
      .all() as { rowid: number }[];
    expect(hit.length).toBe(1);

    // Update: FTS row tracks the new text.
    db.prepare(`UPDATE knowledge_units SET text = ? WHERE id = ?`).run(
      'delta echo foxtrot',
      'k1',
    );
    const missOld = db
      .prepare(`SELECT rowid FROM ku_fts WHERE ku_fts MATCH 'bravo'`)
      .all();
    expect(missOld.length).toBe(0);
    const hitNew = db
      .prepare(`SELECT rowid FROM ku_fts WHERE ku_fts MATCH 'echo'`)
      .all();
    expect(hitNew.length).toBe(1);

    // Delete: FTS row removed.
    db.prepare(`DELETE FROM knowledge_units WHERE id = ?`).run('k1');
    const empty = db
      .prepare(`SELECT rowid FROM ku_fts WHERE ku_fts MATCH 'echo'`)
      .all();
    expect(empty.length).toBe(0);
  });

  it('schema is idempotent — applying twice does not error', () => {
    db = openWithSchema(dbPath);
    // Re-apply.
    expect(() => db!.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))).not.toThrow();

    // Insert a row, then re-apply once more and verify the row is still there.
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('e-persist', 'person', 'now', 'now');
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const row = db
      .prepare(`SELECT entity_id FROM entities WHERE entity_id = ?`)
      .get('e-persist') as { entity_id: string } | undefined;
    expect(row?.entity_id).toBe('e-persist');
  });

  it('WAL pragma is persistent across reopens', () => {
    db = openWithSchema(dbPath);
    expect(
      (db.pragma('journal_mode', { simple: true }) as string).toLowerCase(),
    ).toBe('wal');
    db.close();
    const reopened = new Database(dbPath);
    expect(
      (
        reopened.pragma('journal_mode', { simple: true }) as string
      ).toLowerCase(),
    ).toBe('wal');
    reopened.close();
    db = null;
  });
});
