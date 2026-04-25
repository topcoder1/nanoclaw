import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { maybeInjectBrainContext } from '../auto-recall.js';
import type { RecallResult } from '../retrieve.js';

function hit(over: Partial<RecallResult> = {}): RecallResult {
  return {
    ku_id: 'KU-1',
    text: 'Alice said she would renew at $120K next quarter.',
    source_type: 'email',
    source_ref: 'thread-42',
    account: 'work',
    valid_from: '2026-04-20T10:00:00Z',
    recorded_at: '2026-04-20T10:05:00Z',
    topic_key: null,
    important: false,
    finalScore: 0.6,
    rankScore: 0.6,
    recencyScore: 0.9,
    accessScore: 0,
    importantScore: 0,
    ...over,
  };
}

describe('brain/auto-recall', () => {
  const originalEnv = process.env.BRAIN_AUTO_RECALL;

  beforeEach(() => {
    delete process.env.BRAIN_AUTO_RECALL;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BRAIN_AUTO_RECALL;
    else process.env.BRAIN_AUTO_RECALL = originalEnv;
  });

  it('returns prompt unchanged when explicitly disabled', async () => {
    const recallFn = vi.fn();
    const out = await maybeInjectBrainContext(
      'What did Alice say about renewal?',
      {
        enabled: false,
        recallFn,
      },
    );
    expect(out).toBe('What did Alice say about renewal?');
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('returns prompt unchanged when BRAIN_AUTO_RECALL=0', async () => {
    process.env.BRAIN_AUTO_RECALL = '0';
    const recallFn = vi.fn();
    const out = await maybeInjectBrainContext(
      'What did Alice say about renewal?',
      {
        recallFn,
      },
    );
    expect(out).toBe('What did Alice say about renewal?');
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('returns prompt unchanged when BRAIN_AUTO_RECALL=false', async () => {
    process.env.BRAIN_AUTO_RECALL = 'false';
    const recallFn = vi.fn();
    const out = await maybeInjectBrainContext(
      'What did Alice say about renewal?',
      {
        recallFn,
      },
    );
    expect(out).toBe('What did Alice say about renewal?');
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('treats unset env as enabled', async () => {
    const recallFn = vi.fn(async () => []);
    await maybeInjectBrainContext('What did Alice say about renewal?', {
      recallFn,
    });
    expect(recallFn).toHaveBeenCalledOnce();
  });

  it('skips short prompts under 20 chars', async () => {
    const recallFn = vi.fn();
    const out = await maybeInjectBrainContext('thanks', { recallFn });
    expect(out).toBe('thanks');
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('skips system-generated trigger prompts', async () => {
    const recallFn = vi.fn();
    for (const prefix of [
      '## Email Intelligence Trigger',
      '## Task Completed',
      '## Scheduled Task',
      '## Webhook',
      '## Signer',
    ]) {
      const prompt = `${prefix}\n\nbody body body that is plenty long`;
      const out = await maybeInjectBrainContext(prompt, { recallFn });
      expect(out).toBe(prompt);
    }
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('returns original prompt when recall returns no hits', async () => {
    const out = await maybeInjectBrainContext(
      'What did Alice say about renewal?',
      {
        recallFn: async () => [],
      },
    );
    expect(out).toBe('What did Alice say about renewal?');
  });

  it('filters out hits below the score floor (0.25)', async () => {
    const out = await maybeInjectBrainContext(
      'What did Alice say about renewal?',
      {
        recallFn: async () => [
          hit({ finalScore: 0.1 }),
          hit({ finalScore: 0.2 }),
        ],
      },
    );
    expect(out).toBe('What did Alice say about renewal?');
  });

  it('injects a brain_context block when hits clear the floor', async () => {
    const prompt = 'What did Alice say about renewal?';
    const out = await maybeInjectBrainContext(prompt, {
      recallFn: async () => [hit({ finalScore: 0.6 })],
    });
    expect(out).toContain('<brain_context>');
    expect(out).toContain('</brain_context>');
    expect(out).toContain('Alice said she would renew');
    expect(out).toContain('✉️ email');
    expect(out.endsWith(prompt)).toBe(true);
  });

  it('uses source_ref as label for repo hits', async () => {
    const out = await maybeInjectBrainContext('How does authentication work?', {
      recallFn: async () => [
        hit({
          source_type: 'repo',
          source_ref: 'inbox_superpilot:docs/designs/auth.md',
          text: 'Auth flows go through Supabase.',
          finalScore: 0.7,
        }),
      ],
    });
    expect(out).toContain('📄 repo');
    expect(out).toContain('inbox_superpilot:docs/designs/auth.md');
  });

  it('tags note source_type', async () => {
    const out = await maybeInjectBrainContext('What was that idea I had?', {
      recallFn: async () => [
        hit({
          source_type: 'note',
          source_ref: null,
          text: 'Try Postgres LISTEN/NOTIFY for the queue.',
          finalScore: 0.6,
        }),
      ],
    });
    expect(out).toContain('📝 note');
    expect(out).toContain('Try Postgres');
  });

  it('respects the maxChars cap by dropping hits that overflow', async () => {
    const big = 'X'.repeat(200);
    const out = await maybeInjectBrainContext(
      'Tell me about the big thing here',
      {
        maxChars: 150,
        recallFn: async () => [
          hit({ ku_id: 'KU-A', text: big, finalScore: 0.8 }),
          hit({ ku_id: 'KU-B', text: big, finalScore: 0.8 }),
          hit({ ku_id: 'KU-C', text: big, finalScore: 0.8 }),
        ],
      },
    );
    // First hit (~120 chars) fits in 150; the rest must be dropped.
    const matches = out.match(/- \[/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('returns original prompt when even the first hit overflows the cap', async () => {
    const prompt = 'What did Alice say about renewal?';
    const out = await maybeInjectBrainContext(prompt, {
      maxChars: 5,
      recallFn: async () => [hit({ finalScore: 0.6 })],
    });
    expect(out).toBe(prompt);
  });

  it('passes caller="agent-auto" to recall()', async () => {
    const recallFn = vi.fn(async () => []);
    await maybeInjectBrainContext('What did Alice say about renewal?', {
      recallFn,
    });
    expect(recallFn).toHaveBeenCalledWith(
      'What did Alice say about renewal?',
      expect.objectContaining({ caller: 'agent-auto', limit: 5 }),
    );
  });

  it('skips recall when the prompt matches a mute pattern', async () => {
    const recallFn = vi.fn();
    const out = await maybeInjectBrainContext(
      'Show me my Sentry alerts for today please',
      {
        recallFn,
        isMutedFn: (p) =>
          p.toLowerCase().includes('sentry') ? 'sentry' : null,
      },
    );
    expect(out).toBe('Show me my Sentry alerts for today please');
    expect(recallFn).not.toHaveBeenCalled();
  });

  it('mute check is case-insensitive substring (passed in by caller)', async () => {
    const recallFn = vi.fn(async () => []);
    await maybeInjectBrainContext('What did Alice say about renewal?', {
      recallFn,
      // No mute pattern matches → recall still runs.
      isMutedFn: () => null,
    });
    expect(recallFn).toHaveBeenCalledOnce();
  });

  it('returns original prompt when recall throws', async () => {
    const prompt = 'What did Alice say about renewal?';
    const out = await maybeInjectBrainContext(prompt, {
      recallFn: async () => {
        throw new Error('qdrant down');
      },
    });
    expect(out).toBe(prompt);
  });
});
