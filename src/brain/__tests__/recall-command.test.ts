import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { handleRecallCommand } from '../recall-command.js';

describe('brain/recall-command', () => {
  it('returns help text on empty query', async () => {
    const msg = await handleRecallCommand('   ');
    expect(msg).toMatch(/Usage:/);
    expect(msg).toMatch(/\/recall/);
  });

  it('reports no matches when recall returns []', async () => {
    const msg = await handleRecallCommand('whatever', {
      recallFn: async () => [],
    });
    expect(msg).toMatch(/No matches/);
  });

  it('formats results with source, date, score, snippet', async () => {
    const msg = await handleRecallCommand('what did Alice say', {
      dbForCitations: null,
      recallFn: async () => [
        {
          ku_id: 'KU-1',
          text: 'Alice said she would renew at $120K.',
          source_type: 'email',
          source_ref: 'thread-42',
          account: 'work',
          valid_from: '2026-04-20T10:00:00Z',
          recorded_at: '2026-04-20T10:05:00Z',
          topic_key: null,
          important: false,
          rankScore: 0.9,
          recencyScore: 0.95,
          accessScore: 0,
          importantScore: 0,
          finalScore: 0.85,
        },
      ],
    });
    expect(msg).toMatch(/1\./);
    expect(msg).toMatch(/email/);
    expect(msg).toMatch(/2026-04-20/);
    expect(msg).toMatch(/0\.85/);
    expect(msg).toMatch(/Alice said/);
    expect(msg).toMatch(/thread-42/);
  });

  it('renders [subject · date](url) when citation is enriched', async () => {
    const fakeDb = {
      prepare: () => ({
        get: () => ({
          payload: JSON.stringify({
            subject: 'Q4 renewal — pricing discussion',
            sender: 'alice@acme.co',
            account: 'attaxion',
          }),
        }),
      }),
    } as unknown as import('better-sqlite3').Database;
    const msg = await handleRecallCommand('alice', {
      recallFn: async () => [
        {
          ku_id: 'KU-2',
          text: 'Renewal closed.',
          source_type: 'email',
          source_ref: 'thread-99',
          account: 'work',
          valid_from: '2026-04-20T10:00:00Z',
          recorded_at: '2026-04-20T10:05:00Z',
          topic_key: null,
          important: false,
          rankScore: 0.9,
          recencyScore: 0.95,
          accessScore: 0,
          importantScore: 0,
          finalScore: 0.9,
        },
      ],
      dbForCitations: fakeDb,
      resolveAlias: (alias) =>
        alias === 'attaxion' ? 'jonathan@attaxion.com' : null,
    });
    // Subject is rendered with markdown escaping (— stays as —)
    expect(msg).toMatch(/Q4 renewal/);
    expect(msg).toMatch(/2026-04-20/);
    // ?authuser= deep link form, with URL-encoded address
    expect(msg).toContain(
      'https://mail.google.com/mail/u/0/?authuser=jonathan%40attaxion.com#all/thread-99',
    );
  });

  it('falls back to bare thread ref when no resolver is wired', async () => {
    const msg = await handleRecallCommand('alice', {
      recallFn: async () => [
        {
          ku_id: 'KU-3',
          text: 'Renewal closed.',
          source_type: 'email',
          source_ref: 'thread-77',
          account: 'work',
          valid_from: '2026-04-20T10:00:00Z',
          recorded_at: '2026-04-20T10:05:00Z',
          topic_key: null,
          important: false,
          rankScore: 0.9,
          recencyScore: 0.95,
          accessScore: 0,
          importantScore: 0,
          finalScore: 0.9,
        },
      ],
      dbForCitations: null,
    });
    expect(msg).toMatch(/thread-77/);
    expect(msg).not.toContain('mail.google.com');
  });

  it('passes the requested limit to recall()', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', { recallFn: spy, limit: 3 });
    expect(spy).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ limit: 3, account: undefined }),
    );
  });

  it('plumbs account scope through to recall()', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', {
      recallFn: spy,
      limit: 5,
      account: 'work',
    });
    expect(spy).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ limit: 5, account: 'work' }),
    );
  });

  it('passes personal scope through when caller requests it', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', { recallFn: spy, account: 'personal' });
    expect(spy).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ limit: 5, account: 'personal' }),
    );
  });

  it('falls back to a graceful error message when recall throws', async () => {
    const msg = await handleRecallCommand('boom', {
      recallFn: async () => {
        throw new Error('db down');
      },
    });
    expect(msg).toMatch(/⚠️/);
    expect(msg).toMatch(/Recall failed/);
  });
});
