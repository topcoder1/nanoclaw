/**
 * Integration test for the upgraded P1 ingest pipeline.
 *
 * Mocks embed.js, qdrant.js, and extract.js's LLM caller so we can drive
 * the pipeline end-to-end without loading transformers or hitting network.
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
}));

const { embedMock, embedBatchMock, qdrantUpsertMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  embedBatchMock: vi.fn(),
  qdrantUpsertMock: vi.fn(),
}));

vi.mock('../embed.js', () => ({
  embedText: embedMock,
  embedBatch: embedBatchMock,
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
}));

import { eventBus } from '../../event-bus.js';
import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  setBrainBodyFetcher,
  startBrainIngest,
  stopBrainIngest,
} from '../ingest.js';
import {
  EMAILS_SEEN_KEY,
  LAST_INGEST_EVENT_KEY,
  getSystemCounter,
  getSystemState,
} from '../metrics.js';

function emit(threadId: string, subject: string, text: string): void {
  eventBus.emit('email.received', {
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
          sender: 'alice@acme.co',
          snippet: text,
        },
      ],
      connection: 'test',
    },
  });
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('brain/ingest — P1 pipeline integration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p1-pipe-'));
    embedMock.mockReset();
    embedBatchMock.mockReset();
    qdrantUpsertMock.mockReset();
    const fakeVec = Array.from({ length: 768 }, () => 0.01);
    embedMock.mockResolvedValue(fakeVec);
    // embedBatch returns one vector per input text. Default behaviour
    // mirrors the production shape so any number of claims gets embedded.
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => fakeVec),
    );
    qdrantUpsertMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopBrainIngest();
    setBrainBodyFetcher(null);
    _closeBrainDb();
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses embedBatch (one model invocation) for multi-claim emails — falls back to per-claim on batch error', async () => {
    // Force the batch path to fail so the fallback kicks in. Each
    // per-claim call should still produce a vector and a Qdrant upsert.
    embedBatchMock.mockRejectedValueOnce(new Error('batch model down'));

    startBrainIngest();
    emit(
      'thread-batch-fallback',
      'Multi-claim email',
      'Quote $5,000 due Friday. Call +1 555 222 3333. See https://acme.co/x.',
    );
    await wait(1500);

    // The batch path was attempted exactly once.
    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    // Per-claim fallback ran once per claim — must be > 0.
    expect(embedMock.mock.calls.length).toBeGreaterThan(0);
    // Every successful per-claim embed produced a Qdrant upsert.
    expect(qdrantUpsertMock).toHaveBeenCalled();
  });

  it('batches embeds in a single call when the model is healthy (no fallback)', async () => {
    startBrainIngest();
    emit(
      'thread-batch-happy',
      'Multi-claim healthy',
      'Quote $7,000 due Monday. Call +1 555 444 5555. See https://acme.co/y.',
    );
    await wait(1500);

    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    // No per-claim fallback when the batch path succeeds.
    expect(embedMock).not.toHaveBeenCalled();
    expect(qdrantUpsertMock).toHaveBeenCalled();
  });

  it('persists raw_events, runs cheap-rules extraction, creates KU + entities, and embeds to Qdrant', async () => {
    startBrainIngest();
    // Email rich with signals so cheap rules generate a claim.
    emit(
      'thread-pipeline',
      'Deal deal_42 follow-up',
      'Quote is $12,500 for renewal. Call me at +1 555 111 2222. See https://acme.co.',
    );
    await wait(1500);

    const db = getBrainDb();
    const raw = db
      .prepare(
        `SELECT processed_at, process_error FROM raw_events WHERE source_ref = 'thread-pipeline'`,
      )
      .get() as { processed_at: string | null; process_error: string | null };
    expect(raw.processed_at).not.toBeNull();
    expect(raw.process_error).toBeNull();

    const kus = db.prepare(`SELECT id, text FROM knowledge_units`).all() as {
      id: string;
      text: string;
    }[];
    expect(kus.length).toBeGreaterThan(0);

    // Entities were created from the sender's email + domain.
    const people = db
      .prepare(`SELECT entity_id FROM entities WHERE entity_type = 'person'`)
      .all();
    const companies = db
      .prepare(`SELECT entity_id FROM entities WHERE entity_type = 'company'`)
      .all();
    expect(people.length).toBeGreaterThan(0);
    expect(companies.length).toBeGreaterThan(0);

    const links = db
      .prepare(`SELECT ku_id, entity_id FROM ku_entities`)
      .all() as { ku_id: string; entity_id: string }[];
    expect(links.length).toBeGreaterThan(0);

    // Embed + upsert both happened. Happy-path uses embedBatch (one
    // model invocation per email); per-claim embedText only runs as a
    // fallback when batch fails.
    expect(embedBatchMock).toHaveBeenCalled();
    expect(qdrantUpsertMock).toHaveBeenCalled();
    const firstUpsert = qdrantUpsertMock.mock.calls[0][0];
    expect(firstUpsert.payload.model_version).toBe('nomic-embed-text-v1.5:768');
  });

  it('each email.received bumps the SSE→brain canary counter (independent of raw_events)', async () => {
    startBrainIngest();
    emit('thread-canary-1', 'Subj 1', 'body 1');
    emit('thread-canary-2', 'Subj 2', 'body 2');
    // Duplicate thread id — raw_events insert is deduped by the UNIQUE
    // constraint, but the canary must still bump (it measures events
    // SEEN by ingest, not rows written).
    emit('thread-canary-1', 'Subj 1 dup', 'body 1 dup');
    await wait(1500);

    const db = getBrainDb();
    const rawCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM raw_events`).get() as { n: number }
    ).n;
    // Two distinct thread ids → two raw_events rows.
    expect(rawCount).toBe(2);

    const counter = getSystemCounter(EMAILS_SEEN_KEY);
    // Three emails flowed past ingest → counter == 3.
    expect(counter.count).toBe(3);

    const last = getSystemState(LAST_INGEST_EVENT_KEY);
    expect(last).not.toBeNull();
  });

  it('uses full body from fetcher when SSE only carries snippet (the securenote-URL bug)', async () => {
    const fullBody =
      'Hi team, the credentials are at https://securenote.app/view/ABC123#xyz — please update CI by Friday. Quote: $4,200 for renewal.';
    const fetcher = vi.fn(async () => fullBody);
    setBrainBodyFetcher(fetcher);

    startBrainIngest();
    // SSE-style payload — only the truncated snippet is on the wire.
    emit(
      'thread-fullbody',
      'CI credentials follow-up',
      'Hi team, the credentials are at https://secur',
    );
    await wait(1500);

    expect(fetcher).toHaveBeenCalledWith('work@example.com', 'thread-fullbody');

    const db = getBrainDb();
    const kus = db
      .prepare(`SELECT text FROM knowledge_units WHERE source_ref = ?`)
      .all('thread-fullbody') as { text: string }[];
    expect(kus.length).toBeGreaterThan(0);
    // Cheap-rules extracts URLs and currency amounts. The snippet alone
    // would not include "$4,200" or the full URL — proves the fetcher
    // body reached the extractor.
    const blob = kus.map((k) => k.text).join('\n');
    expect(blob).toMatch(/4,?200|\$4200/);
  });

  it('persists fetched body into raw_events.payload so reprocess sees full content', async () => {
    const fullBody =
      'Full body with key URL https://acme.co/secret and quote $3,750 inside.';
    setBrainBodyFetcher(async () => fullBody);

    startBrainIngest();
    emit(
      'thread-payload-persist',
      'Body persistence test',
      'truncated snippet only',
    );
    await wait(1500);

    const db = getBrainDb();
    const row = db
      .prepare(
        `SELECT payload FROM raw_events WHERE source_ref = 'thread-payload-persist'`,
      )
      .get() as { payload: Buffer };
    const parsed = JSON.parse(row.payload.toString('utf8'));
    // The pre-fix payload would only contain `snippet`. Post-fix, the
    // fetched body is round-tripped into the payload BLOB so reprocess
    // / export workflows see the full text.
    expect(parsed.body).toBe(fullBody);
    expect(parsed.snippet).toBe('truncated snippet only');
  });

  it('falls back to snippet when fetcher throws — does not break ingestion', async () => {
    setBrainBodyFetcher(async () => {
      throw new Error('gmail api 500');
    });

    startBrainIngest();
    emit(
      'thread-fetcher-fail',
      'Quick note',
      'Renewal quoted at $9,000 — confirm by EOW.',
    );
    await wait(1500);

    const db = getBrainDb();
    const raw = db
      .prepare(
        `SELECT processed_at, process_error FROM raw_events WHERE source_ref = 'thread-fetcher-fail'`,
      )
      .get() as { processed_at: string | null; process_error: string | null };
    expect(raw.processed_at).not.toBeNull();
    expect(raw.process_error).toBeNull();
    const kuCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_units WHERE source_ref = 'thread-fetcher-fail'`,
        )
        .get() as { n: number }
    ).n;
    expect(kuCount).toBeGreaterThan(0);
  });

  it('SQLite row survives even if Qdrant upsert throws', async () => {
    qdrantUpsertMock.mockRejectedValue(new Error('qdrant down'));
    startBrainIngest();
    emit(
      'thread-qdrant-fail',
      'Deal deal_77 nudge',
      'Renewal $5,000 this month.',
    );
    await wait(1500);

    const db = getBrainDb();
    const raw = db
      .prepare(
        `SELECT processed_at, process_error FROM raw_events WHERE source_ref = 'thread-qdrant-fail'`,
      )
      .get() as { processed_at: string | null; process_error: string | null };
    expect(raw.processed_at).not.toBeNull();
    // The Qdrant failure is logged warn, not a pipeline error.
    expect(raw.process_error).toBeNull();

    const kus = db
      .prepare(`SELECT COUNT(*) as n FROM knowledge_units`)
      .get() as { n: number };
    expect(kus.n).toBeGreaterThan(0);
  });
});
