import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase } from '../db.js';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: vi.fn(),
  pinTelegramMessage: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, MINI_APP_URL: 'https://mini.example.com' };
});

import { pushAttentionItem } from '../triage/push-attention.js';

describe('pushAttentionItem', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('sends a message with the full set of inline buttons', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 101 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'x1',
      title: 'PR #42 review requested',
      reason: 'direct review ask',
      sender: 'alice@example.com',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, text, opts] = mockSend.mock.calls[0];
    expect(text).toContain('PR #42');
    expect(text).toContain('alice@example.com');
    expect(opts.reply_markup.inline_keyboard).toBeDefined();
    const flat = (
      opts.reply_markup.inline_keyboard as Array<
        Array<{ callback_data: string }>
      >
    )
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toEqual(
      expect.arrayContaining([
        'triage:dismiss:x1',
        'triage:snooze:1h:x1',
        'triage:snooze:tomorrow:x1',
        'triage:archive:x1',
      ]),
    );
    // "triage:override:archive" was folded into plain "triage:archive" when
    // the keyboard was simplified — archive-from-attention now records the
    // negative learning signal directly.
    expect(flat).not.toContain('triage:override:archive:x1');
  });

  it('prepends a Sign URL button when the email is an e-signature invite', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 202 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'sign-1',
      title: 'Please DocuSign: Contract',
      reason: 'signature requested',
      sender: 'DocuSign System <dse_NA4@docusign.net>',
    });

    const [, , opts] = mockSend.mock.calls[0];
    const keyboard = opts.reply_markup.inline_keyboard as Array<
      Array<{ text: string; url?: string; callback_data?: string }>
    >;
    // Top row is the single Sign button; existing 4-button row follows.
    expect(keyboard.length).toBe(2);
    expect(keyboard[0]).toHaveLength(1);
    expect(keyboard[0][0].text).toContain('Sign');
    expect(keyboard[0][0].url).toBe(
      'https://mini.example.com/api/email/sign-1/sign',
    );
    expect(keyboard[1]).toHaveLength(4);
  });

  it('omits the Sign button for non-signing emails', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 203 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'normal-1',
      title: 'Lunch tomorrow?',
      reason: 'direct ask',
      sender: 'friend@example.com',
    });

    const [, , opts] = mockSend.mock.calls[0];
    const keyboard = opts.reply_markup.inline_keyboard as Array<
      Array<{ text: string }>
    >;
    expect(keyboard.length).toBe(1);
    expect(keyboard[0]).toHaveLength(4);
  });
});
