import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocks mirror src/__tests__/sse-classifier.test.ts. classifyFromSSE
// reaches into logger, config, and the event bus — stubbing them keeps
// the test isolated from logging noise and from config-file presence.
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock('../config.js', () => ({
  CHAT_INTERFACE_CONFIG: {
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
    vipList: [],
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    holdPushDuringMeetings: false,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      weekendMode: false,
      escalateOverride: true,
    },
    morningDashboardTime: '07:30',
    microBriefingDelayMs: 60000,
  },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { classifyFromSSE, type SSEEmail } from '../sse-classifier.js';
import { getTrackedItemBySourceId } from '../tracked-items.js';
import { logger } from '../logger.js';

describe('classifyFromSSE — mute hook + sender/subtype wiring', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });
  afterEach(() => _closeDatabase());

  it('skips tracked_items insert when thread is muted and logs muted_skip', () => {
    // Mark thread-abc as muted BEFORE the SSE event arrives. The
    // classifier's isThreadMuted check must fire before any insert/
    // classify/event-emit side effects.
    getDb()
      .prepare(
        `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
      )
      .run('thread-abc', 'alice@example.com', Date.now());

    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-abc',
        account: 'alice@example.com',
        subject: 'anything',
        sender: 'someone@example.com',
        snippet: 'body',
      },
    ];

    const results = classifyFromSSE(emails);

    // No results returned, no tracked_items row inserted.
    expect(results).toHaveLength(0);
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM tracked_items')
      .get() as { n: number };
    expect(count.n).toBe(0);

    // Muted-skip log event fires so operators can watch the ratio.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 'thread-abc',
        component: 'triage',
        event: 'muted_skip',
      }),
      expect.stringContaining('Muted thread'),
    );
  });

  it('populates sender_kind=bot and subtype=transactional for Stripe verification-code email', () => {
    // SSE payload is header-poor — no List-Unsubscribe, no
    // gmailCategory. The combo below still lands both heuristics:
    //   classifySender: localpart "noreply" matches BOT_LOCALPART → bot
    //   classifySubtype: stripe.com domain (+1) + "verification code"
    //                    subject keyword (+1) = 2 signals → transactional
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-stripe-otp',
        account: 'alice@example.com',
        subject: 'Your Stripe verification code',
        sender: 'noreply@stripe.com',
        snippet: 'Your verification code is 123456',
      },
    ];

    const results = classifyFromSSE(emails);
    expect(results).toHaveLength(1);

    const item = getTrackedItemBySourceId('gmail', 'gmail:thread-stripe-otp');
    expect(item).not.toBeNull();
    expect(item!.sender_kind).toBe('bot');
    expect(item!.subtype).toBe('transactional');
  });

  it('populates sender_kind=human and subtype=null for a plain human-sent email', () => {
    // Counterexample — a human sender on a non-transactional subject
    // must leave subtype null (don't over-classify) and sender_kind
    // must fall through the bot heuristics to 'human'.
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-human',
        account: 'alice@example.com',
        subject: 'lunch tomorrow?',
        sender: 'friend@gmail.com',
        snippet: 'are you free at noon',
      },
    ];

    classifyFromSSE(emails);

    const item = getTrackedItemBySourceId('gmail', 'gmail:thread-human');
    expect(item).not.toBeNull();
    expect(item!.sender_kind).toBe('human');
    expect(item!.subtype).toBeNull();
  });
});
