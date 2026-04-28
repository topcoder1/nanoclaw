/**
 * Integration test for chat.message.saved → raw_events → extract → KU.
 *
 * Mirrors the bootstrap pattern from ingest-pipeline.test.ts:
 * mocks embed.js, qdrant.js; uses an isolated tmpDir brain.db; and
 * drives the pipeline end-to-end via eventBus.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

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

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
  QDRANT_URL: '',
}));

const { embedMock, qdrantUpsertMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  qdrantUpsertMock: vi.fn(),
}));

vi.mock('../embed.js', () => ({
  embedText: embedMock,
  embedBatch: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 768 }, () => 0.01)),
  ),
  getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
  EMBEDDING_DIMS: 768,
  _resetEmbeddingPipeline: () => {},
}));
vi.mock('../qdrant.js', () => ({
  upsertKu: qdrantUpsertMock,
  searchSemantic: vi.fn(),
  ensureBrainCollection: vi.fn(),
  BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
  _setQdrantClientForTest: () => {},
  kuPointId: vi.fn((id: string) => id),
}));

import { eventBus } from '../../event-bus.js';
import type { ChatMessageSavedEvent } from '../../events.js';
import { _closeBrainDb, getBrainDb } from '../db.js';
import { _shutdownEntityQueue } from '../entities.js';
import { startChatIngest, stopChatIngest } from '../chat-ingest.js';

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('chat-ingest', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-chat-ingest-'));
    embedMock.mockReset();
    qdrantUpsertMock.mockReset();
    const fakeVec = Array.from({ length: 768 }, () => 0.01);
    embedMock.mockResolvedValue(fakeVec);
    qdrantUpsertMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    stopChatIngest();
    await _shutdownEntityQueue();
    _closeBrainDb();
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts a raw_events row and produces a knowledge_unit for a saved chat message', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [
        {
          text: 'Launch moved to next Wednesday',
          topic_seed: 'launch date',
          entities_mentioned: [],
          confidence: 0.9,
        },
      ],
      inputTokens: 50,
      outputTokens: 20,
    }));

    startChatIngest({ llmCaller: fakeLlm });

    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      source: 'discord',
      payload: {},
      platform: 'discord',
      chat_id: 'channel-1',
      message_id: 'msg-7',
      sender: '123456789012345678', // snowflake
      sender_display: 'Alice',
      sent_at: '2026-04-27T12:00:00.000Z',
      text: "ok let's call it — launch = next Wed",
      trigger: 'emoji',
    };

    eventBus.emit('chat.message.saved', evt);
    await wait(1500);

    const db = getBrainDb();

    const raw = db
      .prepare(`SELECT * FROM raw_events WHERE source_type = 'discord_message'`)
      .get() as { source_ref: string } | undefined;
    expect(raw).toBeDefined();
    expect(raw!.source_ref).toBe('channel-1:msg-7');

    const ku = db
      .prepare(
        `SELECT * FROM knowledge_units WHERE source_type = 'discord_message'`,
      )
      .get() as { text: string } | undefined;
    expect(ku).toBeDefined();
    expect(ku!.text).toContain('Launch');

    expect(qdrantUpsertMock).toHaveBeenCalledOnce();
  });

  it('dedups via raw_events UNIQUE — same message twice produces one raw_event', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [],
      inputTokens: 10,
      outputTokens: 5,
    }));

    startChatIngest({ llmCaller: fakeLlm });

    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      source: 'signal',
      payload: {},
      platform: 'signal',
      chat_id: '+1555',
      message_id: '1714000000000',
      sender: '+15550001111',
      sent_at: '2026-04-27T12:00:00.000Z',
      text: 'hello',
      trigger: 'text',
    };

    eventBus.emit('chat.message.saved', evt);
    eventBus.emit('chat.message.saved', evt);
    await wait(1500);

    const db = getBrainDb();
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM raw_events WHERE source_type = 'signal_message'`,
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('creates a person entity for the sender and links it to the KU', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [
        {
          text: 'Budget approved for Q3',
          topic_seed: 'budget approval',
          entities_mentioned: [],
          confidence: 0.85,
        },
      ],
      inputTokens: 40,
      outputTokens: 15,
    }));

    startChatIngest({ llmCaller: fakeLlm });

    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      source: 'discord',
      payload: {},
      platform: 'discord',
      chat_id: 'channel-2',
      message_id: 'msg-99',
      sender: '987654321098765432', // snowflake
      sender_display: 'Bob',
      sent_at: '2026-04-27T13:00:00.000Z',
      text: 'budget approved for Q3',
      trigger: 'text',
    };

    eventBus.emit('chat.message.saved', evt);
    await wait(1500);

    const db = getBrainDb();

    const person = db
      .prepare(`SELECT entity_id FROM entities WHERE entity_type = 'person'`)
      .get() as { entity_id: string } | undefined;
    expect(person).toBeDefined();

    const link = db
      .prepare(`SELECT ku_id, entity_id FROM ku_entities`)
      .get() as { ku_id: string; entity_id: string } | undefined;
    expect(link).toBeDefined();
    expect(link!.entity_id).toBe(person!.entity_id);
  });

  it('SQLite KU row survives even if Qdrant upsert throws', async () => {
    qdrantUpsertMock.mockRejectedValue(new Error('qdrant down'));

    const fakeLlm = vi.fn(async () => ({
      claims: [
        {
          text: 'Meeting rescheduled to Thursday',
          topic_seed: 'meeting schedule',
          entities_mentioned: [],
          confidence: 0.8,
        },
      ],
      inputTokens: 30,
      outputTokens: 12,
    }));

    startChatIngest({ llmCaller: fakeLlm });

    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      source: 'signal',
      payload: {},
      platform: 'signal',
      chat_id: '+19999',
      message_id: 'msg-qdrant-fail',
      sender: '+19991234567',
      sent_at: '2026-04-27T14:00:00.000Z',
      text: 'meeting rescheduled to Thursday',
      trigger: 'text',
    };

    eventBus.emit('chat.message.saved', evt);
    await wait(1500);

    const db = getBrainDb();
    const kuCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_units WHERE source_type = 'signal_message'`,
        )
        .get() as { n: number }
    ).n;
    expect(kuCount).toBeGreaterThan(0);

    const raw = db
      .prepare(
        `SELECT processed_at, process_error FROM raw_events WHERE source_ref = '+19999:msg-qdrant-fail'`,
      )
      .get() as { processed_at: string | null; process_error: string | null };
    expect(raw.processed_at).not.toBeNull();
    expect(raw.process_error).toBeNull();
  });

  it('inserts raw_events + KUs + participant links for a flushed window', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [
        {
          text: 'Decided to go with Vendor A for Q3',
          topic_seed: 'vendor selection',
          entities_mentioned: [],
          confidence: 0.9,
        },
        {
          text: 'Vendor B rejected — pricing model incompatible',
          topic_seed: 'vendor rejection',
          entities_mentioned: [],
          confidence: 0.85,
        },
      ],
      inputTokens: 200,
      outputTokens: 80,
    }));

    startChatIngest({ llmCaller: fakeLlm });

    const evt = {
      type: 'chat.window.flushed' as const,
      source: 'signal' as const,
      timestamp: Date.now(),
      payload: {},
      platform: 'signal' as const,
      chat_id: 'group-xyz',
      window_started_at: '2026-04-27T14:00:00.000Z',
      window_ended_at: '2026-04-27T14:32:00.000Z',
      message_count: 18,
      transcript: '[14:00] Alice: ...\n[14:32] Bob: ...',
      message_ids: ['m1', 'm2', 'm3'],
      participants: ['Alice', 'Bob'],
      flush_reason: 'idle' as const,
      group_folder: 'opt-window',
    };

    eventBus.emit('chat.window.flushed', evt);
    await wait(1500);

    const db = getBrainDb();

    const raw = db
      .prepare(`SELECT * FROM raw_events WHERE source_type = 'signal_window'`)
      .get() as { source_ref: string; payload: Buffer } | undefined;
    expect(raw).toBeDefined();
    expect(raw!.source_ref).toBe('group-xyz:2026-04-27T14:00:00.000Z');
    const payload = JSON.parse(raw!.payload.toString('utf8'));
    expect(payload.message_ids).toEqual(['m1', 'm2', 'm3']);

    const kuCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_units WHERE source_type = 'signal_window'`,
        )
        .get() as { n: number }
    ).n;
    expect(kuCount).toBe(2);

    // Both participants exist as person entities, and every KU links to both.
    const linkRows = db
      .prepare(
        `SELECT ku_id, entity_id FROM ku_entities
         WHERE ku_id IN (SELECT id FROM knowledge_units WHERE source_type='signal_window')`,
      )
      .all() as Array<{ ku_id: string; entity_id: string }>;
    expect(linkRows.length).toBe(4); // 2 KUs × 2 participants

    expect(qdrantUpsertMock).toHaveBeenCalledTimes(2);
  });

  it('a saved message inside an open window is recorded as excluded', async () => {
    // Mock noteSave to confirm the chat-ingest handler calls it.
    const noteSaveSpy = vi.fn();
    vi.doMock('../window-flusher.js', async () => {
      const real = await vi.importActual<typeof import('../window-flusher.js')>(
        '../window-flusher.js',
      );
      return { ...real, noteSave: noteSaveSpy };
    });
    // Re-import chat-ingest so it picks up the mocked noteSave.
    vi.resetModules();
    const { startChatIngest: startMocked, stopChatIngest: stopMocked } =
      await import('../chat-ingest.js');
    const { eventBus: mockedBus } = await import('../../event-bus.js');

    const fakeLlm = vi.fn(async () => ({
      claims: [],
      inputTokens: 10,
      outputTokens: 5,
    }));
    startMocked({ llmCaller: fakeLlm });

    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      source: 'discord',
      payload: {},
      platform: 'discord',
      chat_id: 'channel-race',
      message_id: 'msg-race',
      sender: 'u-race',
      sent_at: '2026-04-27T16:00:00.000Z',
      text: 'race-test',
      trigger: 'emoji',
    };
    mockedBus.emit('chat.message.saved', evt);
    await wait(1500);
    stopMocked();

    expect(noteSaveSpy).toHaveBeenCalledWith(
      'discord',
      'channel-race',
      'msg-race',
    );

    vi.doUnmock('../window-flusher.js');
  });

  it('window flush dedups via raw_events UNIQUE — same window_started_at twice yields one row', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [],
      inputTokens: 10,
      outputTokens: 5,
    }));
    startChatIngest({ llmCaller: fakeLlm });

    const evt = {
      type: 'chat.window.flushed' as const,
      source: 'discord' as const,
      timestamp: Date.now(),
      payload: {},
      platform: 'discord' as const,
      chat_id: 'channel-dup',
      window_started_at: '2026-04-27T15:00:00.000Z',
      window_ended_at: '2026-04-27T15:15:00.000Z',
      message_count: 1,
      transcript: '[15:00] X: hi',
      message_ids: ['m1'],
      participants: ['X'],
      flush_reason: 'idle' as const,
      group_folder: 'opt-dup',
    };

    eventBus.emit('chat.window.flushed', evt);
    eventBus.emit('chat.window.flushed', evt);
    await wait(1500);

    const db = getBrainDb();
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM raw_events WHERE source_type='discord_window'`,
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});
