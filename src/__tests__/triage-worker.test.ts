import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { mockClassify, mockPushAttentionItem, mockRenderAttentionDashboard } =
  vi.hoisted(() => ({
    mockClassify: vi.fn(),
    mockPushAttentionItem: vi.fn(),
    mockRenderAttentionDashboard: vi.fn(),
  }));
vi.mock('../triage/classifier.js', () => ({
  classifyWithLlm: mockClassify,
}));
// CRITICAL: mock both Telegram-bound side effects at the top level so
// every test in this file is silent. triageEmail dynamic-imports these
// when not in shadow mode, and the real pushAttentionItem hits the
// Telegram Bot API using TELEGRAM_BOT_TOKEN + EMAIL_INTEL_TG_CHAT_ID
// from .env — without these mocks, running `npm test` spams real
// attention cards at the user's Telegram chat. (Discovered 2026-04-19:
// several "PR review from alice@example.com reason: x" cards had landed
// in the live chat from repeated test runs.)
vi.mock('../triage/push-attention.js', () => ({
  pushAttentionItem: mockPushAttentionItem,
}));
vi.mock('../triage/dashboards.js', () => ({
  renderAttentionDashboard: mockRenderAttentionDashboard,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { triageEmail } from '../triage/worker.js';
import { setTraceDir } from '../triage/traces.js';

describe('triageEmail', () => {
  let dir: string;
  beforeEach(() => {
    _initTestDatabase();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-worker-'));
    setTraceDir(dir);
    mockClassify.mockReset();
    mockPushAttentionItem.mockReset();
    mockRenderAttentionDashboard.mockReset();
  });
  afterEach(() => {
    _closeDatabase();
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
  });

  it('returns skipped when prefilter matches (SP newsletter)', async () => {
    const out = await triageEmail({
      trackedItemId: 'x',
      emailBody: 'newsletter content',
      sender: 'news@ben-evans.com',
      subject: 'weekly',
      superpilotLabel: 'newsletter',
      threadId: 't',
      account: 'a',
    });
    expect(out.outcome).toBe('skipped');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('calls classifier when not skipped and persists to tracked_items', async () => {
    mockClassify.mockResolvedValueOnce({
      decision: {
        queue: 'attention',
        confidence: 0.9,
        reasons: ['a', 'b'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'x',
      },
      tier: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheCreationTokens: 0,
      },
    });

    const out = await triageEmail({
      trackedItemId: 'x1',
      emailBody: 'review pls',
      sender: 'alice@example.com',
      subject: 'PR review',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'a',
    });

    expect(out.outcome).toBe('classified');
    if (out.outcome === 'classified') {
      expect(out.decision.queue).toBe('attention');
      expect(out.tier).toBe(1);
    }
    expect(mockClassify).toHaveBeenCalledOnce();
  });

  it('does NOT push or render when shadowMode=true', async () => {
    process.env.EMAIL_INTEL_TG_CHAT_ID = '-100999';
    mockClassify.mockResolvedValueOnce({
      decision: {
        queue: 'attention',
        confidence: 0.9,
        reasons: ['r1', 'r2'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'x',
      },
      tier: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheCreationTokens: 0,
      },
    });

    const out = await triageEmail({
      trackedItemId: 'x3',
      emailBody: 'x',
      sender: 's@example.com',
      subject: 's',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
      shadowMode: true,
    });
    expect(out.outcome).toBe('classified');
    // Top-level mocks let us assert the shadowMode=true path doesn't
    // invoke either Telegram-bound helper, without per-test doMock dance.
    expect(mockPushAttentionItem).not.toHaveBeenCalled();
    expect(mockRenderAttentionDashboard).not.toHaveBeenCalled();

    delete process.env.EMAIL_INTEL_TG_CHAT_ID;
  });

  it('returns classified-shadow when shadow mode is on (no side effects)', async () => {
    mockClassify.mockResolvedValueOnce({
      decision: {
        queue: 'attention',
        confidence: 0.9,
        reasons: ['a', 'b'],
        action_intent: 'none',
        facts_extracted: [],
        repo_candidates: [],
        attention_reason: 'x',
      },
      tier: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheCreationTokens: 0,
      },
    });

    const out = await triageEmail({
      trackedItemId: 'x2',
      emailBody: 'x',
      sender: 's@example.com',
      subject: 's',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
      shadowMode: true,
    });

    expect(out.outcome).toBe('classified');
    if (out.outcome === 'classified') expect(out.shadowMode).toBe(true);
  });
});
