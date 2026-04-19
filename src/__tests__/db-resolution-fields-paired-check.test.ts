/**
 * DB-layer proof for the `resolution_fields_paired` CHECK constraint on
 * tracked_items.
 *
 * Companion to the app-layer state-machine invariant of the same name
 * (scripts/qa/invariant-predicates.ts). The constraint pushes that
 * invariant down to the storage engine: any write — whether from a
 * triage mutation API, a migration, or a hand-rolled UPDATE — that
 * leaves `resolved_at` and `resolution_method` disagreeing on NULL-ness
 * is rejected with SQLITE_CONSTRAINT_CHECK.
 *
 * If someone ever drops or modifies the constraint, these tests fail
 * loudly rather than silently widening the attack surface for partial
 * writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

const CHECK_ERROR = /CHECK constraint/i;

function insertRaw(overrides: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    id: 'x',
    source: 'gmail',
    source_id: 'sx',
    group_name: 'main',
    state: 'queued',
    title: 't',
    detected_at: Date.now(),
    resolved_at: null,
    resolution_method: null,
  };
  const row = { ...base, ...overrides };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  getDb()
    .prepare(
      `INSERT INTO tracked_items (${cols.join(', ')}) VALUES (${placeholders})`,
    )
    .run(...Object.values(row));
}

describe('tracked_items CHECK constraint: resolution_fields_paired', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('is present in the live schema (sqlite_master)', () => {
    const row = getDb()
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='tracked_items'`,
      )
      .get() as { sql: string };
    expect(row.sql).toMatch(/resolution_fields_paired/);
    expect(row.sql).toMatch(/CHECK/);
  });

  it('rejects INSERT with resolved_at set but resolution_method NULL', () => {
    expect(() =>
      insertRaw({
        id: 'bad-insert-1',
        source_id: 's1',
        state: 'resolved',
        resolved_at: Date.now(),
        resolution_method: null,
      }),
    ).toThrow(CHECK_ERROR);
  });

  it('rejects INSERT with resolution_method set but resolved_at NULL', () => {
    expect(() =>
      insertRaw({
        id: 'bad-insert-2',
        source_id: 's2',
        state: 'resolved',
        resolved_at: null,
        resolution_method: 'manual:button',
      }),
    ).toThrow(CHECK_ERROR);
  });

  it('rejects UPDATE that sets resolved_at while leaving resolution_method NULL', () => {
    insertRaw({ id: 'live-1', source_id: 's3' });
    expect(() =>
      getDb()
        .prepare(`UPDATE tracked_items SET resolved_at = ? WHERE id = 'live-1'`)
        .run(Date.now()),
    ).toThrow(CHECK_ERROR);
  });

  it('rejects UPDATE that sets resolution_method while leaving resolved_at NULL', () => {
    insertRaw({ id: 'live-2', source_id: 's4' });
    expect(() =>
      getDb()
        .prepare(
          `UPDATE tracked_items SET resolution_method = 'manual:button' WHERE id = 'live-2'`,
        )
        .run(),
    ).toThrow(CHECK_ERROR);
  });

  it('rejects UPDATE that nulls one field on an already-resolved row', () => {
    insertRaw({
      id: 'live-3',
      source_id: 's5',
      state: 'resolved',
      resolved_at: Date.now(),
      resolution_method: 'manual:button',
    });
    expect(() =>
      getDb()
        .prepare(`UPDATE tracked_items SET resolved_at = NULL WHERE id = 'live-3'`)
        .run(),
    ).toThrow(CHECK_ERROR);
  });

  it('allows INSERT with both NULL (active row)', () => {
    expect(() =>
      insertRaw({ id: 'ok-active', source_id: 's6' }),
    ).not.toThrow();
  });

  it('allows INSERT with both set (resolved row)', () => {
    expect(() =>
      insertRaw({
        id: 'ok-resolved',
        source_id: 's7',
        state: 'resolved',
        resolved_at: Date.now(),
        resolution_method: 'manual:button',
      }),
    ).not.toThrow();
  });

  it('allows resolve UPDATE when both fields are set together', () => {
    insertRaw({ id: 'ok-transition', source_id: 's8' });
    expect(() =>
      getDb()
        .prepare(
          `UPDATE tracked_items
           SET state = 'resolved', resolved_at = ?, resolution_method = 'manual:button'
           WHERE id = 'ok-transition'`,
        )
        .run(Date.now()),
    ).not.toThrow();
  });
});
