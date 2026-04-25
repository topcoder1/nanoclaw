import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  matchLowValueClassification,
  matchTransactionalHeuristic,
  shouldSkipBrainExtraction,
} from '../transactional-filter.js';

describe('matchTransactionalHeuristic', () => {
  it('flags common no-reply senders', () => {
    expect(
      matchTransactionalHeuristic({ sender: 'no-reply@anthropic.com' }),
    ).toBe('sender_pattern');
    expect(matchTransactionalHeuristic({ sender: 'noreply@stripe.com' })).toBe(
      'sender_pattern',
    );
    expect(
      matchTransactionalHeuristic({ sender: 'do-not-reply@foo.com' }),
    ).toBe('sender_pattern');
  });

  it('flags billing / receipts / notifications senders', () => {
    expect(
      matchTransactionalHeuristic({ sender: 'billing@anthropic.com' }),
    ).toBe('sender_pattern');
    expect(matchTransactionalHeuristic({ sender: 'receipts@foo.com' })).toBe(
      'sender_pattern',
    );
    expect(
      matchTransactionalHeuristic({ sender: 'notifications@github.com' }),
    ).toBe('sender_pattern');
  });

  it('flags receipt / invoice / order-confirmation subjects', () => {
    expect(
      matchTransactionalHeuristic({
        sender: 'cliu@customer.ai',
        subject: 'Your receipt from Anthropic, PBC #2522-6977-2154',
      }),
    ).toBe('subject_pattern');
    expect(
      matchTransactionalHeuristic({
        sender: 'j@example.com',
        subject: 'Invoice #8821 attached',
      }),
    ).toBe('subject_pattern');
    expect(
      matchTransactionalHeuristic({
        sender: 'j@example.com',
        subject: 'Order confirmation: your subscription renewal',
      }),
    ).toBe('subject_pattern');
  });

  it('passes through normal business correspondence', () => {
    expect(
      matchTransactionalHeuristic({
        sender: 'cliu@stellarcyber.ai',
        subject: 'Stellar Cyber + WhoisXML API - Data Licensing Discussion',
      }),
    ).toBeNull();
    expect(
      matchTransactionalHeuristic({
        sender: 'jonathan@example.com',
        subject: 'Re: Attaxon Dev strategy',
      }),
    ).toBeNull();
  });
});

describe('matchLowValueClassification', () => {
  function seedDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        classification TEXT,
        queue TEXT,
        detected_at INTEGER
      );
      CREATE INDEX idx_tt ON tracked_items(thread_id);
    `);
    return db;
  }

  it('returns classification_digest when queue is archive_candidate', () => {
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('x1', 't1', 'digest', 'archive_candidate', 1)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBe('classification_digest');
  });

  it('returns classification_digest when queue is ignore', () => {
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('x1', 't1', 'digest', 'ignore', 1)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBe('classification_digest');
  });

  it('does NOT skip when queue is attention (triage v1.1 regression guard)', () => {
    // Post-Triage-v1.1, ~all rows have classification='digest' as a
    // catch-all default. Reading classification would skip everything;
    // queue='attention' must always extract.
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('x1', 't1', 'digest', 'attention', 1)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBeNull();
  });

  it('does NOT skip when queue is action (triage v1.1 regression guard)', () => {
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('x1', 't1', 'digest', 'action', 1)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBeNull();
  });

  it('does NOT skip when classification=digest but queue is NULL (legacy untagged)', () => {
    // Legacy digest rows that went through the v1.1 migration get
    // queue='archive_candidate' (db.ts:425). A null queue today means
    // the row predates the meaningful classification, so don't skip on it.
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('x1', 't1', 'digest', NULL, 1)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBeNull();
  });

  it('returns null when no row exists (triage not run yet)', () => {
    const db = seedDb();
    expect(matchLowValueClassification(db, 'never-seen')).toBeNull();
  });

  it('picks the most recent tracked_item for the thread', () => {
    const db = seedDb();
    db.prepare(
      `INSERT INTO tracked_items (id, thread_id, classification, queue, detected_at)
       VALUES ('older', 't1', 'digest', 'archive_candidate', 1),
              ('newer', 't1', 'digest', 'attention', 2)`,
    ).run();
    expect(matchLowValueClassification(db, 't1')).toBeNull();
  });
});

describe('shouldSkipBrainExtraction', () => {
  it('heuristic wins even when DB is unavailable', () => {
    expect(
      shouldSkipBrainExtraction(null, {
        thread_id: 't1',
        sender: 'billing@anthropic.com',
        subject: 'Your receipt',
      }),
    ).toBe('sender_pattern');
  });

  it('falls through to classification when heuristic is clean', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, classification TEXT,
        queue TEXT, detected_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO tracked_items VALUES ('x', 't1', 'digest', 'archive_candidate', 1)`,
    ).run();
    expect(
      shouldSkipBrainExtraction(db, {
        thread_id: 't1',
        sender: 'real-person@example.com',
        subject: 'Quick question',
      }),
    ).toBe('classification_digest');
  });

  it('returns null when neither filter matches', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, classification TEXT,
        queue TEXT, detected_at INTEGER
      );
    `);
    expect(
      shouldSkipBrainExtraction(db, {
        thread_id: 't1',
        sender: 'cliu@stellarcyber.ai',
        subject: 'Data Licensing Discussion',
      }),
    ).toBeNull();
  });
});
