import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

let tmpGroupsDir: string;
let tmpDataDir: string;
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return tmpGroupsDir;
  },
  get STORE_DIR() {
    return tmpDataDir;
  },
  QDRANT_URL: '',
}));

import { eventBus } from '../../event-bus.js';
import type { ChatWindowFlushedEvent } from '../../events.js';
import {
  _initTestDatabase,
  _closeDatabase,
  setRegisteredGroup,
} from '../../db.js';
import { putChatMessage } from '../../chat-message-cache.js';
import { _resetGroupFrontmatterCache } from '../group-frontmatter.js';
import {
  noteMessage,
  noteSave,
  flushIdle,
  flushAll,
  _resetWindowState,
  _peekWindow,
} from '../window-flusher.js';

function writeOptIn(
  folder: string,
  opts: { idleMin?: number; cap?: number } = {},
): void {
  const dir = path.join(tmpGroupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', 'brain_ingest: window'];
  if (opts.idleMin !== undefined)
    lines.push(`window_idle_min: ${opts.idleMin}`);
  if (opts.cap !== undefined) lines.push(`window_cap: ${opts.cap}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), lines.join('\n'), 'utf8');
}

function captured(): ChatWindowFlushedEvent[] {
  const out: ChatWindowFlushedEvent[] = [];
  eventBus.on('chat.window.flushed', (e) => out.push(e));
  return out;
}

beforeEach(() => {
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wf-groups-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wf-data-'));
  _initTestDatabase();
  _resetGroupFrontmatterCache();
  _resetWindowState();
  eventBus.removeAllListeners();
});

afterEach(() => {
  _closeDatabase();
  fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('window-flusher', () => {
  it('ignores messages from chats that are not opted in', () => {
    noteMessage('discord', 'random-chat', 'm1', new Date().toISOString());
    expect(_peekWindow('discord', 'random-chat')).toBeUndefined();
  });

  it('ignores messages from registered groups with brain_ingest=off (the default)', () => {
    setRegisteredGroup('dc:c1', {
      name: 'g1',
      folder: 'no-frontmatter',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    fs.mkdirSync(path.join(tmpGroupsDir, 'no-frontmatter'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'no-frontmatter', 'CLAUDE.md'),
      '# no frontmatter\n',
      'utf8',
    );
    noteMessage('discord', 'c1', 'm1', new Date().toISOString());
    expect(_peekWindow('discord', 'c1')).toBeUndefined();
  });

  it('opens a window on the first message in an opted-in chat', () => {
    setRegisteredGroup('dc:c2', {
      name: 'g2',
      folder: 'opt2',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt2');
    const t = '2026-04-27T12:00:00.000Z';
    noteMessage('discord', 'c2', 'm1', t);
    const w = _peekWindow('discord', 'c2');
    expect(w).toBeDefined();
    expect(w!.message_ids).toEqual(['m1']);
    expect(w!.started_at).toBe(t);
    expect(w!.last_at).toBe(t);
  });

  it('flushIdle emits a ChatWindowFlushedEvent for windows past the idle threshold', () => {
    setRegisteredGroup('dc:c3', {
      name: 'g3',
      folder: 'opt3',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt3', { idleMin: 1 });
    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c3',
      message_id: 'm1',
      sent_at: new Date(t0).toISOString(),
      sender: 'u1',
      sender_name: 'Alice',
      text: 'hello',
    });
    putChatMessage({
      platform: 'discord',
      chat_id: 'c3',
      message_id: 'm2',
      sent_at: new Date(t0 + 30_000).toISOString(),
      sender: 'u1',
      sender_name: 'Alice',
      text: 'follow-up',
    });
    noteMessage('discord', 'c3', 'm1', new Date(t0).toISOString());
    noteMessage('discord', 'c3', 'm2', new Date(t0 + 30_000).toISOString());

    flushIdle(t0 + 30_000 + 90_000);

    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('idle');
    expect(events[0].message_count).toBe(2);
    expect(events[0].message_ids).toEqual(['m1', 'm2']);
    expect(events[0].transcript).toContain('Alice');
    expect(events[0].transcript).toContain('hello');
    expect(events[0].transcript).toContain('follow-up');
    expect(events[0].participants).toEqual(['Alice']);
    expect(events[0].group_folder).toBe('opt3');
    expect(_peekWindow('discord', 'c3')).toBeUndefined();
  });

  it('flushes on cap when the message count reaches window_cap', () => {
    setRegisteredGroup('dc:c4', {
      name: 'g4',
      folder: 'opt4',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt4', { cap: 3 });
    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    for (let i = 1; i <= 3; i++) {
      const t = t0 + i * 1000;
      putChatMessage({
        platform: 'discord',
        chat_id: 'c4',
        message_id: `m${i}`,
        sent_at: new Date(t).toISOString(),
        sender: 'u1',
        sender_name: 'Bob',
        text: `msg ${i}`,
      });
      noteMessage('discord', 'c4', `m${i}`, new Date(t).toISOString());
    }
    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('cap');
    expect(events[0].message_count).toBe(3);
    expect(_peekWindow('discord', 'c4')).toBeUndefined();
  });

  it('excludes message_ids passed to noteSave from the flushed transcript', () => {
    setRegisteredGroup('dc:c5', {
      name: 'g5',
      folder: 'opt5',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt5', { idleMin: 1 });
    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    for (const id of ['m1', 'm2', 'm3']) {
      putChatMessage({
        platform: 'discord',
        chat_id: 'c5',
        message_id: id,
        sent_at: new Date(t0).toISOString(),
        sender: 'u1',
        sender_name: 'Carol',
        text: `text ${id}`,
      });
      noteMessage('discord', 'c5', id, new Date(t0).toISOString());
    }
    noteSave('discord', 'c5', 'm2');
    flushIdle(t0 + 5 * 60_000);

    expect(events).toHaveLength(1);
    expect(events[0].message_ids).toEqual(['m1', 'm3']);
    expect(events[0].transcript).not.toContain('text m2');
    expect(events[0].transcript).toContain('text m1');
    expect(events[0].transcript).toContain('text m3');
  });

  it('flushAll emits with reason="shutdown" for every open window', () => {
    setRegisteredGroup('dc:c6', {
      name: 'g6',
      folder: 'opt6',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    setRegisteredGroup('sig:group:c7', {
      name: 'g7',
      folder: 'opt7',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt6');
    writeOptIn('opt7');
    const events = captured();
    const now = new Date().toISOString();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c6',
      message_id: 'mA',
      sent_at: now,
      sender: 'u',
      sender_name: 'X',
      text: 'a',
    });
    noteMessage('discord', 'c6', 'mA', now);
    putChatMessage({
      platform: 'signal',
      chat_id: 'c7',
      message_id: 'mB',
      sent_at: now,
      sender: 'u',
      sender_name: 'Y',
      text: 'b',
    });
    noteMessage('signal', 'c7', 'mB', now);

    flushAll('shutdown');

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.flush_reason === 'shutdown')).toBe(true);
    expect(_peekWindow('discord', 'c6')).toBeUndefined();
    expect(_peekWindow('signal', 'c7')).toBeUndefined();
  });

  it('flushAll on an empty state map is a no-op', () => {
    const events = captured();
    flushAll('shutdown');
    expect(events).toHaveLength(0);
  });

  it('startWindowFlusher schedules a tick that triggers idle flushes', async () => {
    setRegisteredGroup('dc:c8', {
      name: 'g8',
      folder: 'opt8',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt8', { idleMin: 1 });
    const events = captured();
    const sentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c8',
      message_id: 'mT',
      sent_at: sentAt,
      sender: 'u',
      sender_name: 'Tic',
      text: 'tick test',
    });
    noteMessage('discord', 'c8', 'mT', sentAt);

    const { startWindowFlusher, stopWindowFlusher } = await import(
      '../window-flusher.js'
    );
    startWindowFlusher({ tickIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    stopWindowFlusher();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].flush_reason).toBe('idle');
  });

  it('daily flush fires once per day when local hour crosses the threshold', async () => {
    setRegisteredGroup('dc:c9', {
      name: 'g9',
      folder: 'opt9',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt9');
    const events = captured();
    const now = Date.now();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c9',
      message_id: 'mD',
      sent_at: new Date(now).toISOString(),
      sender: 'u',
      sender_name: 'Day',
      text: 'daily test',
    });
    noteMessage('discord', 'c9', 'mD', new Date(now).toISOString());

    const { _runDailyCheck } = await import('../window-flusher.js');
    // Pretend it's exactly the daily-flush hour today and we haven't fired.
    const today = new Date(now);
    today.setHours(getDailyFlushHourForTest(), 0, 0, 0);
    _runDailyCheck(today.getTime());

    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('daily');

    // A second call within the same day should NOT fire again.
    _runDailyCheck(today.getTime() + 60_000);
    expect(events).toHaveLength(1);
  });
});

function getDailyFlushHourForTest(): number {
  const h = Number(process.env.WINDOW_DAILY_FLUSH_HOUR ?? '23');
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : 23;
}
