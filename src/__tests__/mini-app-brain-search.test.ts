/**
 * Brain miniapp — /brain/search route tests.
 *
 * recall() is the real dep (we want it to exercise FTS + RRF + blended
 * scoring), but its transformer-backed subsystems are mocked:
 *   - embed.js → fake 768d vector
 *   - qdrant.js → returns a hand-seeded list of hits
 *   - rerank.js → identity-ish reranker
 * Same pattern as src/brain/__tests__/retrieve.test.ts.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Redirect getBrainDb() to a tmp dir so recall() and the routes share the
// SAME DB (recall uses the singleton, not the injected `brainDb` opt).
let tmpDir: string;
vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get STORE_DIR() {
      return tmpDir;
    },
  };
});

vi.mock('../brain/embed.js', () => ({
  embedText: vi.fn(async () => Array.from({ length: 768 }, () => 0.01)),
  embedBatch: vi.fn(async () => []),
  getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
  EMBEDDING_DIMS: 768,
  _resetEmbeddingPipeline: () => {},
}));

const { qdrantMock, rerankMock } = vi.hoisted(() => ({
  qdrantMock: {
    searchSemantic: vi.fn(async () => []),
    upsertKu: vi.fn(),
    setPayload: vi.fn(async () => undefined),
    ensureBrainCollection: vi.fn(),
    BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
    kuPointId: (s: string) => s,
    _setQdrantClientForTest: () => {},
  },
  rerankMock: {
    rerank: vi.fn(
      async (_q: string, cands: Array<{ id: string; text: string }>) =>
        cands.map((c) => ({ id: c.id, text: c.text, score: 0.5 })),
    ),
    _resetRerankPipeline: () => {},
  },
}));
vi.mock('../brain/qdrant.js', () => qdrantMock);
vi.mock('../brain/rerank.js', () => rerankMock);

import { createMiniAppServer } from '../mini-app/server.js';
import { _closeBrainDb, getBrainDb } from '../brain/db.js';
import { _shutdownAccessQueue } from '../brain/retrieve.js';

function seedKu(
  db: Database.Database,
  id: string,
  text: string,
  opts: {
    source_type?: string;
    recorded_at?: string;
    important?: boolean;
  } = {},
): void {
  const recordedAt = opts.recorded_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        confidence, important)
     VALUES (?, ?, ?, ?, 'work', ?, ?, 1.0, ?)`,
  ).run(
    id,
    text,
    opts.source_type ?? 'email',
    `ref-${id}`,
    recordedAt,
    recordedAt,
    opts.important ? 1 : 0,
  );
}

function makeMessagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracked_items (
      id TEXT PRIMARY KEY, source TEXT, source_id TEXT, group_name TEXT,
      state TEXT, queue TEXT, title TEXT, thread_id TEXT, detected_at INTEGER,
      metadata TEXT, classification TEXT, sender_kind TEXT, subtype TEXT,
      action_intent TEXT
    );
  `);
  return db;
}

describe('Brain miniapp — /brain/search', () => {
  let brainDb: Database.Database;
  let app: ReturnType<typeof createMiniAppServer>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-miniapp-search-'));
    // `getBrainDb()` uses the mocked STORE_DIR → opens a fresh DB in tmp.
    // Routes + recall() both call the singleton, so they see the same rows.
    brainDb = getBrainDb();
    app = createMiniAppServer({
      port: 0,
      db: makeMessagesDb(),
      brainDb,
    });
    qdrantMock.searchSemantic.mockResolvedValue([]);
    rerankMock.rerank.mockImplementation(async (_q, cands) =>
      cands.map((c: { id: string; text: string }) => ({
        id: c.id,
        text: c.text,
        score: 0.5,
      })),
    );
  });

  afterEach(async () => {
    // recall() queues async access-count bumps; drain before closing the
    // DB so pending UPDATEs don't fire against a closed handle.
    await _shutdownAccessQueue();
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /brain/search (no q) prompts for input', async () => {
    const res = await request(app).get('/brain/search');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Enter a query above to search the brain');
  });

  it('GET /brain/search?q=foo returns 200 HTML with the result row', async () => {
    seedKu(brainDb, 'KU1', 'hello alpha bravo from Acme');
    const res = await request(app).get('/brain/search?q=alpha');
    expect(res.status).toBe(200);
    expect(res.text).toContain('hello alpha bravo from Acme');
    expect(res.text).toContain('href="/brain/ku/KU1"');
  });

  it('empty query does NOT invoke recall (embedText is not called)', async () => {
    const embed = await import('../brain/embed.js');
    const calls = (embed.embedText as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await request(app).get('/brain/search?q=');
    expect(
      (embed.embedText as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(calls);
  });

  it('user input is escaped — <script> in q does not leak', async () => {
    const res = await request(app).get('/brain/search?q=%3Cscript%3Ex');
    expect(res.text).not.toContain('<script>x');
    expect(res.text).toContain('&lt;script&gt;x');
  });

  it('source filter narrows the result set', async () => {
    seedKu(brainDb, 'A', 'shared text alpha', { source_type: 'email' });
    seedKu(brainDb, 'B', 'shared text alpha', { source_type: 'gong' });

    const res = await request(app).get('/brain/search?q=alpha&source=email');
    expect(res.text).toContain('href="/brain/ku/A"');
    expect(res.text).not.toContain('href="/brain/ku/B"');
  });

  it('limit caps rendered rows at 50 even if recall returns more', async () => {
    for (let i = 0; i < 60; i++) {
      seedKu(brainDb, `K${i}`, `alpha beta gamma row-${i}`);
    }
    const res = await request(app).get('/brain/search?q=alpha&limit=200');
    // Count the number of row-link hrefs rendered.
    const matches = res.text.match(/href="\/brain\/ku\/K\d+"/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(50);
  });

  it('empty result renders "No results." message', async () => {
    const res = await request(app).get(
      '/brain/search?q=nothingmatchesthisquery',
    );
    expect(res.text).toContain('No results.');
  });
});
