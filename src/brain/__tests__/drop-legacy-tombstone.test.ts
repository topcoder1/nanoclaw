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
import {
  LEGACY_CUTOVER_KEY,
  LEGACY_CUTOVER_DAYS,
  ensureLegacyCutoverTombstone,
  getLegacyCutoverAt,
  isLegacyCutoverDue,
} from '../drop-legacy-tombstone.js';

describe('brain/drop-legacy-tombstone', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tombstone-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts the tombstone on first call and returns its timestamp', () => {
    const iso = ensureLegacyCutoverTombstone('2026-04-23T10:00:00.000Z');
    expect(iso).toBe('2026-04-23T10:00:00.000Z');

    const db = getBrainDb();
    const row = db
      .prepare(`SELECT value FROM system_state WHERE key = ?`)
      .get(LEGACY_CUTOVER_KEY) as { value: string };
    expect(row.value).toBe('2026-04-23T10:00:00.000Z');
  });

  it('is idempotent — second call returns the original timestamp', () => {
    const first = ensureLegacyCutoverTombstone('2026-04-01T00:00:00.000Z');
    const second = ensureLegacyCutoverTombstone('2026-04-23T00:00:00.000Z');
    expect(second).toBe(first);
    expect(getLegacyCutoverAt()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns null from getLegacyCutoverAt when no tombstone is set', () => {
    getBrainDb(); // open without calling ensure
    expect(getLegacyCutoverAt()).toBeNull();
  });

  it('reports not-due when the tombstone was set less than 30 days ago', () => {
    const setAt = Date.parse('2026-04-01T00:00:00Z');
    ensureLegacyCutoverTombstone(new Date(setAt).toISOString());
    const twentyNineDaysLater = setAt + 29 * 24 * 60 * 60 * 1000;
    expect(isLegacyCutoverDue(twentyNineDaysLater)).toBe(false);
  });

  it('reports due when the tombstone is ≥ 30 days old', () => {
    const setAt = Date.parse('2026-04-01T00:00:00Z');
    ensureLegacyCutoverTombstone(new Date(setAt).toISOString());
    const thirtyDaysLater =
      setAt + LEGACY_CUTOVER_DAYS * 24 * 60 * 60 * 1000;
    expect(isLegacyCutoverDue(thirtyDaysLater)).toBe(true);
  });

  it('reports not-due when no tombstone is set', () => {
    getBrainDb();
    expect(isLegacyCutoverDue(Date.now())).toBe(false);
  });
});
