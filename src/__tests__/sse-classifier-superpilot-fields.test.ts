import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

// These tests drive the Step 2-B wire-up: SuperPilot's SSE payload now
// carries email_type, suggested_action, and needs_reply. We want those
// three signals persisted on tracked_items so the downstream ingestion
// agent can pre-filter on them without re-classifying.
describe('classifyFromSSE — SuperPilot upstream fields', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('persists email_type into superpilot_label when superpilot_label absent', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-et-1',
        account: 'topcoder1@gmail.com',
        subject: 'Your receipt',
        sender: 'billing@vendor.com',
        email_type: 'transactions',
      },
    ];
    const results = classifyFromSSE(emails);
    expect(results).toHaveLength(1);

    const row = getDb()
      .prepare(`SELECT superpilot_label FROM tracked_items WHERE thread_id = ?`)
      .get('thread-et-1') as { superpilot_label: string | null };
    expect(row.superpilot_label).toBe('transactions');
  });

  it('superpilot_label wins over email_type when both present', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-both',
        account: 'topcoder1@gmail.com',
        subject: 'Budget approval needed',
        sender: 'cfo@company.com',
        superpilot_label: 'needs-attention',
        email_type: 'people',
      },
    ];
    classifyFromSSE(emails);

    const row = getDb()
      .prepare(`SELECT superpilot_label FROM tracked_items WHERE thread_id = ?`)
      .get('thread-both') as { superpilot_label: string | null };
    expect(row.superpilot_label).toBe('needs-attention');
  });

  it('persists suggested_action and needs_reply columns', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-sa-1',
        account: 'topcoder1@gmail.com',
        subject: 'Stellar Cyber OEM pricing',
        sender: 'alex@whoisxmlapi.com',
        email_type: 'people',
        suggested_action: 'reply',
        needs_reply: true,
      },
    ];
    classifyFromSSE(emails);

    const row = getDb()
      .prepare(
        `SELECT suggested_action, needs_reply FROM tracked_items WHERE thread_id = ?`,
      )
      .get('thread-sa-1') as {
      suggested_action: string | null;
      needs_reply: number | null;
    };
    expect(row.suggested_action).toBe('reply');
    expect(row.needs_reply).toBe(1);
  });

  it('leaves new columns null when upstream omits them', () => {
    const emails: SSEEmail[] = [
      {
        thread_id: 'thread-bare',
        account: 'topcoder1@gmail.com',
        subject: 'Weekly digest',
        sender: 'news@service.com',
        superpilot_label: 'newsletter',
      },
    ];
    classifyFromSSE(emails);

    const row = getDb()
      .prepare(
        `SELECT suggested_action, needs_reply FROM tracked_items WHERE thread_id = ?`,
      )
      .get('thread-bare') as {
      suggested_action: string | null;
      needs_reply: number | null;
    };
    expect(row.suggested_action).toBeNull();
    expect(row.needs_reply).toBeNull();
  });
});
