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
import { lexOrdered, normalizePhone } from '../auto-merge.js';

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
