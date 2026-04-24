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

const { embedMock, qdrantUpsertMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  qdrantUpsertMock: vi.fn(),
}));

vi.mock('../embed.js', () => ({
  embedText: embedMock,
  embedBatch: vi.fn(),
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
import { startBrainIngest, stopBrainIngest } from '../ingest.js';

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
    qdrantUpsertMock.mockReset();
    embedMock.mockResolvedValue(Array.from({ length: 768 }, () => 0.01));
    qdrantUpsertMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopBrainIngest();
    _closeBrainDb();
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    // Embed + upsert both happened.
    expect(embedMock).toHaveBeenCalled();
    expect(qdrantUpsertMock).toHaveBeenCalled();
    const firstUpsert = qdrantUpsertMock.mock.calls[0][0];
    expect(firstUpsert.payload.model_version).toBe('nomic-embed-text-v1.5:768');
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
