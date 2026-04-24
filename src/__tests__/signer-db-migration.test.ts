import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db.js';

describe('signer DB migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('creates signer_profile table with singleton constraint', () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'signer_profile'")
      .get() as { sql: string };
    expect(row.sql).toContain('CHECK (id = 1)');
    expect(row.sql).toContain('full_name TEXT NOT NULL');
    expect(row.sql).toContain('initials TEXT NOT NULL');
  });

  it('rejects second profile row', () => {
    db.prepare(
      'INSERT INTO signer_profile (id, full_name, initials, created_at, updated_at) VALUES (1, ?, ?, ?, ?)',
    ).run('Alice', 'A', Date.now(), Date.now());
    expect(() =>
      db
        .prepare(
          'INSERT INTO signer_profile (id, full_name, initials, created_at, updated_at) VALUES (2, ?, ?, ?, ?)',
        )
        .run('Bob', 'B', Date.now(), Date.now()),
    ).toThrow(/CHECK constraint failed/);
  });

  it('creates sign_ceremonies with terminal-state invariant', () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'sign_ceremonies'")
      .get() as { sql: string };
    expect(row.sql).toContain('state IN (');
    expect(row.sql).toContain('signed');
    expect(row.sql).toContain('completed_at');
  });

  it('rejects signed state without signed_pdf_path', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 'signed', ?, ?, ?)`,
        )
        .run(
          'c1',
          'e1',
          'docusign',
          'https://docusign.net/x',
          Date.now(),
          Date.now(),
          Date.now(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects failed state without failure_reason', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)`,
        )
        .run(
          'c2',
          'e2',
          'docusign',
          'https://docusign.net/x',
          Date.now(),
          Date.now(),
          Date.now(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects terminal state without completed_at', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, signed_pdf_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'signed', ?, ?, ?)`,
        )
        .run(
          'c3',
          'e3',
          'docusign',
          'https://docusign.net/x',
          '/tmp/x.pdf',
          Date.now(),
          Date.now(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects non-terminal state with completed_at', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 'detected', ?, ?, ?)`,
        )
        .run(
          'c4',
          'e4',
          'docusign',
          'https://docusign.net/x',
          Date.now(),
          Date.now(),
          Date.now(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('unique partial index blocks duplicate active ceremony per email', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'detected', ?, ?)`,
    ).run('c5a', 'email-x', 'docusign', 'https://docusign.net/x', now, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'detected', ?, ?)`,
        )
        .run('c5b', 'email-x', 'docusign', 'https://docusign.net/x', now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('allows new ceremony after previous one failed', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, failure_reason, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?)`,
    ).run(
      'c6a',
      'email-y',
      'docusign',
      'https://docusign.net/y',
      'timeout',
      now,
      now,
      now,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO sign_ceremonies (id, email_id, vendor, sign_url, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'detected', ?, ?)`,
        )
        .run('c6b', 'email-y', 'docusign', 'https://docusign.net/y', now, now),
    ).not.toThrow();
  });
});
