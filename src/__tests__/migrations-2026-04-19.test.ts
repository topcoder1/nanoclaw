import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations } from '../db.js';

describe('2026-04-19 ux expansion migration', () => {
  it('creates muted_threads table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('muted_threads')").all() as Array<{
      name: string;
      pk: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['account', 'muted_at', 'reason', 'thread_id']);
    expect(cols.find((c) => c.name === 'thread_id')?.pk).toBe(1);
  });

  it('creates snoozed_items table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('snoozed_items')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'item_id',
      'original_queue',
      'original_state',
      'snoozed_at',
      'wake_at',
    ]);
  });

  it('creates unsubscribe_log table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('unsubscribe_log')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'attempted_at',
      'error',
      'id',
      'item_id',
      'method',
      'status',
      'url',
    ]);
  });

  it('adds sender_kind and subtype columns to tracked_items', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('tracked_items')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('sender_kind');
    expect(names).toContain('subtype');
  });

  it('allows state=snoozed on tracked_items', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tracked_items (id, source, source_id, group_name, state, title, detected_at)
         VALUES ('t1', 'email', 'gmail:x', 'g', 'snoozed', 'title', ?)`,
        )
        .run(Date.now()),
    ).not.toThrow();
  });

  it('snoozed_items FK cascades on tracked_items delete', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO tracked_items (id, source, source_id, group_name, state, title, detected_at)
       VALUES ('t1', 'email', 'gmail:x', 'g', 'snoozed', 'title', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state) VALUES (?, ?, ?, ?)`,
    ).run('t1', Date.now(), Date.now() + 3600_000, 'pushed');
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM tracked_items WHERE id = ?').run('t1');
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM snoozed_items')
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
