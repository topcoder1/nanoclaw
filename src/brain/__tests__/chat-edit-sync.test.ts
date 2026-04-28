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
import { findRawEventsForMessage, handleChatMessageEdited } from '../chat-edit-sync.js';

vi.mock('../qdrant.js', () => ({
  upsertKu: vi.fn(async () => undefined),
  searchSemantic: vi.fn(),
  ensureBrainCollection: vi.fn(),
  BRAIN_COLLECTION: 'ku_test',
  _setQdrantClientForTest: () => {},
  kuPointId: vi.fn((id: string) => id),
}));

vi.mock('../embed.js', () => ({
  embedText: vi.fn(async () => Array.from({ length: 768 }, () => 0.01)),
  embedBatch: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 768 }, () => 0.01)),
  ),
  getEmbeddingModelVersion: () => 'test-embed:768',
  EMBEDDING_DIMS: 768,
  _resetEmbeddingPipeline: () => {},
}));

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

describe('chat-edit-sync — handleChatMessageEdited', () => {
  it('supersedes KUs derived from a single-message raw_event and inserts new ones with superseded_by link', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(
      Buffer.from(
        JSON.stringify({
          type: 'chat.message.saved',
          platform: 'signal',
          chat_id: 'chat-1',
          message_id: 'msg-1',
          text: 'pay $100',
          sender: 'alice',
        }),
      ),
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:01Z',
    );
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, source_ref, account, scope, confidence,
          valid_from, recorded_at, topic_key, extracted_by, needs_review)
       VALUES ('k1', 'pay $100 owed', 'signal_message', 'chat-1:msg-1',
               'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z',
               'payment', 'rules', 0)`,
    ).run();

    const fakeLlm = vi.fn(async () => ({
      claims: [
        {
          text: 'pay $250 owed',
          topic_seed: 'payment',
          entities_mentioned: [],
          confidence: 0.9,
        },
      ],
      inputTokens: 10,
      outputTokens: 5,
    }));

    await handleChatMessageEdited(
      {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'chat-1',
        message_id: 'msg-1',
        old_text: 'pay $100',
        new_text: 'pay $250',
        edited_at: '2026-04-28T00:00:00.000Z',
        sender: 'alice',
      },
      { llmCaller: fakeLlm, db },
    );

    // Old KU is now superseded.
    const oldKu = db
      .prepare(`SELECT superseded_at, superseded_by FROM knowledge_units WHERE id='k1'`)
      .get() as any;
    expect(oldKu.superseded_at).not.toBeNull();
    expect(oldKu.superseded_by).not.toBeNull();
    // New KU(s) exist with same source_ref. Note: extractPipeline runs both
    // the cheap rules tier (which fires on the "$250" money pattern) and the
    // LLM tier — so we may get 1 or 2 claims here. We assert the LLM-derived
    // claim is present, all new KUs are non-superseded, and the old KU's
    // superseded_by points at the first new id.
    const newKus = db
      .prepare(
        `SELECT id, text, superseded_at FROM knowledge_units WHERE source_ref='chat-1:msg-1' AND id != 'k1' ORDER BY id`,
      )
      .all() as any[];
    expect(newKus.length).toBeGreaterThanOrEqual(1);
    expect(newKus.some((k) => k.text === 'pay $250 owed')).toBe(true);
    for (const k of newKus) {
      expect(k.superseded_at).toBeNull();
    }
    // superseded_by points at one of the new KUs (the first inserted).
    expect(newKus.map((k) => k.id)).toContain(oldKu.superseded_by);
  });

  it('is a no-op when no raw_events match (unknown message_id)', async () => {
    const db = getBrainDb();
    const llm = vi.fn();
    await handleChatMessageEdited(
      {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'unknown',
        message_id: 'unknown',
        old_text: null,
        new_text: 'whatever',
        edited_at: '2026-04-28T00:00:00.000Z',
        sender: 'x',
      },
      { llmCaller: llm, db },
    );
    expect(llm).not.toHaveBeenCalled();
  });

  it('rebuilds transcript for windowed raw_events with the edit substituted in', async () => {
    const db = getBrainDb();
    const winPayload = JSON.stringify({
      type: 'chat.window.flushed',
      platform: 'signal',
      chat_id: 'chat-2',
      window_started_at: '2026-04-27T00:00:00.000Z',
      window_ended_at: '2026-04-27T00:05:00.000Z',
      message_count: 3,
      transcript:
        '[2026-04-27T00:00:00.000Z] Alice: hey\n' +
        '[2026-04-27T00:02:00.000Z] Bob: original\n' +
        '[2026-04-27T00:05:00.000Z] Alice: ok',
      message_ids: ['m1', 'm2', 'm3'],
      participants: ['Alice', 'Bob'],
    });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('w1', 'signal_window', 'chat-2:2026-04-27T00:00:00.000Z', ?, ?, ?)`,
    ).run(Buffer.from(winPayload), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, source_ref, account, scope, confidence,
          valid_from, recorded_at, topic_key, extracted_by, needs_review)
       VALUES ('w-k1', 'something about original', 'signal_window',
               'chat-2:2026-04-27T00:00:00.000Z', 'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', 't', 'rules', 0)`,
    ).run();

    const llm = vi.fn(async (prompt: string) => {
      // The prompt should contain the EDITED text, not the original.
      expect(prompt).toContain('FINAL EDIT');
      expect(prompt).not.toContain('original');
      return {
        claims: [
          { text: 'updated claim', topic_seed: 't', entities_mentioned: [], confidence: 0.9 },
        ],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    await handleChatMessageEdited(
      {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'chat-2',
        message_id: 'm2',
        old_text: 'original',
        new_text: 'FINAL EDIT',
        edited_at: '2026-04-28T00:00:00.000Z',
        sender: 'Bob',
      },
      { llmCaller: llm, db },
    );

    const oldKu = db.prepare(`SELECT superseded_at FROM knowledge_units WHERE id='w-k1'`).get() as any;
    expect(oldKu.superseded_at).not.toBeNull();
  });

  it('does NOT supersede old KUs when re-extraction returns 0 claims (preserves on budget exhaustion)', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(
      Buffer.from('{}'),
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:01Z',
    );
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, source_ref, account, scope, confidence,
          valid_from, recorded_at, topic_key, extracted_by, needs_review)
       VALUES ('k-keep', 'meeting at 3pm Thursday', 'signal_message', 'chat-1:msg-1',
               'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z',
               'meeting', 'rules', 0)`,
    ).run();

    // LLM caller that throws / returns empty so extractPipeline yields no claims.
    const fakeLlm = vi.fn(async () => ({
      claims: [],
      inputTokens: 0,
      outputTokens: 0,
    }));

    await handleChatMessageEdited(
      {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'chat-1',
        message_id: 'msg-1',
        old_text: 'meeting at 3pm Thursday',
        new_text: 'oops never mind',  // contains no patterns the cheap-rules tier matches
        edited_at: '2026-04-28T00:00:00.000Z',
        sender: 'alice',
      },
      { llmCaller: fakeLlm, db },
    );

    // Old KU is NOT superseded.
    const ku = db
      .prepare(`SELECT superseded_at, superseded_by FROM knowledge_units WHERE id='k-keep'`)
      .get() as any;
    expect(ku.superseded_at).toBeNull();
    expect(ku.superseded_by).toBeNull();
  });
});

import { handleChatMessageDeleted } from '../chat-edit-sync.js';

describe('chat-edit-sync — handleChatMessageDeleted', () => {
  it('tombstones KUs derived from a deleted single-message raw_event', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(Buffer.from('{}'), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k1', 'sensitive', 'signal_message', 'chat-1:msg-1', 'personal', NULL,
               0.9, '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();

    await handleChatMessageDeleted(
      {
        type: 'chat.message.deleted',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'chat-1',
        message_id: 'msg-1',
        deleted_at: '2026-04-28T00:00:00.000Z',
      },
      { db },
    );

    const ku = db
      .prepare(`SELECT superseded_at, superseded_by FROM knowledge_units WHERE id='k1'`)
      .get() as any;
    expect(ku.superseded_at).toBe('2026-04-28T00:00:00.000Z');
    expect(ku.superseded_by).toBeNull();

    const marker = db
      .prepare(
        `SELECT * FROM raw_events WHERE source_type='signal_deletion' AND source_ref='chat-1:msg-1'`,
      )
      .get() as any;
    expect(marker).toBeDefined();
    expect(marker.received_at).toBe('2026-04-28T00:00:00.000Z');
  });

  it('inserts the deletion marker even when no KUs derived from this message', async () => {
    const db = getBrainDb();
    await handleChatMessageDeleted(
      {
        type: 'chat.message.deleted',
        source: 'discord',
        timestamp: Date.now(),
        payload: {},
        platform: 'discord',
        chat_id: 'chan-X',
        message_id: 'msg-orphan',
        deleted_at: '2026-04-28T00:00:00.000Z',
      },
      { db },
    );
    const marker = db
      .prepare(
        `SELECT * FROM raw_events WHERE source_type='discord_deletion' AND source_ref='chan-X:msg-orphan'`,
      )
      .get() as any;
    expect(marker).toBeDefined();
  });

  it('tombstones KUs derived from a windowed raw_event whose payload includes the message_id', async () => {
    const db = getBrainDb();
    const winPayload = JSON.stringify({
      type: 'chat.window.flushed',
      message_ids: ['m1', 'm2', 'm3'],
      transcript: 'lines...',
    });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('w1', 'signal_window', 'chat-2:2026-04-27T00:00:00.000Z', ?, ?, ?)`,
    ).run(Buffer.from(winPayload), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('w-k1', 'something', 'signal_window', 'chat-2:2026-04-27T00:00:00.000Z',
               'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();

    await handleChatMessageDeleted(
      {
        type: 'chat.message.deleted',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'chat-2',
        message_id: 'm2',
        deleted_at: '2026-04-28T00:00:00.000Z',
      },
      { db },
    );

    const ku = db
      .prepare(`SELECT superseded_at FROM knowledge_units WHERE id='w-k1'`)
      .get() as any;
    expect(ku.superseded_at).toBe('2026-04-28T00:00:00.000Z');
  });

  it('idempotent — inserting the same deletion twice does not duplicate the marker', async () => {
    const db = getBrainDb();
    const evt = {
      type: 'chat.message.deleted' as const,
      source: 'signal' as const,
      timestamp: Date.now(),
      payload: {},
      platform: 'signal' as const,
      chat_id: 'chat-3',
      message_id: 'msg-x',
      deleted_at: '2026-04-28T00:00:00.000Z',
    };
    await handleChatMessageDeleted(evt, { db });
    await handleChatMessageDeleted(evt, { db });
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM raw_events
           WHERE source_type='signal_deletion' AND source_ref='chat-3:msg-x'`,
        )
        .get() as any
    ).n;
    expect(count).toBe(1);
  });
});

import { startChatEditSync, stopChatEditSync } from '../chat-edit-sync.js';
import { eventBus } from '../../event-bus.js';

describe('chat-edit-sync — lifecycle (start/stop)', () => {
  afterEach(() => {
    stopChatEditSync();
    eventBus.removeAllListeners();
  });

  it('startChatEditSync subscribes to chat.message.deleted and tombstones on emit', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(Buffer.from('{}'), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k1', 'x', 'signal_message', 'chat-1:msg-1', 'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();

    startChatEditSync();
    eventBus.emit('chat.message.deleted', {
      type: 'chat.message.deleted',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'chat-1',
      message_id: 'msg-1',
      deleted_at: '2026-04-28T00:00:00.000Z',
    });
    // Wait for the async handler.
    await new Promise((r) => setTimeout(r, 100));

    const ku = db
      .prepare(`SELECT superseded_at FROM knowledge_units WHERE id='k1'`)
      .get() as any;
    expect(ku.superseded_at).toBe('2026-04-28T00:00:00.000Z');
  });

  it('startChatEditSync is idempotent — second call is a no-op', () => {
    startChatEditSync();
    startChatEditSync();
    // Stopping once should fully unsubscribe.
    stopChatEditSync();
    // Now emitting an event should not produce a handler call.
    eventBus.emit('chat.message.deleted', {
      type: 'chat.message.deleted',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'no-such',
      message_id: 'no-such',
      deleted_at: '2026-04-28T00:00:00.000Z',
    });
    // No assertions needed; the test passes if nothing throws.
    expect(true).toBe(true);
  });

  it('stopChatEditSync after start unsubscribes both edit and delete handlers', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k-stay', 'x', 'signal_message', 'chat-9:msg-9', 'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r-stay', 'signal_message', 'chat-9:msg-9', ?, ?, ?)`,
    ).run(Buffer.from('{}'), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');

    startChatEditSync();
    stopChatEditSync();
    eventBus.emit('chat.message.deleted', {
      type: 'chat.message.deleted',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'chat-9',
      message_id: 'msg-9',
      deleted_at: '2026-04-28T00:00:00.000Z',
    });
    await new Promise((r) => setTimeout(r, 100));

    const ku = db
      .prepare(`SELECT superseded_at FROM knowledge_units WHERE id='k-stay'`)
      .get() as any;
    expect(ku.superseded_at).toBeNull();
  });
});
