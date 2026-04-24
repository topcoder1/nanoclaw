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

const { qdrantMock } = vi.hoisted(() => ({
  qdrantMock: {
    setPayload: vi.fn(async () => undefined),
  },
}));
vi.mock('../qdrant.js', () => qdrantMock);

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  _shutdownImportantQueue,
  getImportant,
  markImportant,
} from '../important.js';

function seedKu(
  db: ReturnType<typeof getBrainDb>,
  kuId: string,
  important = 0,
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, valid_from, recorded_at,
        access_count, important)
     VALUES (?, ?, 'email', ?, 'work', ?, ?, 0, ?)`,
  ).run(
    kuId,
    `text-${kuId}`,
    `ref-${kuId}`,
    '2026-04-01T00:00:00Z',
    '2026-04-01T00:00:00Z',
    important,
  );
}

describe('brain/important', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-important-'));
    getBrainDb();
    qdrantMock.setPayload.mockReset();
    qdrantMock.setPayload.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await _shutdownImportantQueue();
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('markImportant(true) flips the SQLite column to 1', async () => {
    const db = getBrainDb();
    seedKu(db, 'K1', 0);
    expect(getImportant('K1')).toBe(false);
    await markImportant('K1', true);
    await _shutdownImportantQueue();
    expect(getImportant('K1')).toBe(true);
  });

  it('markImportant(false) flips the SQLite column back to 0', async () => {
    const db = getBrainDb();
    seedKu(db, 'K2', 1);
    expect(getImportant('K2')).toBe(true);
    await markImportant('K2', false);
    await _shutdownImportantQueue();
    expect(getImportant('K2')).toBe(false);
  });

  it('markImportant is idempotent — setting true twice is a no-op', async () => {
    const db = getBrainDb();
    seedKu(db, 'K3', 0);
    await markImportant('K3', true);
    await markImportant('K3', true);
    await _shutdownImportantQueue();
    expect(getImportant('K3')).toBe(true);
    // DB value should still be exactly 1 (not 2, not toggled).
    const row = db
      .prepare(`SELECT important FROM knowledge_units WHERE id = 'K3'`)
      .get() as { important: number };
    expect(row.important).toBe(1);
  });

  it('markImportant propagates to Qdrant via setPayload', async () => {
    const db = getBrainDb();
    seedKu(db, 'K4', 0);
    await markImportant('K4', true);
    await _shutdownImportantQueue();
    expect(qdrantMock.setPayload).toHaveBeenCalledWith('K4', {
      important: true,
    });
  });

  it('markImportant resolves even if Qdrant setPayload throws', async () => {
    const db = getBrainDb();
    seedKu(db, 'K5', 0);
    qdrantMock.setPayload.mockRejectedValueOnce(new Error('qdrant down'));
    await expect(markImportant('K5', true)).resolves.toBeUndefined();
    await _shutdownImportantQueue();
    // SQLite still updated — source of truth for retrieval scoring.
    expect(getImportant('K5')).toBe(true);
  });

  it('getImportant returns false for missing KU ids', () => {
    expect(getImportant('nonexistent')).toBe(false);
  });
});
