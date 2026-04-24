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

import { _closeBrainDb, getBrainDb } from '../db.js';
import { kuPointId } from '../qdrant.js';
import { reconcileQdrant } from '../reconcile.js';
import { getSystemState } from '../metrics.js';
import { newId } from '../ulid.js';

/**
 * Mock Qdrant scroll — we only need `scroll()` to satisfy the reconcile
 * surface. Points are the fixture, paged in a single call.
 */
function makeFakeClient(
  points: Array<{ id: string; payload: Record<string, unknown> }>,
) {
  return {
    async scroll(_name: string, _opts: unknown): Promise<unknown> {
      return { points, next_page_offset: null };
    },
  } as unknown as import('@qdrant/js-client-rest').QdrantClient;
}

describe('brain/reconcile', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reconcile-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedLiveKu(n: number): string[] {
    const db = getBrainDb();
    const ids: string[] = [];
    const now = '2026-04-23T10:00:00Z';
    const stmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?)`,
    );
    for (let i = 0; i < n; i++) {
      const id = newId();
      stmt.run(id, `text ${i}`, now, now);
      ids.push(id);
    }
    return ids;
  }

  it('returns all-missing when Qdrant reachable but empty', async () => {
    const ids = seedLiveKu(3);
    const r = await reconcileQdrant({
      qdrantClient: makeFakeClient([]),
      nowIso: '2026-04-23T10:00:00Z',
    });
    expect(r.qdrantReachable).toBe(true);
    expect(r.sqliteLiveCount).toBe(3);
    expect(r.qdrantPointCount).toBe(0);
    expect(r.missingInQdrant.sort()).toEqual(ids.sort());
    expect(r.orphanInQdrant).toHaveLength(0);
    expect(r.driftRatio).toBe(1);
  });

  it('returns zero drift when Qdrant has all live KUs', async () => {
    const ids = seedLiveKu(2);
    const r = await reconcileQdrant({
      qdrantClient: makeFakeClient(
        ids.map((id) => ({ id: kuPointId(id), payload: { ku_id: id } })),
      ),
      nowIso: '2026-04-23T10:00:00Z',
    });
    expect(r.missingInQdrant).toHaveLength(0);
    expect(r.orphanInQdrant).toHaveLength(0);
    expect(r.driftRatio).toBe(0);
  });

  it('flags Qdrant points with no SQLite KU as orphans', async () => {
    seedLiveKu(1);
    const ghostKuId = newId();
    const r = await reconcileQdrant({
      qdrantClient: makeFakeClient([
        { id: kuPointId(ghostKuId), payload: { ku_id: ghostKuId } },
      ]),
      nowIso: '2026-04-23T10:00:00Z',
    });
    expect(r.orphanInQdrant).toHaveLength(1);
    expect(r.missingInQdrant).toHaveLength(1);
    expect(r.driftRatio).toBe(2);
  });

  it('skips superseded KUs when counting sqlite live rows', async () => {
    const db = getBrainDb();
    const now = '2026-04-23T10:00:00Z';
    const live = newId();
    const sup = newId();
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, superseded_at)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, NULL)`,
    ).run(live, 'live', now, now);
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, superseded_at)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?)`,
    ).run(sup, 'gone', now, now, now);

    const r = await reconcileQdrant({
      qdrantClient: makeFakeClient([
        { id: kuPointId(live), payload: { ku_id: live } },
      ]),
    });
    expect(r.sqliteLiveCount).toBe(1);
    expect(r.missingInQdrant).toHaveLength(0);
  });

  it('writes last_qdrant_reconcile into system_state', async () => {
    seedLiveKu(1);
    await reconcileQdrant({
      qdrantClient: makeFakeClient([]),
      nowIso: '2026-04-23T10:00:00Z',
    });
    const row = getSystemState('last_qdrant_reconcile');
    expect(row?.value).toBe('2026-04-23T10:00:00Z');
    const stats = getSystemState('last_qdrant_reconcile_stats');
    expect(stats).not.toBeNull();
    expect(JSON.parse(stats!.value).sqliteLiveCount).toBe(1);
  });

  it('marks qdrantReachable=false when no client is provided', async () => {
    seedLiveKu(2);
    const r = await reconcileQdrant({ qdrantClient: null });
    expect(r.qdrantReachable).toBe(false);
    expect(r.missingInQdrant).toHaveLength(2);
  });
});
