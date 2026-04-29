import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() { return tmp; },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import { lexOrdered, normalizePhone, findHighConfidenceCandidates, findMediumConfidenceCandidates } from '../auto-merge.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-auto-merge-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates entity_merge_suggestions and entity_merge_suppressions', () => {
    const db = getBrainDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('entity_merge_suggestions','entity_merge_suppressions')`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'entity_merge_suggestions',
      'entity_merge_suppressions',
    ]);
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index'
         AND name='idx_entity_merge_suggestions_status'`,
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_entity_merge_suggestions_status');
  });
});

describe('lexOrdered', () => {
  it('returns smaller-first regardless of input order', () => {
    expect(lexOrdered('b', 'a')).toEqual(['a', 'b']);
    expect(lexOrdered('a', 'b')).toEqual(['a', 'b']);
  });
  it('rejects equal inputs', () => {
    expect(() => lexOrdered('x', 'x')).toThrow(/equal/i);
  });
});

describe('normalizePhone', () => {
  it('strips formatting and returns digits-only with leading +', () => {
    expect(normalizePhone('+1 (626) 348-3472')).toBe('+16263483472');
    expect(normalizePhone('16263483472')).toBe('+16263483472');
    expect(normalizePhone('+16263483472')).toBe('+16263483472');
    expect(normalizePhone('  626-348-3472  ')).toBe('+6263483472');
  });
  it('returns null for empty / non-numeric input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });
});

function seedPerson(db: any, id: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`,
  ).run(id, JSON.stringify({ name }), '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z');
}
function seedAlias(db: any, aliasId: string, entityId: string, field: string, value: string): void {
  db.prepare(
    `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
     VALUES (?, ?, 'test', ?, ?, '2026-04-28T00:00:00Z', 1.0)`,
  ).run(aliasId, entityId, field, value);
}

describe('findHighConfidenceCandidates', () => {
  it('returns a pair when two entities share an email (case-insensitive)', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice W');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'Alice@Example.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'alice@example.com');

    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].entity_id_a).toBe('e-aaa');
    expect(pairs[0].entity_id_b).toBe('e-bbb');
    expect(pairs[0].reason_code).toBe('email_exact');
    expect(pairs[0].fields_matched).toContain('email');
  });

  it('returns a pair when two entities share a normalized phone', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Bob');
    seedPerson(db, 'e-bbb', 'Bob');
    seedAlias(db, 'a1', 'e-aaa', 'phone', '+1 (626) 348-3472');
    seedAlias(db, 'a2', 'e-bbb', 'phone', '16263483472');

    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason_code).toBe('phone_normalized');
  });

  it('returns no pair when entity_type differs', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-p1', 'X');
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('e-c1', 'company', '{"name":"X"}', '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z')`,
    ).run();
    seedAlias(db, 'a1', 'e-p1', 'email', 'x@x.com');
    seedAlias(db, 'a2', 'e-c1', 'email', 'x@x.com');
    expect(findHighConfidenceCandidates(db)).toHaveLength(0);
  });

  it('returns no pair when only one entity has the alias', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-1', 'Y');
    seedPerson(db, 'e-2', 'Z');
    seedAlias(db, 'a1', 'e-1', 'email', 'y@y.com');
    expect(findHighConfidenceCandidates(db)).toHaveLength(0);
  });

  it('deduplicates pairs across multiple matched fields', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');
    seedAlias(db, 'a3', 'e-aaa', 'phone', '+15550001111');
    seedAlias(db, 'a4', 'e-bbb', 'phone', '+15550001111');
    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fields_matched.sort()).toEqual(['email', 'phone']);
  });
});

describe('findMediumConfidenceCandidates', () => {
  it('returns a pair for two entities with the same canonical name', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    const pairs = findMediumConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].entity_id_a).toBe('e-aaa');
    expect(pairs[0].entity_id_b).toBe('e-bbb');
    expect(pairs[0].reason_code).toBe('name_exact');
    expect(pairs[0].evidence.fields_matched).toEqual(['name']);
  });

  it('matches case-insensitively and trims whitespace', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', '  Jonathan ');
    seedPerson(db, 'e-bbb', 'JONATHAN');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(1);
  });

  it('does not match when the name is empty or missing', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', '');
    seedPerson(db, 'e-bbb', '');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('does not match when entity_type differs', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-p1', 'X');
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('e-c1', 'company', '{"name":"X"}', '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z')`,
    ).run();
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('short-circuits when entities have conflicting hard identifiers', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'jon1@x.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'jon2@x.com');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('still matches when only one entity has a hard identifier (no conflict)', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'jon@x.com');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(1);
  });

  it('production-fixture regression: Jonathan × 2 surfaces as medium-conf', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('01KQ8X5WSYDVRM28ZA3PZCVTGH','person',
               '{"name":"Jonathan","signal_phone":"+16263483472"}',
               '2026-04-28T00:00:00Z','2026-04-28T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('01KQ9HHRDY5RYADT03SBQG07D6','person',
               '{"name":"Jonathan","signal_profile_name":"Jonathan"}',
               '2026-04-28T00:00:00Z','2026-04-28T00:00:00Z')`,
    ).run();
    const pairs = findMediumConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason_code).toBe('name_exact');
  });
});
