import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { ArchiveTracker } from '../../archive-tracker.js';
import type { MessageStub, ModifyLabelsInput } from '../../gmail-ops.js';
import { isBlocklisted } from '../junk-reaper-blocklist.js';
import {
  reapOnce,
  startJunkReaper,
  AUTO_ARCHIVED_LABEL,
  ARCHIVE_CANDIDATE_LABEL,
} from '../junk-reaper.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS acted_emails (
      email_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      account TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      acted_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (email_id, action_taken)
    )
  `);
  return db;
}

interface MockGmailOpts {
  listings?: Record<string, MessageStub[]>;
  headers?: Record<string, Record<string, string>>;
  archiveImpl?: (account: string, threadId: string) => Promise<void>;
  modifyImpl?: (
    account: string,
    messageId: string,
    input: ModifyLabelsInput,
  ) => Promise<void>;
  listImpl?: (
    account: string,
    label: string,
    max: number,
  ) => Promise<MessageStub[]>;
  headerImpl?: (
    account: string,
    messageId: string,
    headerNames: string[],
  ) => Promise<Record<string, string>>;
}

function makeGmailOps(accounts: string[], opts: MockGmailOpts = {}) {
  const listings = opts.listings ?? {};
  const headers = opts.headers ?? {};

  return {
    accounts,
    listMessagesByLabel: vi.fn(async (account: string, label: string, max: number) => {
      if (opts.listImpl) return opts.listImpl(account, label, max);
      return listings[account] ?? [];
    }),
    getMessageHeaders: vi.fn(
      async (account: string, messageId: string, headerNames: string[]) => {
        if (opts.headerImpl) return opts.headerImpl(account, messageId, headerNames);
        return headers[messageId] ?? {};
      },
    ),
    archiveThread: vi.fn(async (account: string, threadId: string) => {
      if (opts.archiveImpl) return opts.archiveImpl(account, threadId);
    }),
    modifyMessageLabels: vi.fn(
      async (account: string, messageId: string, input: ModifyLabelsInput) => {
        if (opts.modifyImpl) return opts.modifyImpl(account, messageId, input);
      },
    ),
    sendEmail: vi.fn(async () => {}),
  };
}

describe('junk-reaper', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('one-click unsub → unsub POST, archive, relabel, tracker recorded', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg1', threadId: 'thread1' }] },
      headers: {
        msg1: {
          'List-Unsubscribe': '<https://example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          From: 'news@example.com',
        },
      },
    });

    const fetchMock = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;

    const result = await reapOnce({
      db,
      gmailOps,
      fetch: fetchMock,
    });

    expect(result.reaped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.unsubAttempted).toBe(1);
    expect(result.unsubSucceeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(gmailOps.archiveThread).toHaveBeenCalledWith('personal', 'thread1');
    expect(gmailOps.modifyMessageLabels).toHaveBeenCalledWith('personal', 'msg1', {
      add: [AUTO_ARCHIVED_LABEL],
      remove: [ARCHIVE_CANDIDATE_LABEL, 'INBOX'],
    });

    const tracker = new ArchiveTracker(db);
    const row = tracker.getByEmailId('msg1');
    expect(row).not.toBeNull();
    expect(row!.action_taken).toBe('junk-reaper:one-click:200');
    expect(row!.archived_at).not.toBeNull();
  });

  it('mailto unsub sends email then archives', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg2', threadId: 'thread2' }] },
      headers: {
        msg2: {
          'List-Unsubscribe': '<mailto:unsub@example.com>',
          From: 'news@example.com',
        },
      },
    });

    const result = await reapOnce({ db, gmailOps });

    expect(result.reaped).toBe(1);
    expect(gmailOps.sendEmail).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({ to: 'unsub@example.com' }),
    );
    expect(gmailOps.archiveThread).toHaveBeenCalledWith('personal', 'thread2');

    const tracker = new ArchiveTracker(db);
    const row = tracker.getByEmailId('msg2');
    expect(row!.action_taken).toBe('junk-reaper:mailto:200');
  });

  it('no List-Unsubscribe header → still archives + relabels, unsub not attempted', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg3', threadId: 'thread3' }] },
      headers: { msg3: { From: 'random@example.com' } },
    });
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await reapOnce({ db, gmailOps, fetch: fetchMock });

    expect(result.reaped).toBe(1);
    expect(result.unsubAttempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gmailOps.sendEmail).not.toHaveBeenCalled();
    expect(gmailOps.archiveThread).toHaveBeenCalledWith('personal', 'thread3');

    const tracker = new ArchiveTracker(db);
    const row = tracker.getByEmailId('msg3');
    expect(row!.action_taken).toBe('junk-reaper:none:skipped');
  });

  it('unsub HTTP 500 → still archives + relabels', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg4', threadId: 'thread4' }] },
      headers: {
        msg4: {
          'List-Unsubscribe': '<https://example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          From: 'news@example.com',
        },
      },
    });
    const fetchMock = vi.fn(async () => ({ status: 500 })) as unknown as typeof fetch;

    const result = await reapOnce({ db, gmailOps, fetch: fetchMock });

    expect(result.reaped).toBe(1);
    expect(result.unsubAttempted).toBe(1);
    expect(result.unsubSucceeded).toBe(0);
    expect(gmailOps.archiveThread).toHaveBeenCalled();
    expect(gmailOps.modifyMessageLabels).toHaveBeenCalled();

    const tracker = new ArchiveTracker(db);
    const row = tracker.getByEmailId('msg4');
    expect(row!.action_taken).toBe('junk-reaper:one-click:500');
  });

  it('dry-run mode performs no side effects', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg5', threadId: 'thread5' }] },
      headers: {
        msg5: {
          'List-Unsubscribe': '<https://example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
    });
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await reapOnce({
      db,
      gmailOps,
      fetch: fetchMock,
      dryRun: true,
    });

    expect(result.scanned).toBe(1);
    expect(result.reaped).toBe(0);
    expect(result.unsubAttempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gmailOps.archiveThread).not.toHaveBeenCalled();
    expect(gmailOps.modifyMessageLabels).not.toHaveBeenCalled();

    const tracker = new ArchiveTracker(db);
    expect(tracker.getByEmailId('msg5')).toBeNull();
  });

  it('iterates over every registered account', async () => {
    const gmailOps = makeGmailOps(['personal', 'dev'], {
      listings: {
        personal: [{ id: 'p1', threadId: 'tp1' }],
        dev: [{ id: 'd1', threadId: 'td1' }],
      },
      headers: {
        p1: { From: 'a@example.com' },
        d1: { From: 'b@example.com' },
      },
    });

    const result = await reapOnce({ db, gmailOps });

    expect(result.accounts).toBe(2);
    expect(result.reaped).toBe(2);
    expect(gmailOps.listMessagesByLabel).toHaveBeenCalledWith(
      'personal',
      ARCHIVE_CANDIDATE_LABEL,
      expect.any(Number),
    );
    expect(gmailOps.listMessagesByLabel).toHaveBeenCalledWith(
      'dev',
      ARCHIVE_CANDIDATE_LABEL,
      expect.any(Number),
    );
  });

  it('empty label list still counts as a tick', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [] },
    });

    const result = await reapOnce({ db, gmailOps });

    expect(result.accounts).toBe(1);
    expect(result.scanned).toBe(0);
    expect(result.reaped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('per-call timeout on archiveThread → tick completes, errors++', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msg6', threadId: 'thread6' }] },
      headers: { msg6: { From: 'random@example.com' } },
      archiveImpl: () => new Promise<void>(() => {}),
    });

    const result = await reapOnce({
      db,
      gmailOps,
      perCallTimeoutMs: 20,
    });

    expect(result.errors).toBe(1);
    expect(result.reaped).toBe(0);

    const tracker = new ArchiveTracker(db);
    expect(tracker.getByEmailId('msg6')).toBeNull();
  });

  it('blocklisted From → archive + relabel, unsub NOT called, counter increments', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msgB1', threadId: 'threadB1' }] },
      headers: {
        msgB1: {
          'List-Unsubscribe': '<https://github.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          From: 'GitHub <noreply@github.com>',
        },
      },
    });
    const fetchMock = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;

    const result = await reapOnce({ db, gmailOps, fetch: fetchMock });

    expect(result.reaped).toBe(1);
    expect(result.unsubAttempted).toBe(0);
    expect(result.unsubSucceeded).toBe(0);
    expect(result.unsubSkippedBlocklist).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gmailOps.sendEmail).not.toHaveBeenCalled();
    expect(gmailOps.archiveThread).toHaveBeenCalledWith('personal', 'threadB1');
    expect(gmailOps.modifyMessageLabels).toHaveBeenCalledWith('personal', 'msgB1', {
      add: [AUTO_ARCHIVED_LABEL],
      remove: [ARCHIVE_CANDIDATE_LABEL, 'INBOX'],
    });

    const tracker = new ArchiveTracker(db);
    const row = tracker.getByEmailId('msgB1');
    expect(row).not.toBeNull();
    expect(row!.action_taken).toContain('blocklisted');
    expect(row!.action_taken).toBe('junk-reaper:blocklisted:one-click:skipped');
  });

  it('non-blocklisted From with List-Unsubscribe → unsub still fires', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msgR1', threadId: 'threadR1' }] },
      headers: {
        msgR1: {
          'List-Unsubscribe': '<https://marketing.example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          From: 'Random Marketer <hi@marketing.example.com>',
        },
      },
    });
    const fetchMock = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;

    const result = await reapOnce({ db, gmailOps, fetch: fetchMock });

    expect(result.reaped).toBe(1);
    expect(result.unsubAttempted).toBe(1);
    expect(result.unsubSucceeded).toBe(1);
    expect(result.unsubSkippedBlocklist).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://marketing.example.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('user-config blocklist patterns add on top of defaults', async () => {
    const gmailOps = makeGmailOps(['personal'], {
      listings: { personal: [{ id: 'msgU1', threadId: 'threadU1' }] },
      headers: {
        msgU1: {
          'List-Unsubscribe': '<https://custom.example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          From: 'ceo@mycompany.example',
        },
      },
    });
    const fetchMock = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;

    const result = await reapOnce({
      db,
      gmailOps,
      fetch: fetchMock,
      blocklist: ['*@github.com', '*@mycompany.example'],
    });

    expect(result.reaped).toBe(1);
    expect(result.unsubAttempted).toBe(0);
    expect(result.unsubSkippedBlocklist).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isBlocklisted parses "Name <x@domain>" and raw "x@domain" forms', () => {
    const patterns = ['*@github.com'];
    expect(isBlocklisted('GitHub <noreply@github.com>', patterns)).toBe(true);
    expect(isBlocklisted('noreply@github.com', patterns)).toBe(true);
    expect(isBlocklisted('"Bracketed Name" <noreply@github.com>', patterns)).toBe(true);
  });

  it('isBlocklisted returns true on unparseable input (safe default)', () => {
    expect(isBlocklisted('', ['*@github.com'])).toBe(true);
    expect(isBlocklisted(undefined, ['*@github.com'])).toBe(true);
    expect(isBlocklisted('no email here', ['*@github.com'])).toBe(true);
  });

  it('isBlocklisted supports *@*.domain.com wildcards correctly', () => {
    const patterns = ['*@*.domain.com'];
    expect(isBlocklisted('foo@bar.domain.com', patterns)).toBe(true);
    expect(isBlocklisted('foo@domain.com', patterns)).toBe(false);
    expect(isBlocklisted('foo@evil-domain.com', patterns)).toBe(false);
  });

  it('concurrency guard: overlapping start calls skip while in-flight', async () => {
    let resolveFirst: (() => void) | null = null;
    const gmailOps = makeGmailOps(['personal'], {
      listImpl: () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve([]);
        }),
    });
    const warnSpy = vi.fn();

    const stop = startJunkReaper(
      {
        db,
        gmailOps,
        logger: {
          info: vi.fn(),
          warn: warnSpy,
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
      100_000,
    );

    // Let the immediate-first-tick queue and start its listMessagesByLabel
    await new Promise((r) => setTimeout(r, 10));
    expect(gmailOps.listMessagesByLabel).toHaveBeenCalledTimes(1);

    // Re-driving setInterval manually is awkward; instead, trigger a
    // second tick by calling reapOnce directly while the first is in
    // flight would bypass the guard (which is on startJunkReaper's
    // closure). So we assert the guard by forcing the interval: we rely
    // on the warn spy being called if setInterval fires again before
    // the first tick resolves. Shorten interval via a second start:
    stop();

    // Finish the hanging first tick
    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 10));

    // Now verify a fast-interval start does skip while in flight.
    let resolveSecond: (() => void) | null = null;
    const gmailOps2 = makeGmailOps(['personal'], {
      listImpl: () =>
        new Promise((resolve) => {
          resolveSecond = () => resolve([]);
        }),
    });
    const warnSpy2 = vi.fn();
    const stop2 = startJunkReaper(
      {
        db,
        gmailOps: gmailOps2,
        logger: {
          info: vi.fn(),
          warn: warnSpy2,
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
      15,
    );

    // Let setInterval fire a few times while the first tick is hung
    await new Promise((r) => setTimeout(r, 80));

    expect(warnSpy2).toHaveBeenCalledWith(
      'Junk reaper: previous tick still in flight, skipping',
    );
    // Only the immediate-first-tick actually started; later ones skipped.
    expect(gmailOps2.listMessagesByLabel).toHaveBeenCalledTimes(1);

    resolveSecond?.();
    stop2();
    await new Promise((r) => setTimeout(r, 10));
  });
});
