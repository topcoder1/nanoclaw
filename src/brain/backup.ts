/**
 * Brain nightly backup (design §9 Backup / recovery).
 *
 *   - brain.db  → store/backups/brain-YYYY-MM-DD.db  (02:00 local, retain 30d)
 *   - Qdrant    → store/qdrant-snapshots/{collection}-YYYY-MM-DD.snapshot
 *                 (02:15 local, retain 14d)
 *
 * SQLite uses better-sqlite3's `.backup()` API — an online copy that doesn't
 * block writers and is guaranteed consistent. Qdrant uses its `createSnapshot`
 * API (returns a URL; we fetch and persist to disk).
 *
 * Retention is a simple "delete files older than N days by mtime" pass.
 * Schedulers are separate from §5 so a failing snapshot doesn't stop the
 * sqlite backup and vice versa.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import fs from 'fs';
import path from 'path';

import { QDRANT_URL, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { setSystemState } from './metrics.js';
import { BRAIN_COLLECTION } from './qdrant.js';

export const LAST_BACKUP_FAILED_KEY = 'last_backup_failed_at';

// Directories are functions (not constants) so tests that mock STORE_DIR
// via a getter see the active value at call time rather than at module
// import time.
export function getBrainBackupDir(): string {
  return path.join(STORE_DIR, 'backups');
}
export function getQdrantSnapshotDir(): string {
  return path.join(STORE_DIR, 'qdrant-snapshots');
}

export const BRAIN_BACKUP_RETENTION_DAYS = 30;
export const QDRANT_SNAPSHOT_RETENTION_DAYS = 14;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function datePart(iso: string): string {
  return iso.slice(0, 10);
}

export interface BackupResult {
  path: string;
  bytes: number;
  ranAt: string;
}

/**
 * Back up brain.db to `store/backups/brain-YYYY-MM-DD.db`. Overwrites
 * same-day files — a re-run replaces an in-progress backup cleanly.
 */
export async function backupBrainDb(opts: { nowIso?: string; backupDir?: string } = {}): Promise<BackupResult> {
  const iso = opts.nowIso ?? new Date().toISOString();
  const dir = opts.backupDir ?? getBrainBackupDir();
  ensureDir(dir);
  const outPath = path.join(dir, `brain-${datePart(iso)}.db`);
  const tmpPath = `${outPath}.tmp`;
  const db = getBrainDb();
  // better-sqlite3 .backup() returns a Promise; writes to tmp, then rename
  // so a partial backup never looks like a successful one.
  await db.backup(tmpPath);
  fs.renameSync(tmpPath, outPath);
  const stat = fs.statSync(outPath);
  logger.info(
    { path: outPath, bytes: stat.size },
    'brain.db backup complete',
  );
  return { path: outPath, bytes: stat.size, ranAt: iso };
}

/**
 * Create a Qdrant snapshot for the active brain collection and download it
 * to `store/qdrant-snapshots/`. Returns the local file path.
 *
 * The Qdrant REST API's snapshot endpoints are used via `createSnapshot`
 * (server-side) + a plain GET for the file. If QDRANT_URL is unset we
 * skip (logged) rather than fail.
 */
export async function backupQdrant(
  opts: {
    nowIso?: string;
    snapshotDir?: string;
    client?: QdrantClient | null;
    collection?: string;
  } = {},
): Promise<BackupResult | null> {
  const iso = opts.nowIso ?? new Date().toISOString();
  const dir = opts.snapshotDir ?? getQdrantSnapshotDir();
  const collection = opts.collection ?? BRAIN_COLLECTION;
  ensureDir(dir);
  const url = QDRANT_URL;
  const client =
    opts.client ?? (url ? new QdrantClient({ url }) : null);
  if (!client) {
    logger.info('backupQdrant: QDRANT_URL not set — skipping');
    return null;
  }
  try {
    const snap = (await client.createSnapshot(collection)) as {
      name?: string;
    } | null;
    if (!snap?.name) {
      logger.warn({ collection }, 'backupQdrant: no snapshot name returned');
      return null;
    }
    const outPath = path.join(dir, `${collection}-${datePart(iso)}.snapshot`);
    const downloadUrl = `${url}/collections/${collection}/snapshots/${encodeURIComponent(snap.name)}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      logger.warn(
        { status: res.status, collection },
        'backupQdrant: snapshot download failed',
      );
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outPath, buf);
    logger.info(
      { path: outPath, bytes: buf.byteLength, collection },
      'Qdrant snapshot persisted',
    );
    return { path: outPath, bytes: buf.byteLength, ranAt: iso };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), collection },
      'backupQdrant failed (non-fatal)',
    );
    return null;
  }
}

/**
 * Delete files in `dir` older than `retentionDays` based on mtime.
 * Returns the list of removed paths.
 */
export function pruneOldBackups(dir: string, retentionDays: number, nowMs: number = Date.now()): string[] {
  if (!fs.existsSync(dir)) return [];
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path: p },
        'pruneOldBackups: skip path',
      );
    }
  }
  return removed;
}

/**
 * Convenience wrapper for the scheduler — do brain.db backup + Qdrant
 * snapshot + both prunes in one go. Errors in any step are logged but do
 * not stop the others.
 */
export async function runNightlyBackups(nowIso?: string): Promise<void> {
  try {
    await backupBrainDb({ nowIso });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'backupBrainDb failed',
    );
  }
  try {
    await backupQdrant({ nowIso });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'backupQdrant failed',
    );
  }
  pruneOldBackups(getBrainBackupDir(), BRAIN_BACKUP_RETENTION_DAYS);
  pruneOldBackups(getQdrantSnapshotDir(), QDRANT_SNAPSHOT_RETENTION_DAYS);
}

/**
 * Start the nightly backup schedule.
 *   - 02:00 local → backupBrainDb + pruneOldBackups(backup dir)
 *   - 02:15 local → backupQdrant   + pruneOldBackups(snapshot dir)
 *
 * The two are staggered so a slow brain.db backup can't block the
 * Qdrant snapshot cadence.
 */
export function startNightlyBackupSchedule(): () => void {
  const checkIntervalMs = 60 * 1000;
  let lastBrainDay: string | null = null;
  let lastSnapshotDay: string | null = null;

  const tick = (): void => {
    const now = new Date();
    const hour = now.getHours();
    const min = now.getMinutes();
    const today = now.toISOString().slice(0, 10);
    if (hour === 2 && min < 15 && lastBrainDay !== today) {
      lastBrainDay = today;
      void backupBrainDb()
        .catch((err) => {
          const iso = new Date().toISOString();
          setSystemState(LAST_BACKUP_FAILED_KEY, iso, iso);
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'scheduled brain.db backup failed',
          );
        })
        .finally(() => {
          pruneOldBackups(getBrainBackupDir(), BRAIN_BACKUP_RETENTION_DAYS);
        });
    }
    if (hour === 2 && min >= 15 && lastSnapshotDay !== today) {
      lastSnapshotDay = today;
      void backupQdrant()
        .catch((err) => {
          const iso = new Date().toISOString();
          setSystemState(LAST_BACKUP_FAILED_KEY, iso, iso);
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'scheduled Qdrant snapshot failed',
          );
        })
        .finally(() => {
          pruneOldBackups(getQdrantSnapshotDir(), QDRANT_SNAPSHOT_RETENTION_DAYS);
        });
    }
  };
  const handle = setInterval(tick, checkIntervalMs);
  return () => clearInterval(handle);
}
