import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGmailDeepLink, enrichCitation } from '../citations.js';

describe('brain/citations', () => {
  describe('buildGmailDeepLink', () => {
    it('uses ?authuser= form when email is known', () => {
      const url = buildGmailDeepLink('jonathan@attaxion.com', 'thread-1');
      expect(url).toBe(
        'https://mail.google.com/mail/u/0/?authuser=jonathan%40attaxion.com#all/thread-1',
      );
    });

    it('falls back to bare /mail/#all/ when no email is known', () => {
      const url = buildGmailDeepLink(null, 'thread-2');
      expect(url).toBe('https://mail.google.com/mail/#all/thread-2');
    });

    it('URL-encodes the thread id to survive special chars', () => {
      const url = buildGmailDeepLink(null, 'thread/with#fragment');
      expect(url).toContain(encodeURIComponent('thread/with#fragment'));
    });
  });

  describe('enrichCitation', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE raw_events (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          payload BLOB NOT NULL,
          received_at TEXT NOT NULL,
          UNIQUE(source_type, source_ref)
        );
      `);
    });

    afterEach(() => {
      db.close();
    });

    function insertEvent(
      ref: string,
      payload: Record<string, unknown>,
      sourceType = 'email',
    ): void {
      db.prepare(
        `INSERT INTO raw_events
           (id, source_type, source_ref, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        `evt-${ref}`,
        sourceType,
        ref,
        JSON.stringify(payload),
        '2026-04-20T10:00:00Z',
      );
    }

    it('returns subject + senderEmail + URL when payload is complete', () => {
      insertEvent('thread-1', {
        subject: 'Q4 renewal — pricing',
        sender: 'alice@acme.co',
        account: 'attaxion',
      });
      const c = enrichCitation(db, 'email', 'thread-1', (a) =>
        a === 'attaxion' ? 'jonathan@attaxion.com' : null,
      );
      expect(c.subject).toBe('Q4 renewal — pricing');
      expect(c.senderEmail).toBe('alice@acme.co');
      expect(c.url).toBe(
        'https://mail.google.com/mail/u/0/?authuser=jonathan%40attaxion.com#all/thread-1',
      );
    });

    it('still returns a bare URL when alias resolves to null', () => {
      insertEvent('thread-2', {
        subject: 'Hi',
        sender: 'a@b.co',
        account: 'unknown',
      });
      const c = enrichCitation(db, 'email', 'thread-2', () => null);
      expect(c.subject).toBe('Hi');
      expect(c.url).toBe('https://mail.google.com/mail/#all/thread-2');
    });

    it('returns nulls when source_ref is missing', () => {
      const c = enrichCitation(db, 'email', null, () => null);
      expect(c).toEqual({ subject: null, senderEmail: null, url: null });
    });

    it('returns nulls for non-email source types (no Gmail link semantics)', () => {
      insertEvent(
        'note-1',
        { subject: 'should be ignored', account: 'whatever' },
        'manual',
      );
      const c = enrichCitation(db, 'manual', 'note-1', () => 'x@y.co');
      expect(c).toEqual({ subject: null, senderEmail: null, url: null });
    });

    it('returns nulls when no raw_events row exists for the ref', () => {
      const c = enrichCitation(db, 'email', 'missing-thread', () => 'x@y.co');
      expect(c).toEqual({ subject: null, senderEmail: null, url: null });
    });

    it('swallows malformed JSON in payload and returns nulls', () => {
      db.prepare(
        `INSERT INTO raw_events
           (id, source_type, source_ref, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'evt-bad',
        'email',
        'thread-bad',
        Buffer.from('not json{', 'utf8'),
        '2026-04-20T10:00:00Z',
      );
      const c = enrichCitation(db, 'email', 'thread-bad', () => null);
      expect(c).toEqual({ subject: null, senderEmail: null, url: null });
    });

    it('treats whitespace-only subject/sender as missing', () => {
      insertEvent('thread-3', {
        subject: '   ',
        sender: '',
        account: 'attaxion',
      });
      const c = enrichCitation(db, 'email', 'thread-3', () => 'x@y.co');
      expect(c.subject).toBeNull();
      expect(c.senderEmail).toBeNull();
      expect(c.url).toContain('#all/thread-3');
    });
  });
});
