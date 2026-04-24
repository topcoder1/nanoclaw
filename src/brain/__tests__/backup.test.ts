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
  get QDRANT_URL() {
    return '';
  },
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  backupBrainDb,
  backupQdrant,
  pruneOldBackups,
} from '../backup.js';
import { newId } from '../ulid.js';

describe('brain/backup', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-backup-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('backupBrainDb', () => {
    it('copies brain.db to store/backups/brain-YYYY-MM-DD.db', async () => {
      const db = getBrainDb();
      db.prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, account, confidence, valid_from, recorded_at)
         VALUES (?, 'seed', 'email', 'work', 1.0, ?, ?)`,
      ).run(newId(), '2026-04-23T10:00:00Z', '2026-04-23T10:00:00Z');

      const backupDir = path.join(tmpDir, 'backups');
      const result = await backupBrainDb({
        nowIso: '2026-04-23T02:00:00Z',
        backupDir,
      });
      expect(result.path).toBe(path.join(backupDir, 'brain-2026-04-23.db'));
      expect(result.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(result.path)).toBe(true);
    });

    it('is idempotent on same-day re-run (overwrites)', async () => {
      getBrainDb();
      const backupDir = path.join(tmpDir, 'backups');
      const r1 = await backupBrainDb({
        nowIso: '2026-04-23T02:00:00Z',
        backupDir,
      });
      const r2 = await backupBrainDb({
        nowIso: '2026-04-23T02:00:00Z',
        backupDir,
      });
      expect(r1.path).toBe(r2.path);
      expect(fs.readdirSync(backupDir)).toHaveLength(1);
    });
  });

  describe('backupQdrant', () => {
    it('skips when no Qdrant client is available', async () => {
      const r = await backupQdrant({
        nowIso: '2026-04-23T02:15:00Z',
        snapshotDir: path.join(tmpDir, 'snap'),
        client: null,
      });
      expect(r).toBeNull();
    });

    it('returns null on Qdrant API failure (non-fatal)', async () => {
      const fakeClient = {
        async createSnapshot(): Promise<unknown> {
          throw new Error('qdrant down');
        },
      } as unknown as import('@qdrant/js-client-rest').QdrantClient;
      const r = await backupQdrant({
        nowIso: '2026-04-23T02:15:00Z',
        snapshotDir: path.join(tmpDir, 'snap'),
        client: fakeClient,
      });
      expect(r).toBeNull();
    });
  });

  describe('pruneOldBackups', () => {
    it('deletes files older than retentionDays by mtime', () => {
      const dir = path.join(tmpDir, 'prune');
      fs.mkdirSync(dir, { recursive: true });
      const oldPath = path.join(dir, 'old.db');
      const youngPath = path.join(dir, 'young.db');
      fs.writeFileSync(oldPath, 'x');
      fs.writeFileSync(youngPath, 'y');
      const now = Date.now();
      // Backdate `oldPath` by 40 days
      const past = now - 40 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldPath, past / 1000, past / 1000);

      const removed = pruneOldBackups(dir, 30, now);
      expect(removed).toContain(oldPath);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(youngPath)).toBe(true);
    });

    it('is a no-op when the dir does not exist', () => {
      const removed = pruneOldBackups(path.join(tmpDir, 'nope'), 30);
      expect(removed).toEqual([]);
    });
  });
});
