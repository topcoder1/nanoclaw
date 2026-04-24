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
          rankScore: 0.9,
          recencyScore: 0.95,
          accessScore: 0,
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

  it('passes the requested limit to recall()', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', { recallFn: spy, limit: 3 });
    expect(spy).toHaveBeenCalledWith('query', { limit: 3, account: undefined });
  });

  it('plumbs account scope through to recall()', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', {
      recallFn: spy,
      limit: 5,
      account: 'work',
    });
    expect(spy).toHaveBeenCalledWith('query', { limit: 5, account: 'work' });
  });

  it('passes personal scope through when caller requests it', async () => {
    const spy = vi.fn(async () => []);
    await handleRecallCommand('query', { recallFn: spy, account: 'personal' });
    expect(spy).toHaveBeenCalledWith('query', {
      limit: 5,
      account: 'personal',
    });
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
