/**
 * Schema-level enforcement of the `no-orphan-ignore-items` invariant.
 *
 * queue='ignore' items are auto-resolved by the classifier — a queued
 * ignore is a bug. The live checker (scripts/qa/invariant-predicates.ts)
 * detects it after the fact; these tests prove the CHECK constraint
 * makes it literally impossible at the schema layer.
 *
 * Matches the enforcement pattern already used for
 * `source-id-unique-among-active` (the UNIQUE INDEX on source+source_id).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

describe('tracked_items CHECK constraint: no orphan ignore', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  function seed(overrides: Record<string, unknown> = {}): () => void {
    const db = getDb();
    const defaults: Record<string, unknown> = {
      id: 'tst-' + Math.random().toString(36).slice(2),
      source: 'gmail',
      source_id: 'src-' + Math.random().toString(36).slice(2),
      group_name: 'test',
      state: 'queued',
      queue: 'attention',
      title: 'test',
      detected_at: Date.now(),
      digest_count: 0,
      resolved_at: null,
      resolution_method: null,
    };
    const row = { ...defaults, ...overrides };
    const stmt = db.prepare(`
      INSERT INTO tracked_items (
        id, source, source_id, group_name, state, queue,
        title, detected_at, digest_count, resolved_at, resolution_method
      ) VALUES (
        @id, @source, @source_id, @group_name, @state, @queue,
        @title, @detected_at, @digest_count, @resolved_at, @resolution_method
      )
    `);
    return () => stmt.run(row);
  }

  it('rejects INSERT with state=queued AND queue=ignore', () => {
    const run = seed({ state: 'queued', queue: 'ignore' });
    expect(() => run()).toThrow(/CHECK constraint/i);
  });

  it('allows state=resolved AND queue=ignore (terminal state, the happy path)', () => {
    const now = Date.now();
    const run = seed({
      state: 'resolved',
      queue: 'ignore',
      resolved_at: now,
      resolution_method: 'classifier:ignore',
    });
    expect(() => run()).not.toThrow();
  });

  it('allows state=queued with queue=attention (normal active row)', () => {
    const run = seed({ state: 'queued', queue: 'attention' });
    expect(() => run()).not.toThrow();
  });

  it('allows state=queued with queue=archive_candidate', () => {
    const run = seed({ state: 'queued', queue: 'archive_candidate' });
    expect(() => run()).not.toThrow();
  });

  it('allows state=queued with queue=NULL (legacy/untagged rows)', () => {
    const run = seed({ state: 'queued', queue: null });
    expect(() => run()).not.toThrow();
  });

  it('rejects UPDATE that would flip an active row into orphan-ignore', () => {
    const db = getDb();
    seed({ id: 'target', state: 'queued', queue: 'attention' })();
    const update = db.prepare(
      `UPDATE tracked_items SET queue='ignore' WHERE id=?`,
    );
    expect(() => update.run('target')).toThrow(/CHECK constraint/i);
  });

  it('rejects UPDATE that would flip a resolved-ignore back to queued', () => {
    const db = getDb();
    const now = Date.now();
    seed({
      id: 'target2',
      state: 'resolved',
      queue: 'ignore',
      resolved_at: now,
      resolution_method: 'classifier:ignore',
    })();
    const update = db.prepare(
      `UPDATE tracked_items SET state='queued', resolved_at=NULL, resolution_method=NULL WHERE id=?`,
    );
    expect(() => update.run('target2')).toThrow(/CHECK constraint/i);
  });
});
