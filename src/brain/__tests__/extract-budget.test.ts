import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmp;
  },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  extractLLM,
  getTodaysExtractSpend,
  getDailyLlmBudgetUsd,
} from '../extract.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-budget-'));
  process.env.BRAIN_LLM_DAILY_BUDGET_USD = '0.10';
  process.env.BRAIN_LLM_BUDGET_CHAT_PCT = '30'; // 30% of $0.10 = $0.03
});

afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.BRAIN_LLM_DAILY_BUDGET_USD;
  delete process.env.BRAIN_LLM_BUDGET_CHAT_PCT;
});

describe('extract budget partition', () => {
  it('chat extraction is gated when extract_chat spend reaches the chat slice', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    // Pre-fill the chat slice to its cap.
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('seed', ?, 'anthropic', 'extract_chat', 100, 0.03, ?)`,
    ).run(today, new Date().toISOString());

    expect(getTodaysExtractSpend(db, today, 'chat')).toBeCloseTo(0.03, 5);
    expect(getTodaysExtractSpend(db, today)).toBeCloseTo(0.03, 5);

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'something to extract', mode: 'chat_single' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('email extraction is unaffected by chat-slice spend', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('seed', ?, 'anthropic', 'extract_chat', 100, 0.03, ?)`,
    ).run(today, new Date().toISOString());

    const llm = vi.fn(async () => ({
      claims: [
        { text: 'a', topic_seed: 't', confidence: 0.9, entities_mentioned: [] },
      ],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const claims = await extractLLM(
      { text: 'pay $5,000 by Friday', mode: 'email' },
      { llmCaller: llm, db, day: today, signalScore: 1 },
    );
    expect(claims.length).toBe(1);
    expect(llm).toHaveBeenCalled();
  });

  it('email extraction is gated when overall spend exceeds the budget', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('over', ?, 'anthropic', 'extract', 100, ?, ?)`,
    ).run(today, getDailyLlmBudgetUsd(), new Date().toISOString());

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'pay $5,000 by Friday', mode: 'email' },
      { llmCaller: llm, db, day: today, signalScore: 1 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('chat extraction is gated when overall spend exceeds the budget', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    // Email spent the full budget — chat must also stop.
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('over', ?, 'anthropic', 'extract', 100, ?, ?)`,
    ).run(today, getDailyLlmBudgetUsd(), new Date().toISOString());

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'meaningful chat content', mode: 'chat_window' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('records chat-mode cost under operation=extract_chat', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    const llm = vi.fn(async () => ({
      claims: [
        { text: 'a', topic_seed: 't', confidence: 0.9, entities_mentioned: [] },
      ],
      inputTokens: 1000,
      outputTokens: 500,
    }));
    await extractLLM(
      { text: 'chat content', mode: 'chat_single' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    const chatSpend = getTodaysExtractSpend(db, today, 'chat');
    const emailSpend = getTodaysExtractSpend(db, today, 'email');
    expect(chatSpend).toBeGreaterThan(0);
    expect(emailSpend).toBe(0);
  });
});
