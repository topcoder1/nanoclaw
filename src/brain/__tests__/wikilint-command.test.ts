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

import type Database from 'better-sqlite3';

import { _closeBrainDb, _openBrainDbForTest, getBrainDb } from '../db.js';
import { getSystemState, setSystemState } from '../metrics.js';
import {
  handleWikilintCommand,
  maybeRunWikilintCron,
} from '../wikilint-command.js';

let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikilint-cmd-'));
  db = _openBrainDbForTest(':memory:');
});

afterEach(() => {
  db.close();
  _closeBrainDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleWikilintCommand', () => {
  it('returns the no-issues report on a fresh DB', async () => {
    const reply = await handleWikilintCommand({ db });
    expect(reply).toContain('no issues');
  });

  it('reports orphan entities detected in the DB', async () => {
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('E_O', 'person', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    const reply = await handleWikilintCommand({
      db,
      nowIso: '2026-04-28T12:00:00Z',
    });
    expect(reply).toContain('Orphan entities');
    expect(reply).toContain('E_O');
  });

  it('returns a friendly error message when runAll throws', async () => {
    // Pass a sentinel db that throws on `prepare` to simulate a corrupted
    // brain.db. The handler must not propagate the throw — replies are the
    // user-facing surface.
    const broken = {
      prepare: () => {
        throw new Error('disk i/o error');
      },
    } as unknown as Database.Database;
    const reply = await handleWikilintCommand({ db: broken });
    expect(reply).toContain('Wikilint failed');
  });
});

describe('maybeRunWikilintCron', () => {
  beforeEach(() => {
    // Ensure the singleton DB is initialized inside our tmpDir so
    // getSystemState / setSystemState (which both go through getBrainDb)
    // hit a clean DB per test.
    getBrainDb();
  });

  it('delivers the report and stamps last_wikilint when never run before', async () => {
    // Seed an orphan entity so the report has real content. Use the
    // singleton DB so the cron's `getBrainDb()` and our seed write hit
    // the same handle (file-backed in tmpDir via the file-level config
    // mock above).
    const sg = getBrainDb();
    sg.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('E_O', 'person', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    const delivered: string[] = [];
    const nowIso = '2026-04-28T10:00:00Z';
    await maybeRunWikilintCron({
      deliver: (md) => {
        delivered.push(md);
      },
      nowIso,
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Wikilint report');
    // Confirms the cron's runAll actually saw the seeded data — i.e. the
    // cron path goes through the same DB the test wrote to.
    expect(delivered[0]).toContain('Orphan entities');
    expect(delivered[0]).toContain('E_O');
    expect(getSystemState('last_wikilint')?.value).toBe(nowIso);
  });

  it('skips delivery when last_wikilint is < 7 days old', async () => {
    setSystemState('last_wikilint', '2026-04-25T00:00:00Z'); // 3 days ago

    const delivered: string[] = [];
    await maybeRunWikilintCron({
      deliver: (md) => {
        delivered.push(md);
      },
      nowIso: '2026-04-28T10:00:00Z',
    });

    expect(delivered).toEqual([]);
    expect(getSystemState('last_wikilint')?.value).toBe(
      '2026-04-25T00:00:00Z',
    );
  });

  it('runs again once 7 days have elapsed', async () => {
    setSystemState('last_wikilint', '2026-04-20T00:00:00Z'); // 8 days ago

    const delivered: string[] = [];
    const nowIso = '2026-04-28T10:00:00Z';
    await maybeRunWikilintCron({
      deliver: (md) => {
        delivered.push(md);
      },
      nowIso,
    });

    expect(delivered).toHaveLength(1);
    expect(getSystemState('last_wikilint')?.value).toBe(nowIso);
  });
});
