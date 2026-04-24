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

// Mock the transformer-backed modules so tests don't load ONNX.
vi.mock('../embed.js', async () => {
  return {
    embedText: vi.fn(async () => Array.from({ length: 768 }, () => 0.01)),
    embedBatch: vi.fn(async () => []),
    getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
    EMBEDDING_DIMS: 768,
    _resetEmbeddingPipeline: () => {},
  };
});

const { qdrantMock, rerankMock } = vi.hoisted(() => ({
  qdrantMock: {
    searchSemantic: vi.fn(),
    upsertKu: vi.fn(),
    ensureBrainCollection: vi.fn(),
    BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
    _setQdrantClientForTest: () => {},
  },
  rerankMock: {
    rerank: vi.fn(),
    _resetRerankPipeline: () => {},
  },
}));
vi.mock('../qdrant.js', () => qdrantMock);
vi.mock('../rerank.js', () => rerankMock);

import { _closeBrainDb, getBrainDb } from '../db.js';
import { stopBrainIngest } from '../ingest.js';
import {
  _shutdownAccessQueue,
  accessScore,
  finalScore,
  recall,
  recencyScore,
  rrf,
} from '../retrieve.js';

// --- Pure math tests ------------------------------------------------------

describe('brain/retrieve — math', () => {
  it('RRF(k=60) accumulates 1/(k+rank) across lists', () => {
    const fused = rrf(
      [
        ['a', 'b', 'c'],
        ['b', 'a', 'd'],
      ],
      60,
    );
    // a: 1/60 + 1/61 ; b: 1/61 + 1/60 ; c: 1/62 ; d: 1/62.
    expect(fused[0].id).toMatch(/^(a|b)$/);
    expect(fused[0].score).toBeCloseTo(1 / 60 + 1 / 61, 6);
    // c and d tied at 1/62; order stable enough to assert score.
    const tail = fused.slice(-2);
    expect(tail[0].score).toBeCloseTo(1 / 62, 6);
  });

  it('recency halves at the half-life', () => {
    const half = 180 * 24 * 3600 * 1000;
    const now = 1_000_000_000_000;
    expect(recencyScore(now, now, half)).toBeCloseTo(1, 6);
    expect(recencyScore(now - half, now, half)).toBeCloseTo(0.5, 6);
    expect(recencyScore(now - 2 * half, now, half)).toBeCloseTo(0.25, 6);
  });

  it('access saturates at 31 hits (log2(32)=5)', () => {
    expect(accessScore(0)).toBe(0);
    expect(accessScore(1)).toBeCloseTo(1 / 5, 6); // log2(2)/5
    expect(accessScore(31)).toBeCloseTo(1, 6); // log2(32)=5
    expect(accessScore(1e6)).toBe(1);
  });

  it('finalScore = 0.7·rank + 0.15·recency + 0.1·access + 0.05·important', () => {
    // With the important axis defaulting to 0, the weights of the remaining
    // three axes no longer sum to 1 — they sum to 0.95.
    expect(finalScore(1, 1, 1)).toBeCloseTo(0.95, 6);
    expect(finalScore(1, 1, 1, 1)).toBeCloseTo(1, 6);
    expect(finalScore(0, 0, 0)).toBe(0);
    expect(finalScore(0, 0, 0, 1)).toBeCloseTo(0.05, 6);
    expect(finalScore(0.5, 0.5, 0.5)).toBeCloseTo(0.475, 6);
  });

  it('important=1 breaks ties but does not swamp ranker signal', () => {
    // Important-only KU (rank=0) cannot beat a high-quality hit (rank=0.8):
    //   0.05·1 = 0.05   vs   0.7·0.8 = 0.56
    expect(finalScore(0, 0, 0, 1)).toBeLessThan(finalScore(0.8, 0, 0, 0));
    // Two otherwise-identical hits: the important one wins.
    expect(finalScore(0.5, 0.5, 0.5, 1)).toBeGreaterThan(
      finalScore(0.5, 0.5, 0.5, 0),
    );
  });
});

// --- End-to-end tests -----------------------------------------------------

function seedKu(
  db: ReturnType<typeof getBrainDb>,
  kuId: string,
  text: string,
  recordedAt: string,
  accessCount = 0,
  opts: {
    account?: string;
    scope?: string | null;
    superseded?: boolean;
    important?: boolean;
  } = {},
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, valid_from,
        recorded_at, superseded_at, access_count, important)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    kuId,
    text,
    `ref-${kuId}`,
    opts.account ?? 'work',
    opts.scope ?? null,
    recordedAt,
    recordedAt,
    opts.superseded ? recordedAt : null,
    accessCount,
    opts.important ? 1 : 0,
  );
}

describe('brain/retrieve — end-to-end', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-retrieve-'));
    getBrainDb();
    qdrantMock.searchSemantic.mockReset();
    rerankMock.rerank.mockReset();
  });

  afterEach(async () => {
    await _shutdownAccessQueue();
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns results using RRF+rerank and excludes superseded KUs', async () => {
    const db = getBrainDb();
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString(); // basically now
    seedKu(db, 'K1', 'alpha bravo charlie', recent);
    seedKu(db, 'K2', 'alpha delta echo', recent);
    seedKu(db, 'K3', 'zulu tango', recent, 0, { superseded: true });

    // Qdrant returns K1 at rank 0 and K3 at rank 1 (but K3 is superseded).
    qdrantMock.searchSemantic.mockResolvedValue([
      { id: 'K1', score: 0.9, payload: {} },
      { id: 'K3', score: 0.8, payload: {} },
    ]);
    // Rerank ranks K1 above K2 by returning larger score for K1.
    rerankMock.rerank.mockImplementation(
      async (
        _q: string,
        cands: Array<{ id: string; text: string }>,
      ) => {
        return cands
          .map((c) => ({
            id: c.id,
            text: c.text,
            score: c.id === 'K1' ? 0.95 : 0.5,
          }))
          .sort((a, b) => b.score - a.score);
      },
    );

    const results = await recall('alpha', { limit: 10, nowMs: now });
    const ids = results.map((r) => r.ku_id);
    expect(ids).toContain('K1');
    expect(ids).not.toContain('K3'); // superseded excluded
    expect(results[0].ku_id).toBe('K1'); // rerank winner at top
  });

  it('forwards model_version filter to Qdrant', async () => {
    getBrainDb();
    qdrantMock.searchSemantic.mockResolvedValue([]);
    rerankMock.rerank.mockResolvedValue([]);
    await recall('whatever');
    const [, filter] = qdrantMock.searchSemantic.mock.calls[0];
    expect(filter.modelVersion).toBe('nomic-embed-text-v1.5:768');
  });

  it('bumps access_count on returned hits', async () => {
    const db = getBrainDb();
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    seedKu(db, 'A', 'hello world', recent, 0);

    qdrantMock.searchSemantic.mockResolvedValue([
      { id: 'A', score: 0.9, payload: {} },
    ]);
    rerankMock.rerank.mockImplementation(async (_q, cands) =>
      cands.map((c: { id: string; text: string }) => ({
        id: c.id,
        text: c.text,
        score: 0.9,
      })),
    );

    const r1 = await recall('hello', { limit: 5, nowMs: now });
    expect(r1.map((r) => r.ku_id)).toEqual(['A']);
    // Drain the access queue so the UPDATE has been flushed.
    await _shutdownAccessQueue();
    const row = db
      .prepare(`SELECT access_count, last_accessed_at FROM knowledge_units WHERE id = 'A'`)
      .get() as { access_count: number; last_accessed_at: string | null };
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).not.toBeNull();
  });

  it('stopBrainIngest drains the access-bump queue so shutdown flushes pending UPDATEs', async () => {
    const db = getBrainDb();
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    seedKu(db, 'Q', 'shutdown test', recent, 0);

    qdrantMock.searchSemantic.mockResolvedValue([
      { id: 'Q', score: 0.9, payload: {} },
    ]);
    rerankMock.rerank.mockImplementation(async (_q, cands) =>
      cands.map((c: { id: string; text: string }) => ({
        id: c.id,
        text: c.text,
        score: 0.9,
      })),
    );

    await recall('shutdown', { limit: 5, nowMs: now });
    // Do NOT call _shutdownAccessQueue here — we're asserting that
    // stopBrainIngest itself drains the lazy access queue.
    await stopBrainIngest();
    const row = db
      .prepare(`SELECT access_count FROM knowledge_units WHERE id = 'Q'`)
      .get() as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it('important=1 boosts a KU above an identical non-important peer', async () => {
    const db = getBrainDb();
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    seedKu(db, 'plain', 'same text', recent, 0, { important: false });
    seedKu(db, 'starred', 'same text', recent, 0, { important: true });

    qdrantMock.searchSemantic.mockResolvedValue([
      { id: 'plain', score: 0.9, payload: {} },
      { id: 'starred', score: 0.9, payload: {} },
    ]);
    // Rerank treats them as equal — only the important_boost should separate.
    rerankMock.rerank.mockImplementation(async (_q, cands) =>
      cands.map((c: { id: string; text: string }) => ({
        id: c.id,
        text: c.text,
        score: 0.8,
      })),
    );

    const out = await recall('same', { limit: 5, nowMs: now });
    expect(out.map((r) => r.ku_id)).toEqual(['starred', 'plain']);
    expect(out[0].important).toBe(true);
    expect(out[0].importantScore).toBe(1);
    expect(out[1].important).toBe(false);
    expect(out[1].importantScore).toBe(0);
    // Starred's final beats plain's by exactly 0.05 (the weight).
    expect(out[0].finalScore - out[1].finalScore).toBeCloseTo(0.05, 6);
  });

  it('recency decay affects final ranking', async () => {
    const db = getBrainDb();
    const now = Date.now();
    const fresh = new Date(now - 1000).toISOString();
    const ancient = new Date(now - 365 * 24 * 3600 * 1000).toISOString();
    seedKu(db, 'new', 'same text', fresh);
    seedKu(db, 'old', 'same text', ancient);

    qdrantMock.searchSemantic.mockResolvedValue([
      { id: 'new', score: 0.9, payload: {} },
      { id: 'old', score: 0.9, payload: {} },
    ]);
    // Rerank scores identical → recency tiebreaks.
    rerankMock.rerank.mockImplementation(async (_q, cands) =>
      cands.map((c: { id: string; text: string }) => ({
        id: c.id,
        text: c.text,
        score: 0.8,
      })),
    );
    const out = await recall('same', { halfLifeDays: 30, nowMs: now });
    expect(out[0].ku_id).toBe('new');
  });
});
