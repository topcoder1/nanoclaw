import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  getDb,
} from '../../db.js';
import { runAttentionReminderSweep } from '../reminder.js';

const sent: Array<{ chatId: string; text: string }> = [];

vi.mock('../../channels/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async (chatId: string, text: string) => {
    sent.push({ chatId, text });
  }),
}));

vi.mock('../../env.js', async () => {
  const actual = await vi.importActual<object>('../../env.js');
  return {
    ...actual,
    readEnvValue: (key: string) =>
      key === 'EMAIL_INTEL_TG_CHAT_ID' ? 'test-chat' : undefined,
  };
});

function insert(id: string, title: string, ageHours: number): void {
  getDb()
    .prepare(
      `INSERT INTO tracked_items (id, source, source_id, group_name, state, title, detected_at)
       VALUES (?, 'gmail', ?, 'main', 'pushed', ?, ?)`,
    )
    .run(id, `src:${id}`, title, Date.now() - ageHours * 3600_000);
}

describe('runAttentionReminderSweep — clustering', () => {
  beforeEach(() => {
    sent.length = 0;
    _initTestDatabase();
  });
  afterEach(() => _closeDatabase());

  it('sends one consolidated reminder per cluster of duplicate titles', async () => {
    insert('a', 'Failed deployment from ci@local', 2);
    insert('b', 'Failed deployment from ci@local', 2);
    insert('c', 'Failed deployment from ci@local', 2);
    insert('d', "Failed preview deployment on team 'topcoder1's projects'", 2);
    insert('e', "Failed preview deployment on team 'topcoder1's projects'", 2);

    await runAttentionReminderSweep({ windowHours: 1 });

    expect(sent).toHaveLength(2);
    const texts = sent.map((s) => s.text).sort();
    expect(texts[0]).toBe(
      "⏰ 2 still waiting: *Failed preview deployment on team 'topcoder1's projects'*",
    );
    expect(texts[1]).toBe(
      '⏰ 3 still waiting: *Failed deployment from ci@local*',
    );
  });

  it('uses singular phrasing when cluster has only one row', async () => {
    insert('a', 'One-off review request', 2);
    await runAttentionReminderSweep({ windowHours: 1 });
    expect(sent).toEqual([
      { chatId: 'test-chat', text: '⏰ Still waiting on you: *One-off review request*' },
    ]);
  });

  it('clusters titles that differ only by digit runs', async () => {
    insert('a', 'Build #1234 failed', 2);
    insert('b', 'Build #1235 failed', 2);
    await runAttentionReminderSweep({ windowHours: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/^⏰ 2 still waiting: \*Build #123\d failed\*$/);
  });

  it('stamps every row in the cluster so a second sweep is silent', async () => {
    insert('a', 'Failed deployment', 2);
    insert('b', 'Failed deployment', 2);

    await runAttentionReminderSweep({ windowHours: 1 });
    expect(sent).toHaveLength(1);

    sent.length = 0;
    await runAttentionReminderSweep({ windowHours: 1 });
    expect(sent).toHaveLength(0);

    const remaining = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM tracked_items WHERE reminded_at IS NULL`,
      )
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('skips items younger than the window', async () => {
    insert('a', 'Fresh', 0.1);
    await runAttentionReminderSweep({ windowHours: 1 });
    expect(sent).toHaveLength(0);
  });
});
