/**
 * Brain miniapp — POST /api/brain/ku/:id/{important,approve,reject}
 *
 * markImportant talks to Qdrant via setPayload (mocked). The approve and
 * reject writes go through a local AsyncWriteQueue on the API router.
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

let tmpDir: string;
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>(
    '../config.js',
  );
  return {
    ...actual,
    get STORE_DIR() {
      return tmpDir;
    },
  };
});

const { qdrantMock } = vi.hoisted(() => ({
  qdrantMock: {
    searchSemantic: vi.fn(async () => []),
    upsertKu: vi.fn(),
    setPayload: vi.fn(async () => undefined),
    ensureBrainCollection: vi.fn(),
    BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
    kuPointId: (s: string) => s,
    _setQdrantClientForTest: () => {},
  },
}));
vi.mock('../brain/qdrant.js', () => qdrantMock);

import { createMiniAppServer } from '../mini-app/server.js';
import { _closeBrainDb, getBrainDb } from '../brain/db.js';
import { _shutdownImportantQueue } from '../brain/important.js';

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

function seedKu(
  db: Database.Database,
  id: string,
  opts: Partial<{
    confidence: number;
    needs_review: number;
    important: number;
    superseded_at: string | null;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        confidence, needs_review, important, superseded_at)
     VALUES (?, 't', 'email', ?, 'work', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `ref-${id}`,
    '2026-04-01',
    '2026-04-01',
    opts.confidence ?? 0.5,
    opts.needs_review ?? 0,
    opts.important ?? 0,
    opts.superseded_at ?? null,
  );
}

describe('Brain miniapp — feedback POST endpoints', () => {
  let brainDb: Database.Database;
  let app: ReturnType<typeof createMiniAppServer>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-miniapp-fb-'));
    brainDb = getBrainDb();
    app = createMiniAppServer({
      port: 0,
      db: makeMessagesDb(),
      brainDb,
    });
    qdrantMock.setPayload.mockReset();
    qdrantMock.setPayload.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await _shutdownImportantQueue();
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- POST /api/brain/ku/:id/important ---------------------------------

  it('POST .../important flips 0→1 and returns the new value', async () => {
    seedKu(brainDb, 'K1', { important: 0 });
    const res = await request(app).post('/api/brain/ku/K1/important');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ important: true });
    const row = brainDb
      .prepare(`SELECT important FROM knowledge_units WHERE id = 'K1'`)
      .get() as { important: number };
    expect(row.important).toBe(1);
  });

  it('POST .../important flips 1→0 on second call', async () => {
    seedKu(brainDb, 'K2', { important: 1 });
    const res = await request(app).post('/api/brain/ku/K2/important');
    expect(res.body).toEqual({ important: false });
    const row = brainDb
      .prepare(`SELECT important FROM knowledge_units WHERE id = 'K2'`)
      .get() as { important: number };
    expect(row.important).toBe(0);
  });

  it('POST .../important calls Qdrant setPayload', async () => {
    seedKu(brainDb, 'K3');
    await request(app).post('/api/brain/ku/K3/important');
    // Let the important-write queue flush.
    await _shutdownImportantQueue();
    expect(qdrantMock.setPayload).toHaveBeenCalledWith('K3', {
      important: true,
    });
  });

  it('POST .../important returns 404 for missing KU', async () => {
    const res = await request(app).post('/api/brain/ku/missing/important');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'ku_not_found' });
  });

  // --- POST /api/brain/ku/:id/approve ----------------------------------

  it('POST .../approve clears needs_review and raises confidence to 1.0', async () => {
    seedKu(brainDb, 'K_review', { needs_review: 1, confidence: 0.4 });
    const res = await request(app).post('/api/brain/ku/K_review/approve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Write queue has 50ms latency — wait for flush.
    await new Promise((r) => setTimeout(r, 120));
    const row = brainDb
      .prepare(
        `SELECT needs_review, confidence FROM knowledge_units WHERE id = 'K_review'`,
      )
      .get() as { needs_review: number; confidence: number };
    expect(row.needs_review).toBe(0);
    expect(row.confidence).toBeCloseTo(1.0, 6);
  });

  it('POST .../approve returns 404 for missing KU', async () => {
    const res = await request(app).post('/api/brain/ku/nope/approve');
    expect(res.status).toBe(404);
  });

  // --- POST /api/brain/ku/:id/reject -----------------------------------

  it('POST .../reject sets superseded_at to now and returns ok', async () => {
    seedKu(brainDb, 'K_bad');
    const res = await request(app).post('/api/brain/ku/K_bad/reject');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 120));
    const row = brainDb
      .prepare(
        `SELECT superseded_at FROM knowledge_units WHERE id = 'K_bad'`,
      )
      .get() as { superseded_at: string | null };
    expect(row.superseded_at).not.toBeNull();
    // Should be a parseable ISO timestamp.
    expect(Number.isFinite(Date.parse(row.superseded_at ?? ''))).toBe(true);
  });

  it('POST .../reject returns 404 for missing KU', async () => {
    const res = await request(app).post('/api/brain/ku/nope/reject');
    expect(res.status).toBe(404);
  });

  it('POST .../reject does NOT hard-delete the row', async () => {
    seedKu(brainDb, 'K_soft');
    await request(app).post('/api/brain/ku/K_soft/reject');
    await new Promise((r) => setTimeout(r, 120));
    const row = brainDb
      .prepare(`SELECT id FROM knowledge_units WHERE id = 'K_soft'`)
      .get() as { id: string } | undefined;
    expect(row?.id).toBe('K_soft');
  });

  // --- Idempotency: double-click / race-guard behavior -------------------
  it('double-reject preserves the original superseded_at (audit trail)', async () => {
    seedKu(brainDb, 'K_doublereject', { needs_review: 0 });
    await request(app).post('/api/brain/ku/K_doublereject/reject');
    await new Promise((r) => setTimeout(r, 120));
    const firstTs = (
      brainDb
        .prepare(
          `SELECT superseded_at FROM knowledge_units WHERE id = 'K_doublereject'`,
        )
        .get() as { superseded_at: string }
    ).superseded_at;
    expect(firstTs).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    await request(app).post('/api/brain/ku/K_doublereject/reject');
    await new Promise((r) => setTimeout(r, 120));
    const secondTs = (
      brainDb
        .prepare(
          `SELECT superseded_at FROM knowledge_units WHERE id = 'K_doublereject'`,
        )
        .get() as { superseded_at: string }
    ).superseded_at;
    expect(secondTs).toBe(firstTs);
  });

  it('approve after reject is a no-op (does not un-reject or reset confidence)', async () => {
    seedKu(brainDb, 'K_rejectedThenApprove', { needs_review: 1, confidence: 0.6 });
    await request(app).post('/api/brain/ku/K_rejectedThenApprove/reject');
    await new Promise((r) => setTimeout(r, 120));
    const afterReject = brainDb
      .prepare(
        `SELECT needs_review, confidence, superseded_at FROM knowledge_units WHERE id = 'K_rejectedThenApprove'`,
      )
      .get() as { needs_review: number; confidence: number; superseded_at: string | null };
    expect(afterReject.superseded_at).toBeTruthy();
    expect(afterReject.confidence).toBe(0.6); // unchanged by reject
    expect(afterReject.needs_review).toBe(1); // unchanged by reject

    await request(app).post('/api/brain/ku/K_rejectedThenApprove/approve');
    await new Promise((r) => setTimeout(r, 120));
    const afterApprove = brainDb
      .prepare(
        `SELECT needs_review, confidence, superseded_at FROM knowledge_units WHERE id = 'K_rejectedThenApprove'`,
      )
      .get() as { needs_review: number; confidence: number; superseded_at: string | null };
    // Approve must NOT fire because superseded_at is set — audit-trail intact,
    // confidence not clobbered back to 1.0.
    expect(afterApprove.superseded_at).toBe(afterReject.superseded_at);
    expect(afterApprove.confidence).toBe(0.6);
    expect(afterApprove.needs_review).toBe(1);
  });

  it('double-approve is idempotent (no-op on second call)', async () => {
    seedKu(brainDb, 'K_doubleapprove', { needs_review: 1, confidence: 0.5 });
    await request(app).post('/api/brain/ku/K_doubleapprove/approve');
    await new Promise((r) => setTimeout(r, 120));
    await request(app).post('/api/brain/ku/K_doubleapprove/approve');
    await new Promise((r) => setTimeout(r, 120));
    const row = brainDb
      .prepare(
        `SELECT needs_review, confidence FROM knowledge_units WHERE id = 'K_doubleapprove'`,
      )
      .get() as { needs_review: number; confidence: number };
    expect(row.needs_review).toBe(0);
    expect(row.confidence).toBe(1.0);
  });
});
