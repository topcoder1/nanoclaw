import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  EMAIL_INTELLIGENCE_ENABLED: false,
  SSE_CONNECTIONS: [],
  SUPERPILOT_API_URL: 'http://localhost:0',
  ASSISTANT_NAME: 'test',
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

import { runMigrations } from '../db.js';
import { processIncomingEmail } from '../email-sse.js';

function seed(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('processIncomingEmail — mute hook + sender/subtype wiring', () => {
  it('skips tracked_items insert and archives Gmail when thread is muted', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
    ).run('muted-thread', 'alice@example.com', Date.now());

    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const gmailOps = { archiveThread };

    const result = await processIncomingEmail({
      db,
      gmailOps,
      event: {
        threadId: 'muted-thread',
        account: 'alice@example.com',
        messageId: 'msg-1',
        subject: 'anything',
        from: 'someone@example.com',
        headers: {},
        body: '',
      },
    });

    expect(result.action).toBe('muted_skip');
    expect(archiveThread).toHaveBeenCalledWith(
      'alice@example.com',
      'muted-thread',
    );
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM tracked_items')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('returns muted_skip without throwing when the Gmail archive call fails', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
    ).run('muted-thread-2', 'alice@example.com', Date.now());

    const archiveThread = vi
      .fn()
      .mockRejectedValue(new Error('gmail blew up'));
    const gmailOps = { archiveThread };

    const result = await processIncomingEmail({
      db,
      gmailOps,
      event: {
        threadId: 'muted-thread-2',
        account: 'alice@example.com',
        subject: 'anything',
        from: 'x@y.com',
        headers: {},
        body: '',
      },
    });

    expect(result.action).toBe('muted_skip');
    expect(archiveThread).toHaveBeenCalled();
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM tracked_items')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('populates sender_kind and subtype on normal intake', async () => {
    const db = seed();
    const archiveThread = vi.fn();
    const gmailOps = { archiveThread };

    const result = await processIncomingEmail({
      db,
      gmailOps,
      event: {
        threadId: 'thread-new',
        account: 'alice@example.com',
        messageId: 'msg-new',
        subject: 'Your Stripe verification code',
        from: 'noreply@stripe.com',
        headers: { 'List-Unsubscribe': '<https://x/unsub>' },
        body: 'Your verification code is 123456',
        gmailCategory: 'CATEGORY_UPDATES',
      },
    });

    expect(result.action).toBe('inserted');
    expect(archiveThread).not.toHaveBeenCalled();

    const row = db
      .prepare('SELECT sender_kind, subtype FROM tracked_items LIMIT 1')
      .get() as
      | { sender_kind: string | null; subtype: string | null }
      | undefined;
    expect(row?.sender_kind).toBe('bot');
    expect(row?.subtype).toBe('transactional');
  });

  it('dedups — second call for the same thread_id does not double-insert', async () => {
    const db = seed();
    const archiveThread = vi.fn();
    const gmailOps = { archiveThread };

    const ev = {
      threadId: 'dedup-thread',
      account: 'alice@example.com',
      subject: 'hello',
      from: 'a@b.com',
      headers: {},
      body: '',
    };

    const first = await processIncomingEmail({ db, gmailOps, event: ev });
    const second = await processIncomingEmail({ db, gmailOps, event: ev });

    expect(first.action).toBe('inserted');
    expect(second.action).toBe('already_tracked');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM tracked_items')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
