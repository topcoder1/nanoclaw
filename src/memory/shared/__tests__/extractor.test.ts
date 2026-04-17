// src/memory/shared/__tests__/extractor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCandidates, isTrivialTurn } from '../extractor.js';
import { ensureMemoryDirs, candidateDir } from '../paths.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

describe('extractor', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ext-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('skips trivial turns', () => {
    expect(isTrivialTurn('hi', 'hello!')).toBe(true);
    expect(isTrivialTurn('thanks', 'np')).toBe(true);
  });

  it('does not skip substantive turns', () => {
    expect(
      isTrivialTurn(
        'I prefer short answers, please be terse from now on',
        'Got it, I will be terse.',
      ),
    ).toBe(false);
  });

  it('writes candidate files when LLM returns candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            type: 'feedback',
            name: 'Prefers terse',
            description: 'd',
            body: 'User prefers terse.',
            scopes: ['chat'],
            proposed_action: 'create',
            confidence: 0.9,
          },
        ],
      }),
    });
    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'be terse from now on',
      agentReply: 'OK, will keep it short.',
    });
    const files = fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/telegram_main/);
    const raw = fs.readFileSync(path.join(candidateDir(), files[0]), 'utf8');
    expect(raw).toContain('Prefers terse');
    expect(raw).toContain('candidate: true');
  });

  it('writes nothing when LLM returns empty candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
    });
    await extractCandidates({
      groupName: 'tg',
      userMessage: 'random question',
      agentReply: 'random answer',
    });
    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')))
      .toHaveLength(0);
  });

  it('does not throw on malformed LLM output (fail closed)', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'not json at all',
    });
    await expect(
      extractCandidates({
        groupName: 'tg',
        userMessage: 'x',
        agentReply: 'y',
      }),
    ).resolves.toBeUndefined();
  });
});
