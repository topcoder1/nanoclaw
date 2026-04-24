/**
 * Drop legacy knowledge store — `knowledge_facts` table + `nanoclaw_knowledge`
 * Qdrant collection. Runs ONLY when invoked with `--confirm`.
 *
 * Usage:
 *   npx tsx scripts/drop-legacy.ts               # prints the plan, exits 0
 *   npx tsx scripts/drop-legacy.ts --confirm     # actually drops
 *
 * Prerequisites (enforced):
 *   1. `system_state.legacy_cutover_at` exists in brain.db.
 *   2. ≥ 30 days have elapsed since that timestamp (design §4 Phase C).
 *
 * Without both, the script refuses to drop — run `migrate-brain.ts` first
 * and wait out the window.
 *
 * Skippable checks (for emergencies):
 *   --force     bypass the 30-day cutover check (still requires --confirm)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { QdrantClient } from '@qdrant/js-client-rest';

import { QDRANT_URL, STORE_DIR } from '../src/config.js';
import {
  LEGACY_CUTOVER_DAYS,
  getLegacyCutoverAt,
  isLegacyCutoverDue,
} from '../src/brain/drop-legacy-tombstone.js';

const LEGACY_QDRANT = 'nanoclaw_knowledge';
const LEGACY_DB_TABLE = 'knowledge_facts';
const MESSAGES_DB = path.join(STORE_DIR, 'messages.db');

const args = new Set(process.argv.slice(2));
const confirm = args.has('--confirm');
const force = args.has('--force');

/* eslint-disable no-console */
async function main(): Promise<void> {
  console.log('--- drop-legacy plan ---');
  const tombstoneAt = getLegacyCutoverAt();
  console.log(`tombstone legacy_cutover_at: ${tombstoneAt ?? '(not set)'}`);
  const due = isLegacyCutoverDue();
  console.log(
    `cutover window (${LEGACY_CUTOVER_DAYS}d) elapsed: ${due ? 'yes' : 'no'}`,
  );
  console.log(`messages.db present:           ${fs.existsSync(MESSAGES_DB)}`);
  console.log(`QDRANT_URL configured:         ${QDRANT_URL ? 'yes' : 'no'}`);

  if (!confirm) {
    console.log('\nDry run. Re-run with --confirm to actually drop.');
    return;
  }
  if (!tombstoneAt) {
    console.error(
      'REFUSING: no legacy_cutover_at tombstone. Start the brain once to set it, then wait 30 days.',
    );
    process.exit(2);
  }
  if (!due && !force) {
    console.error(
      `REFUSING: cutover window not elapsed. Wait until ${LEGACY_CUTOVER_DAYS}d after ${tombstoneAt}, or pass --force.`,
    );
    process.exit(2);
  }

  // Step 1 — drop the legacy SQLite FTS5 table (if present).
  if (fs.existsSync(MESSAGES_DB)) {
    const db = new Database(MESSAGES_DB);
    try {
      const t = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        )
        .get(LEGACY_DB_TABLE) as { name: string } | undefined;
      if (t) {
        db.exec(`DROP TABLE ${LEGACY_DB_TABLE};`);
        console.log(`dropped table: ${LEGACY_DB_TABLE}`);
      } else {
        console.log(`table ${LEGACY_DB_TABLE} already absent`);
      }
    } finally {
      db.close();
    }
  } else {
    console.log(`messages.db missing at ${MESSAGES_DB} — skipping table drop`);
  }

  // Step 2 — drop the legacy Qdrant collection (if reachable).
  if (QDRANT_URL) {
    const client = new QdrantClient({ url: QDRANT_URL });
    try {
      const exists = await client.collectionExists(LEGACY_QDRANT);
      if (exists.exists) {
        await client.deleteCollection(LEGACY_QDRANT);
        console.log(`dropped Qdrant collection: ${LEGACY_QDRANT}`);
      } else {
        console.log(`Qdrant collection ${LEGACY_QDRANT} already absent`);
      }
    } catch (err) {
      console.error(
        `Qdrant drop failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log('\n✅ drop-legacy complete');
}

void main().catch((err) => {
  console.error('drop-legacy failed:', err);
  process.exit(1);
});
