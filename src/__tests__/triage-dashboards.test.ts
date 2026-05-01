import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase, getDb } from '../db.js';

const { mockSend, mockEdit, mockPin, mockGetPinned } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockEdit: vi.fn(),
  mockPin: vi.fn(),
  // Default to "no current pin" so the drift-guard treats the cached id as
  // authoritative (matches the historical behavior the older tests assume).
  // Individual tests can override via mockGetPinned.mockResolvedValueOnce.
  mockGetPinned: vi.fn().mockResolvedValue(null),
}));
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: mockEdit,
  pinTelegramMessage: mockPin,
  getChatPinnedMessageId: mockGetPinned,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  renderArchiveDashboard,
  renderAttentionDashboard,
} from '../triage/dashboards.js';

describe('renderAttentionDashboard', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    mockEdit.mockReset();
    mockPin.mockReset();
    mockGetPinned.mockReset();
    // Default to "no current pin known" — drift-guard becomes a no-op and
    // upsertDashboard trusts its cached id, matching pre-drift-guard
    // behavior. Tests that exercise the drift path override below.
    mockGetPinned.mockResolvedValue(null);
  });
  afterEach(() => _closeDatabase());

  it('posts + pins a new message when none exists', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 42 });
    mockPin.mockResolvedValueOnce({ ok: true });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [
        {
          id: 'a',
          title: 'PR review requested',
          reason: 'github',
          ageMins: 10,
        },
      ],
    });

    expect(mockSend).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith('-100123', 42);

    const row = getDb()
      .prepare(
        `SELECT pinned_msg_id FROM triage_dashboards WHERE topic = 'attention'`,
      )
      .get() as { pinned_msg_id: number };
    expect(row.pinned_msg_id).toBe(42);
  });

  it('edits the existing pinned message on subsequent non-empty calls', async () => {
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', '-100123', 99, ?)`,
      )
      .run(Date.now());

    mockEdit.mockResolvedValueOnce({ message_id: 99 });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [
        { id: 'a', title: 'Invoice pending', reason: 'invoice', ageMins: 5 },
      ],
    });
    expect(mockEdit).toHaveBeenCalledWith(
      '-100123',
      99,
      expect.stringContaining('Attention'),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('detects pin drift and re-creates the dashboard instead of editing the stale id', async () => {
    // Cached row claims msg 99 is the pinned dashboard, but Telegram says
    // the active pin is now 555 (an out-of-band repin / DB migration). The
    // edit would silently update an invisible old message; re-create instead.
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', '-100123', 99, ?)`,
      )
      .run(Date.now());

    mockGetPinned.mockResolvedValueOnce(555);
    mockSend.mockResolvedValueOnce({ message_id: 777 });
    mockPin.mockResolvedValueOnce({ ok: true });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [
        { id: 'a', title: 'Invoice pending', reason: 'invoice', ageMins: 5 },
      ],
    });

    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith('-100123', 777);

    // Tracking row now points at the freshly-pinned message id, not the
    // stale 99 that drifted.
    const row = getDb()
      .prepare(
        `SELECT pinned_msg_id FROM triage_dashboards WHERE topic = 'attention'`,
      )
      .get() as { pinned_msg_id: number };
    expect(row.pinned_msg_id).toBe(777);
  });

  it('skips editing the pinned dashboard when the queue is empty', async () => {
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', '-100123', 99, ?)`,
      )
      .run(Date.now());

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [],
    });
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('renderArchiveDashboard', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    mockEdit.mockReset();
    mockPin.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('does NOT post a fresh "0 pending" message when no dashboard exists yet', async () => {
    // Regression: posting + pinning a brand-new "0 pending" message
    // emits a Telegram notification — pure noise after a state reset
    // or on a clean install. Suppress the create path entirely when
    // there's nothing to show.
    await renderArchiveDashboard({
      chatId: '-100123',
      counts: {},
      total: 0,
      nextDigestHuman: 'tomorrow 8am',
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPin).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('edits an existing pinned dashboard down to 0 pending (silent)', async () => {
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('archive', '-100123', 77, ?)`,
      )
      .run(Date.now());

    mockEdit.mockResolvedValueOnce({ message_id: 77 });

    await renderArchiveDashboard({
      chatId: '-100123',
      counts: {},
      total: 0,
      nextDigestHuman: 'tomorrow 8am',
    });
    expect(mockEdit).toHaveBeenCalledWith(
      '-100123',
      77,
      expect.stringContaining('0 pending'),
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('posts + pins a new dashboard when there is something to show', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 55 });
    mockPin.mockResolvedValueOnce({ ok: true });

    await renderArchiveDashboard({
      chatId: '-100123',
      counts: { receipt: 3 },
      total: 3,
      nextDigestHuman: 'tomorrow 8am',
    });
    expect(mockSend).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith('-100123', 55);
  });
});
