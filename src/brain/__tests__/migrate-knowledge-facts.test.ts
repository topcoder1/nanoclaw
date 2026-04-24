import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import { migrateKnowledgeFacts } from '../migrate-knowledge-facts.js';

function seedLegacyDb(rows: Array<Partial<{
  text: string;
  domain: string;
  group_id: string;
  source: string;
  created_at: string;
}>>): string {
  const p = path.join(tmpDir, 'messages.db');
  const db = new Database(p);
  db.exec(
    `CREATE VIRTUAL TABLE knowledge_facts USING fts5(
       text, domain, group_id, source, created_at
     );`,
  );
  const stmt = db.prepare(
    `INSERT INTO knowledge_facts (text, domain, group_id, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.text ?? '',
      r.domain ?? '',
      r.group_id ?? '',
      r.source ?? '',
      r.created_at ?? '',
    );
  }
  db.close();
  return p;
}

describe('brain/migrate-knowledge-facts', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-migrate-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a zero report when legacy DB does not exist', () => {
    const report = migrateKnowledgeFacts({ dryRun: true });
    expect(report.legacyRowsTotal).toBe(0);
    expect(report.inserted).toBe(0);
    expect(report.errors).toHaveLength(0);
  });

  it('migrates rows into knowledge_units (non-dry-run)', () => {
    seedLegacyDb([
      {
        text: 'Alice confirmed renewal',
        domain: 'deals',
        group_id: 'group-1',
        source: 'email',
        created_at: '2026-04-01T10:00:00Z',
      },
      {
        text: 'Meeting moved to Thursday',
        domain: 'schedule',
        group_id: 'group-2',
        source: 'manual',
        created_at: '2026-04-02T10:00:00Z',
      },
    ]);

    const report = migrateKnowledgeFacts();
    expect(report.legacyRowsTotal).toBe(2);
    expect(report.inserted).toBe(2);
    expect(report.alreadyMigrated).toBe(0);
    expect(report.errors).toHaveLength(0);

    const db = getBrainDb();
    const rows = db
      .prepare(
        `SELECT text, source_type, source_ref, account, tags, extracted_by,
                json_extract(metadata, '$.legacy_knowledge_fact_rowid') AS rid
           FROM knowledge_units
          ORDER BY rid`,
      )
      .all() as Array<{
      text: string;
      source_type: string;
      source_ref: string | null;
      account: string;
      tags: string | null;
      extracted_by: string;
      rid: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('Alice confirmed renewal');
    expect(rows[0].source_type).toBe('email');
    expect(rows[0].source_ref).toBe('group-1');
    expect(rows[0].account).toBe('work');
    expect(rows[0].tags).toBe(JSON.stringify(['deals']));
    expect(rows[0].extracted_by).toBe('legacy-migration');
  });

  it('is idempotent on re-run (legacy rowid dedup)', () => {
    seedLegacyDb([
      { text: 'first fact', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
    ]);
    const r1 = migrateKnowledgeFacts();
    expect(r1.inserted).toBe(1);

    const r2 = migrateKnowledgeFacts();
    expect(r2.inserted).toBe(0);
    expect(r2.alreadyMigrated).toBe(1);

    const db = getBrainDb();
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_units`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('skips empty rows', () => {
    seedLegacyDb([
      { text: '', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
      { text: '   ', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
      { text: 'real fact', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
    ]);
    const report = migrateKnowledgeFacts();
    expect(report.legacyRowsTotal).toBe(3);
    expect(report.inserted).toBe(1);
    expect(report.legacyRowsSkippedEmpty).toBe(2);
  });

  it('dry-run reports counts without inserting', () => {
    seedLegacyDb([
      { text: 'a', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
      { text: 'b', source: 'manual', created_at: '2026-04-01T10:00:00Z' },
    ]);
    const report = migrateKnowledgeFacts({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.legacyRowsTotal).toBe(2);
    expect(report.inserted).toBe(2);

    const db = getBrainDb();
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_units`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('handles missing knowledge_facts table cleanly', () => {
    const p = path.join(tmpDir, 'messages.db');
    const db = new Database(p);
    db.exec(`CREATE TABLE other (id INTEGER)`);
    db.close();
    const report = migrateKnowledgeFacts();
    expect(report.legacyRowsTotal).toBe(0);
    expect(report.inserted).toBe(0);
  });
});
