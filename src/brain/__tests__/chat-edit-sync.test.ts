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

let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmp;
  },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import { findRawEventsForMessage } from '../chat-edit-sync.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-edit-sync-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chat-edit-sync — findRawEventsForMessage', () => {
  it('finds single-message raw_events by exact source_ref', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_message', ?, ?, ?)`,
    ).run('r1', 'group-X:msg-1', Buffer.from('{}'), '2026-04-27T00:00:00Z');
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_message', ?, ?, ?)`,
    ).run('r2', 'group-X:msg-2', Buffer.from('{}'), '2026-04-27T00:00:00Z');

    const hits = findRawEventsForMessage(db, 'signal', 'group-X', 'msg-1');
    expect(hits.map((r) => r.id)).toEqual(['r1']);
  });

  it('finds windowed raw_events when payload.message_ids includes the id', () => {
    const db = getBrainDb();
    const evtPayload = JSON.stringify({
      message_ids: ['msg-1', 'msg-2', 'msg-3'],
    });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_window', ?, ?, ?)`,
    ).run(
      'w1',
      'group-X:2026-04-27T00:00:00.000Z',
      Buffer.from(evtPayload),
      '2026-04-27T00:00:00Z',
    );
    const hits = findRawEventsForMessage(db, 'signal', 'group-X', 'msg-2');
    expect(hits.map((r) => r.id)).toEqual(['w1']);
  });

  it('returns empty array when no match', () => {
    const db = getBrainDb();
    const hits = findRawEventsForMessage(db, 'discord', 'no-chan', 'no-msg');
    expect(hits).toEqual([]);
  });

  it('rejects false-positive LIKE match where the id appears in another field', () => {
    const db = getBrainDb();
    // Payload mentions "msg-2" as a string elsewhere but NOT in message_ids.
    const trickyPayload = JSON.stringify({
      message_ids: ['msg-9', 'msg-10'],
      transcript: 'discussion about msg-2 happened earlier',
    });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_window', ?, ?, ?)`,
    ).run('w2', 'group-Y:2026-04-27T00:00:00.000Z', Buffer.from(trickyPayload), '2026-04-27T00:00:00Z');
    const hits = findRawEventsForMessage(db, 'signal', 'group-Y', 'msg-2');
    expect(hits).toEqual([]);
  });

  it('matches both single-message and windowed rows in the same query', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'discord_message', ?, ?, ?)`,
    ).run('s1', 'chan-A:msg-X', Buffer.from('{}'), '2026-04-27T00:00:00Z');
    const winPayload = JSON.stringify({ message_ids: ['msg-X', 'msg-Y'] });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'discord_window', ?, ?, ?)`,
    ).run('w3', 'chan-A:2026-04-27T00:00:00.000Z', Buffer.from(winPayload), '2026-04-27T00:00:00Z');
    const hits = findRawEventsForMessage(db, 'discord', 'chan-A', 'msg-X');
    expect(hits.map((r) => r.id).sort()).toEqual(['s1', 'w3']);
  });

  it('respects platform — does not cross-match between signal and discord', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_message', ?, ?, ?)`,
    ).run('s1', 'chat-1:msg-1', Buffer.from('{}'), '2026-04-27T00:00:00Z');
    const hits = findRawEventsForMessage(db, 'discord', 'chat-1', 'msg-1');
    expect(hits).toEqual([]);
  });
});
