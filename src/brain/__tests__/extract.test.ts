import fs from 'fs';
import os from 'os';
import path from 'path';

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

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  DAILY_LLM_BUDGET_USD,
  extractCheap,
  extractLLM,
  extractPipeline,
  getTodaysExtractSpend,
  normalizeTopic,
  topicKey,
  type LlmCaller,
} from '../extract.js';

describe('brain/extract — normalize + topic_key', () => {
  it('normalizeTopic lowercases, strips stopwords, truncates to 128', () => {
    expect(normalizeTopic('The Quick Brown Fox')).toBe('quick brown fox');
    expect(normalizeTopic('a and of the it')).toBe('');
    expect(normalizeTopic('abc'.repeat(100)).length).toBeLessThanOrEqual(128);
  });

  it('topicKey is deterministic for the same seed', () => {
    expect(topicKey('Foo Bar')).toBe(topicKey('Foo Bar'));
    expect(topicKey('Foo Bar')).toBe(topicKey('foo bar'));
    expect(topicKey('Foo Bar')).not.toBe(topicKey('baz qux'));
  });
});

describe('brain/extract — cheap rules', () => {
  it('detects URL, email, phone, money, date, hubspot deal, gong call', () => {
    const r = extractCheap({
      subject: 'Renewal 2026-05-12',
      text: 'See https://example.com deal_12345 and call_98765. Ping me at +1 555 123 4567 or alice@example.com. Quote was $12,500.',
    });
    const kinds = r.claims[0]?.entities_mentioned.map((m) => m.kind) ?? [];
    expect(kinds).toContain('url');
    expect(kinds).toContain('email');
    expect(kinds).toContain('phone');
    expect(kinds).toContain('hubspot_deal');
    expect(kinds).toContain('gong_call');
    expect(r.signalScore).toBeGreaterThan(0.3);
  });

  it('scoreless text yields signal below LLM gate', () => {
    const r = extractCheap({ text: 'Hi! Thanks. See you soon.' });
    expect(r.signalScore).toBeLessThanOrEqual(0.3);
    expect(r.claims).toEqual([]);
  });

  it('cheap-tier confidence caps at 0.8 so rule extractions bypass review', () => {
    // Lots of signal: many URLs, emails, deals, calls → mentions.length
    // is large enough that the uncapped formula would exceed 0.8.
    const r = extractCheap({
      subject: 'Budget review 2026-05-12',
      text: [
        'See https://a.example https://b.example https://c.example',
        'deal_1 deal_2 deal_3 deal_4 deal_5',
        'call_1 call_2 call_3 call_4 call_5',
        'alice@x.co bob@y.co carol@z.co dave@w.co',
        'Quote $10,000. Quote $20,000. Phone +1 555 111 2222.',
      ].join(' '),
    });
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].confidence).toBeLessThanOrEqual(0.8);
    // With enough mentions, we hit the 0.8 ceiling exactly (v2 §7: >0.7
    // → needs_review=0), which is the point of the cap.
    expect(r.claims[0].confidence).toBe(0.8);
  });
});

describe('brain/extract — LLM gating', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-extract-'));
    getBrainDb();
  });
  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips LLM when signal <= 0.3', async () => {
    const caller: LlmCaller = vi.fn();
    const claims = await extractLLM(
      { text: 'nothing special here' },
      { signalScore: 0.2, llmCaller: caller as unknown as LlmCaller },
    );
    expect(claims).toEqual([]);
    expect(caller).not.toHaveBeenCalled();
  });

  it('skips LLM when today already hit budget', async () => {
    const db = getBrainDb();
    // Seed cost_log up to the budget.
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('c1', ?, 'anthropic', 'extract', 1000, ?, ?)`,
    ).run(new Date().toISOString().slice(0, 10), DAILY_LLM_BUDGET_USD + 0.01, 'now');

    const caller = vi.fn();
    const claims = await extractLLM(
      { text: 'deal_99 $1,000,000' },
      { signalScore: 0.9, llmCaller: caller as unknown as LlmCaller },
    );
    expect(claims).toEqual([]);
    expect(caller).not.toHaveBeenCalled();
  });

  it('calls LLM when gated in and writes cost_log', async () => {
    const caller: LlmCaller = vi.fn(async () => ({
      claims: [
        {
          text: 'Acme agreed to renew at $120K.',
          topic_seed: 'Acme renewal',
          entities_mentioned: [{ kind: 'company', value: 'Acme' }],
          confidence: 0.8,
        },
      ],
      inputTokens: 500,
      outputTokens: 200,
    }));

    const claims = await extractLLM(
      { text: 'deal_99 we will renew at $120K' },
      { signalScore: 0.9, llmCaller: caller },
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].confidence).toBe(0.8);
    expect(claims[0].extracted_by).toBe('llm');

    const spent = getTodaysExtractSpend(getBrainDb());
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(DAILY_LLM_BUDGET_USD); // well under the cap
  });
});

describe('brain/extract — extractPipeline confidence branching', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-extract-pipe-'));
    getBrainDb();
  });
  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drops claims with confidence < 0.4 and marks 0.4–0.7 as needs_review', async () => {
    const caller: LlmCaller = vi.fn(async () => ({
      claims: [
        { text: 'strong', topic_seed: 'strong claim', confidence: 0.95 },
        { text: 'medium', topic_seed: 'medium claim', confidence: 0.55 },
        { text: 'weak', topic_seed: 'weak claim', confidence: 0.2 }, // dropped
      ],
      inputTokens: 100,
      outputTokens: 50,
    }));

    const claims = await extractPipeline(
      { text: 'deal_1 $50,000 see https://example.com' },
      { llmCaller: caller },
    );
    const texts = claims.map((c) => c.text);
    expect(texts).toContain('strong');
    expect(texts).toContain('medium');
    expect(texts).not.toContain('weak');
    expect(claims.find((c) => c.text === 'strong')!.needs_review).toBe(false);
    expect(claims.find((c) => c.text === 'medium')!.needs_review).toBe(true);
  });

  it('topic_key is stable across calls with same seed', async () => {
    const caller: LlmCaller = vi.fn(async () => ({
      claims: [
        { text: 'a', topic_seed: 'Acme renewal Q4', confidence: 0.9 },
      ],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const a = await extractPipeline(
      { text: 'deal_1 $50,000' },
      { llmCaller: caller },
    );
    const b = await extractPipeline(
      { text: 'deal_1 $50,000' },
      { llmCaller: caller },
    );
    expect(a[0].topic_key).toBe(b[0].topic_key);
  });
});
