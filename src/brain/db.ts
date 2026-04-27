/**
 * Brain database — store/brain.db. Separate file from the existing
 * store/messages.db to keep the augmented-brain schema independent and
 * migrateable on its own cadence (see .omc/design/brain-architecture-v2.md §5).
 *
 * Singleton pattern mirrors src/db.ts. First call opens the file with WAL,
 * applies the schema, and caches the handle. Subsequent calls return the
 * same handle. Schema application is idempotent (CREATE TABLE IF NOT EXISTS
 * / CREATE INDEX IF NOT EXISTS everywhere), so reopening an already-
 * populated DB is a no-op at the schema level.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

let db: Database.Database | null = null;

// __dirname equivalent for ESM. schema.sql lives alongside this file
// at runtime (tsx) and build time (dist/brain/schema.sql — copied via
// build step; for now we read from the source tree).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadSchemaSql(): string {
  // In dev (tsx): __dirname = .../src/brain, schema.sql is adjacent.
  // In build: tsc does not copy .sql; we fall back to the src path if
  // the adjacent file is missing. This keeps unit tests and `pnpm dev`
  // working. Production deploy must ensure schema.sql ships with the JS.
  const adjacent = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(adjacent)) return fs.readFileSync(adjacent, 'utf8');

  // Best-effort fallback: look in the project's src/brain directory
  // (handles `tsc` builds that drop .sql).
  const srcPath = path.resolve(process.cwd(), 'src', 'brain', 'schema.sql');
  return fs.readFileSync(srcPath, 'utf8');
}

function applySchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
  database.exec(loadSchemaSql());
  applyColumnMigrations(database);
}

/**
 * Idempotent column additions for pre-existing brain.db files.
 *
 * The base schema uses `CREATE TABLE IF NOT EXISTS`, so adding a new column
 * to `schema.sql` does NOT propagate to databases that already exist. We
 * ALTER TABLE ADD COLUMN in a try/catch — re-applying is a no-op because
 * SQLite throws "duplicate column" when the column already exists.
 *
 * Same pattern used in src/db.ts for tracked_items/draft_originals etc.
 */
function applyColumnMigrations(database: Database.Database): void {
  // Brain miniapp v1: `important` flag for boosting KUs in retrieval.
  try {
    database.exec(
      `ALTER TABLE knowledge_units ADD COLUMN important INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists — idempotent no-op */
  }
  // PR 1 (chat ingest): forward-link to replacement KU on edit-sync supersession.
  // Pre-existing brain DBs may not have this column.
  try {
    database.exec(`ALTER TABLE knowledge_units ADD COLUMN superseded_by TEXT`);
  } catch (err) {
    if (!/duplicate column name/i.test(String(err))) throw err;
  }
  // Index is idempotent via CREATE INDEX IF NOT EXISTS — safe to run every time
  // so brain.db files that existed before the column was added still get the
  // index once the column has been ALTERed in.
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_ku_important ON knowledge_units(important) WHERE important = 1`,
  );
}

/**
 * Open (or return cached) brain.db handle.
 * Creates the store directory if missing.
 */
export function getBrainDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'brain.db');
  db = new Database(dbPath);
  applySchema(db);
  logger.info({ path: dbPath }, 'Brain DB initialized');
  return db;
}

/** @internal — for tests only. Opens a fresh DB at the given path (or :memory:). */
export function _openBrainDbForTest(
  dbPath: string = ':memory:',
): Database.Database {
  const fresh = new Database(dbPath);
  applySchema(fresh);
  return fresh;
}

/** @internal — for tests only. Closes and clears the cached handle. */
export function _closeBrainDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
