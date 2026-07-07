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

// Mock STORE_DIR so getBrainDb() lands in a temp directory.
let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
  // Keep the exercise SQLite-only — no vector-store cleanup attempts.
  QDRANT_URL: '',
}));

// The P1 pipeline behind raw_events capture embeds every extracted claim
// (the test emails' sender address alone is enough for the cheap-rules
// tier to produce one). Without these mocks the first test triggers a
// real ~140MB transformers model fetch; on a CI runner with a cold HF
// cache that in-flight flush outlives the 10s afterEach hookTimeout,
// because stopBrainIngest() drains the queue, which awaits the model
// load. Same contract as ingest-pipeline.test.ts: never load
// transformers or hit the network from tests.
vi.mock('../embed.js', () => ({
  embedText: vi.fn(async () => new Array(768).fill(0)),
  embedBatch: vi.fn(async (texts: string[]) =>
    texts.map(() => new Array(768).fill(0)),
  ),
  getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
  EMBEDDING_DIMS: 768,
  _resetEmbeddingPipeline: () => {},
}));
vi.mock('../qdrant.js', () => ({
  upsertKu: vi.fn(),
  searchSemantic: vi.fn(),
  ensureBrainCollection: vi.fn(),
  kuPointId: (id: string) => id,
  BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
  _setQdrantClientForTest: () => {},
}));

import { EventBus } from '../../event-bus.js';
import type { EmailReceivedEvent } from '../../events.js';

// Fresh import of ingest per test would require resetModules — simpler to
// build the row-write path directly via the same helper the handler uses,
// but here we want end-to-end coverage so we exercise startBrainIngest with
// the singleton eventBus.
import { eventBus } from '../../event-bus.js';
import { _closeBrainDb, getBrainDb } from '../db.js';
import { startBrainIngest, stopBrainIngest } from '../ingest.js';

function emitEmailEvent(threadId: string, subject = 'hello'): void {
  const event: EmailReceivedEvent = {
    type: 'email.received',
    source: 'email-sse',
    timestamp: Date.now(),
    payload: {
      count: 1,
      emails: [
        {
          thread_id: threadId,
          account: 'work@example.com',
          subject,
          sender: 'alice@example.com',
          snippet: 's',
        },
      ],
      connection: 'test',
    },
  };
  eventBus.emit('email.received', event);
}

async function drainIngest(): Promise<void> {
  // Deterministic drain: the email.received handler enqueues synchronously
  // during emit, and stopBrainIngest() → queue.shutdown() flushes whatever
  // is buffered immediately and awaits the per-row pipeline. No reliance on
  // the queue's 500ms maxLatencyMs timer — the previous fixed 600ms sleep
  // here flaked on slow CI runners (same fixed-sleep class as #89).
  // startBrainIngest()/stopBrainIngest() are restart-safe, so afterEach's
  // second stop is a no-op.
  await stopBrainIngest();
}

describe('brain ingest → raw_events', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ingest-'));
  });

  afterEach(async () => {
    await stopBrainIngest();
    _closeBrainDb();
    // Best-effort cleanup of the whole event bus listeners so a stale
    // handler from a prior test doesn't fire on the singleton.
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts one raw_events row per unique email thread', async () => {
    startBrainIngest();
    emitEmailEvent('thread-A');
    await drainIngest();

    const db = getBrainDb();
    const rows = db
      .prepare(`SELECT source_type, source_ref, processed_at FROM raw_events`)
      .all() as {
      source_type: string;
      source_ref: string;
      processed_at: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_type).toBe('email');
    expect(rows[0].source_ref).toBe('thread-A');
    // After a full drain the P1 pipeline has completed, so the row must be
    // stamped processed. (Asserting NULL here — "captured but not yet
    // processed" — was inherently racy: it only held while the pipeline
    // happened to still be in flight.)
    expect(rows[0].processed_at).not.toBeNull();
  });

  it('is idempotent on (source_type, source_ref) — duplicate thread_id yields one row', async () => {
    startBrainIngest();
    emitEmailEvent('thread-B');
    emitEmailEvent('thread-B');
    emitEmailEvent('thread-B');
    await drainIngest();

    const db = getBrainDb();
    const count = db
      .prepare(`SELECT COUNT(*) as n FROM raw_events WHERE source_ref = ?`)
      .get('thread-B') as { n: number };
    expect(count.n).toBe(1);
  });

  it('stores payload as a BLOB containing the serialized email JSON', async () => {
    startBrainIngest();
    emitEmailEvent('thread-C', 'important subject');
    await drainIngest();

    const db = getBrainDb();
    const row = db
      .prepare(`SELECT payload FROM raw_events WHERE source_ref = ?`)
      .get('thread-C') as { payload: Buffer };
    expect(Buffer.isBuffer(row.payload)).toBe(true);
    const parsed = JSON.parse(row.payload.toString('utf8'));
    expect(parsed.thread_id).toBe('thread-C');
    expect(parsed.subject).toBe('important subject');
  });

  it('does not crash if thread_id is missing — the bad entry is skipped', async () => {
    startBrainIngest();
    const bus = eventBus as unknown as EventBus;
    bus.emit('email.received', {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {
        count: 1,
        emails: [
          // @ts-expect-error deliberately missing thread_id
          {
            account: 'w',
            subject: 's',
            sender: 'a',
          },
        ],
        connection: 'test',
      },
    });
    await drainIngest();

    const db = getBrainDb();
    const count = db.prepare(`SELECT COUNT(*) as n FROM raw_events`).get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
