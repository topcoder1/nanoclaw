import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// The SSE parser writes IPC trigger files when no debouncer is set.
// Tests route through a debouncer in passthrough mode (debounceMs=0)
// so the test sees exactly what the debouncer sees — no tmp files.
vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp',
  EMAIL_INTELLIGENCE_ENABLED: true,
  SSE_CONNECTIONS: [],
  SUPERPILOT_API_URL: 'https://example.invalid',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import {
  setEmailTriggerDebouncer,
  _handleTriagedEmailsForTest,
} from '../email-sse.js';
import { EmailTriggerDebouncer } from '../email-trigger-debouncer.js';
import type { SSEEmail } from '../sse-classifier.js';

describe('email-sse parser — SuperPilot upstream field forwarding', () => {
  let flushed: SSEEmail[];
  let debouncer: EmailTriggerDebouncer;

  beforeEach(() => {
    flushed = [];
    debouncer = new EmailTriggerDebouncer({
      debounceMs: 0, // passthrough — flush synchronously per add()
      maxHoldMs: 0,
      onFlush: (emails) => {
        flushed.push(...emails);
      },
    });
    setEmailTriggerDebouncer(debouncer);
  });

  afterEach(() => {
    debouncer.destroy();
    setEmailTriggerDebouncer(null);
  });

  it('forwards email_type, suggested_action, needs_reply from raw SSE payload', () => {
    const rawSsePayload = JSON.stringify({
      emails: [
        {
          thread_id: 'raw-thread-1',
          account: 'topcoder1@gmail.com',
          subject: 'Stellar Cyber OEM pricing',
          sender: 'Alex Ronquillo',
          snippet: 'As discussed, below is a summary...',
          email_type: 'people',
          suggested_action: 'reply',
          needs_reply: true,
        },
      ],
      count: 1,
    });

    _handleTriagedEmailsForTest(rawSsePayload, 'primary');

    expect(flushed).toHaveLength(1);
    const email = flushed[0];
    expect(email.thread_id).toBe('raw-thread-1');
    expect(email.email_type).toBe('people');
    expect(email.suggested_action).toBe('reply');
    expect(email.needs_reply).toBe(true);
  });

  it('leaves fields undefined when upstream omits them', () => {
    const rawSsePayload = JSON.stringify({
      emails: [
        {
          thread_id: 'raw-thread-2',
          account: 'topcoder1@gmail.com',
          subject: 'Weekly digest',
          sender: 'news@service.com',
          snippet: 'Top stories...',
        },
      ],
      count: 1,
    });

    _handleTriagedEmailsForTest(rawSsePayload, 'primary');

    expect(flushed).toHaveLength(1);
    const email = flushed[0];
    expect(email.email_type).toBeUndefined();
    expect(email.suggested_action).toBeUndefined();
    expect(email.needs_reply).toBeUndefined();
  });
});
