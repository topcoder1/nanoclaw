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

describe('pushAttentionItem — signer ceremony', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('flag OFF (no signerCeremonyId) → URL button (legacy behavior)', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 301 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'sign-legacy',
      title: 'Please DocuSign: Contract',
      reason: 'signature requested',
      sender: 'DocuSign System <dse_NA4@docusign.net>',
      // no signerCeremonyId — falls back to legacy URL button
    });

    const [, , opts] = mockSend.mock.calls[0];
    const keyboard = opts.reply_markup.inline_keyboard as Array<
      Array<{ text: string; url?: string; callback_data?: string }>
    >;
    expect(keyboard.length).toBe(2);
    expect(keyboard[0]).toHaveLength(1);
    expect(keyboard[0][0].text).toContain('Sign');
    expect(keyboard[0][0].url).toBe(
      'https://mini.example.com/api/email/sign-legacy/sign',
    );
    expect(keyboard[0][0].callback_data).toBeUndefined();
  });

  it('flag ON + signerCeremonyId provided → callback_data buttons', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 302 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'sign-ceremony',
      title: 'Please DocuSign: Contract',
      reason: 'signature requested',
      sender: 'DocuSign System <dse_NA4@docusign.net>',
      signerCeremonyId: 'abc-123',
    });

    const [, , opts] = mockSend.mock.calls[0];
    const keyboard = opts.reply_markup.inline_keyboard as Array<
      Array<{ text: string; url?: string; callback_data?: string }>
    >;
    // Top row should have two callback buttons: approve and cancel
    expect(keyboard.length).toBe(2);
    expect(keyboard[0]).toHaveLength(2);
    const [approveBtn, cancelBtn] = keyboard[0];
    expect(approveBtn.callback_data).toBe('sign:approve:abc-123');
    expect(approveBtn.url).toBeUndefined();
    expect(cancelBtn.callback_data).toBe('sign:cancel:abc-123');
    expect(cancelBtn.url).toBeUndefined();
    // Standard 4-button triage row still present
    expect(keyboard[1]).toHaveLength(4);
  });
});
