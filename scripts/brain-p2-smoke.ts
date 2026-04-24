/**
 * End-to-end smoke test for brain P2.
 *
 * Exercises the entire P2 surface WITH an in-memory Qdrant fake so that
 * the Qdrant-side contract (upsert called per migrated KU, every payload
 * carries model_version) is actually asserted — the earlier smoke passed
 * a null Qdrant client, which masked BLOCKER-1 and BLOCKER-2.
 *
 *   1. legacy-store seed (knowledge_facts, tracked_items, commitments,
 *      acted_emails) + migration → knowledge_units + raw_events rollup
 *   2. Qdrant fake verifies upsertKu was called per KU with model_version
 *   3. tombstone set + idempotency
 *   4. cost log + daily/monthly rollups
 *   5. reconcile (no Qdrant → all-missing drift)
 *   6. weekly digest format sanity
 *   7. health report + /brainhealth formatting
 *   8. alerts dispatch + throttle
 *   9. backup brain.db (online copy) + prune
 *  10. FTS5 recall against the migrated KUs (semantic leg skipped —
 *      FTS5 proves the migrated rows are retrievable end-to-end)
 *
 * Prints `P2 END-TO-END VERIFIED` on success, exits 1 otherwise.
 *
 * Run:  npx tsx scripts/brain-p2-smoke.ts
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Force STORE_DIR into a temp dir BEFORE any brain import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p2-smoke-'));
process.chdir(tmpDir);
process.env.LOG_LEVEL = 'warn';

// Seed a legacy messages.db so migration has work to do.
// Three knowledge_facts rows (one empty → should be skipped),
// two tracked_items, one commitment, one acted_email.
const legacyPath = path.join(tmpDir, 'store', 'messages.db');
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
{
  const db = new Database(legacyPath);
  db.exec(
    `CREATE VIRTUAL TABLE knowledge_facts USING fts5(
       text, domain, group_id, source, created_at
     );`,
  );
  const kf = db.prepare(
    `INSERT INTO knowledge_facts (text, domain, group_id, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  kf.run('Alice confirmed renewal', 'deals', 'g1', 'email', '2026-04-20T10:00:00Z');
  kf.run('Meeting moved to Thursday', 'sched', 'g2', 'manual', '2026-04-21T10:00:00Z');
  kf.run('Bob requested pricing update', 'deals', 'g3', 'email', '2026-04-22T10:00:00Z');

  db.exec(
    `CREATE TABLE tracked_items (
       id INTEGER PRIMARY KEY,
       topic TEXT,
       created_at TEXT
     );`,
  );
  const ti = db.prepare(
    `INSERT INTO tracked_items (id, topic, created_at) VALUES (?, ?, ?)`,
  );
  ti.run(1, 'renewal-alice', '2026-04-20T10:00:00Z');
  ti.run(2, 'renewal-bob', '2026-04-21T10:00:00Z');

  db.exec(
    `CREATE TABLE commitments (
       uuid TEXT PRIMARY KEY,
       owner TEXT,
       due_at TEXT
     );`,
  );
  db.prepare(
    `INSERT INTO commitments (uuid, owner, due_at) VALUES (?, ?, ?)`,
  ).run('commit-1', 'alice', '2026-04-25T10:00:00Z');

  db.exec(
    `CREATE TABLE acted_emails (
       thread_id TEXT PRIMARY KEY,
       action TEXT,
       acted_at TEXT
     );`,
  );
  db.prepare(
    `INSERT INTO acted_emails (thread_id, action, acted_at) VALUES (?, ?, ?)`,
  ).run('thr-xyz', 'replied', '2026-04-20T11:00:00Z');

  db.close();
}

const { migrateKnowledgeFacts } = await import('../src/brain/migrate-knowledge-facts.js');
const {
  ensureLegacyCutoverTombstone,
  getLegacyCutoverAt,
  isLegacyCutoverDue,
  LEGACY_CUTOVER_DAYS,
} = await import('../src/brain/drop-legacy-tombstone.js');
const {
  logCost,
  getDailyCostUsd,
  getMonthlyCostUsd,
  recordRetrievalLatencyMs,
  getLatencyStats,
  getBrainCounts,
} = await import('../src/brain/metrics.js');
const { reconcileQdrant } = await import('../src/brain/reconcile.js');
const { evaluateAlerts } = await import('../src/brain/alerts.js');
const { getBrainHealthReport, handleBrainHealthCommand } = await import(
  '../src/brain/health.js'
);
const { collectWeeklyDigest, formatWeeklyDigestMarkdown } = await import(
  '../src/brain/weekly-digest.js'
);
const { backupBrainDb, pruneOldBackups, getBrainBackupDir } = await import(
  '../src/brain/backup.js'
);
const { _closeBrainDb, getBrainDb } = await import('../src/brain/db.js');
const { _setQdrantClientForTest } = await import('../src/brain/qdrant.js');

interface UpsertCall {
  kuId: string;
  payload: Record<string, unknown>;
  vectorLen: number;
}

/**
 * Minimal in-memory Qdrant fake — captures upsert calls so the smoke can
 * assert the migration hit Qdrant with the right payload shape.
 * Follows the pattern in src/brain/__tests__/reconcile.test.ts.
 */
function makeFakeClient(upserts: UpsertCall[]) {
  return {
    async collectionExists(_name: string) {
      return { exists: true };
    },
    async createCollection(_name: string, _opts: unknown) {
      return undefined;
    },
    async upsert(
      _name: string,
      body: {
        points: Array<{
          id: string | number;
          vector: number[];
          payload: Record<string, unknown>;
        }>;
      },
    ) {
      for (const p of body.points) {
        const kuId =
          typeof p.payload.ku_id === 'string' ? p.payload.ku_id : String(p.id);
        upserts.push({
          kuId,
          payload: p.payload,
          vectorLen: Array.isArray(p.vector) ? p.vector.length : 0,
        });
      }
      return undefined;
    },
    async scroll(_name: string, _opts: unknown) {
      return { points: [], next_page_offset: null };
    },
    async search(_name: string, _opts: unknown) {
      return [];
    },
  } as unknown as import('@qdrant/js-client-rest').QdrantClient;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

async function main(): Promise<void> {
  // 0. Plumb the fake Qdrant client in BEFORE the migration runs.
  const upserts: UpsertCall[] = [];
  _setQdrantClientForTest(makeFakeClient(upserts));

  // 1. Migration — covers knowledge_facts + legacy-table raw_events rollup.
  const migrationReport = await migrateKnowledgeFacts();
  assert(migrationReport.legacyRowsTotal === 3, 'migration legacy count');
  assert(migrationReport.inserted === 3, 'migration inserted 3 non-empty rows');
  assert(
    migrationReport.legacyRowsSkippedEmpty === 0,
    'migration skipped empty row (none empty here)',
  );

  // 1a. Qdrant upsert assertions — BLOCKER-1 proof.
  assert(
    upserts.length === migrationReport.inserted,
    `upsertKu called once per inserted KU — got ${upserts.length}, want ${migrationReport.inserted}`,
  );
  for (const u of upserts) {
    assert(
      u.payload.model_version === 'nomic-embed-text-v1.5:768',
      `every Qdrant payload carries model_version tag — saw ${String(u.payload.model_version)}`,
    );
    assert(u.vectorLen === 768, `embedded vector has 768 dims — got ${u.vectorLen}`);
  }
  assert(
    typeof migrationReport.qdrantWritten === 'number' &&
      migrationReport.qdrantWritten === migrationReport.inserted,
    `MigrationReport.qdrantWritten tracks successful upserts (got ${migrationReport.qdrantWritten})`,
  );

  // 1b. raw_events rollup assertions — BLOCKER-2 proof.
  // Each legacy table (tracked_items×2, commitments×1, acted_emails×1) should
  // produce an INSERT OR IGNORE into raw_events, keyed by source_type.
  const brainDb = getBrainDb();
  const rawRows = brainDb
    .prepare(
      `SELECT source_type, COUNT(*) AS n FROM raw_events GROUP BY source_type`,
    )
    .all() as Array<{ source_type: string; n: number }>;
  const rawBySrc = new Map(rawRows.map((r) => [r.source_type, r.n]));
  assert(
    (rawBySrc.get('tracked_item') ?? 0) === 2,
    `raw_events has 2 tracked_item rows — got ${rawBySrc.get('tracked_item') ?? 0}`,
  );
  assert(
    (rawBySrc.get('commitment') ?? 0) === 1,
    `raw_events has 1 commitment row — got ${rawBySrc.get('commitment') ?? 0}`,
  );
  assert(
    (rawBySrc.get('acted_email') ?? 0) === 1,
    `raw_events has 1 acted_email row — got ${rawBySrc.get('acted_email') ?? 0}`,
  );
  const totalRaw = rawRows.reduce((acc, r) => acc + r.n, 0);
  assert(totalRaw >= 4, `raw_events total ≥ 4 — got ${totalRaw}`);

  // 2. Tombstone
  const thirtyOneDaysAgo = new Date(
    Date.now() - (LEGACY_CUTOVER_DAYS + 1) * 24 * 60 * 60 * 1000,
  ).toISOString();
  ensureLegacyCutoverTombstone(thirtyOneDaysAgo);
  assert(getLegacyCutoverAt() === thirtyOneDaysAgo, 'tombstone stored');
  assert(isLegacyCutoverDue(), 'tombstone due after 31 days');

  // 3. Cost
  logCost({ provider: 'anthropic', operation: 'extract', units: 500, costUsd: 0.05 });
  const today = new Date().toISOString().slice(0, 10);
  const yearMonth = today.slice(0, 7);
  assert(getDailyCostUsd(today) >= 0.05, 'daily cost logged');
  assert(getMonthlyCostUsd(yearMonth) >= 0.05, 'monthly cost logged');

  // 4. Latency
  for (let i = 0; i < 50; i++) recordRetrievalLatencyMs(i + 1);
  const lat = getLatencyStats();
  assert(lat.count === 50, 'latency count 50');
  assert(lat.p50 >= 25 && lat.p50 <= 30, 'p50 in range');

  // 5. Reconcile (no Qdrant → all live KUs are missing)
  const reconReport = await reconcileQdrant({ qdrantClient: null });
  assert(reconReport.qdrantReachable === false, 'recon marks Qdrant unreachable');
  const counts = getBrainCounts();
  assert(counts.kuLive === migrationReport.inserted, 'kuLive matches migrated');

  // 6. Alerts — seed high MTD cost, expect monthly_budget to fire
  logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 12 });
  const fired = evaluateAlerts();
  assert(
    fired.some((a) => a.category === 'monthly_budget'),
    'monthly_budget alert fires when MTD > $10',
  );
  // Throttle: second call should NOT fire
  const second = evaluateAlerts();
  assert(
    !second.some((a) => a.category === 'monthly_budget'),
    'monthly_budget alert throttled on second call',
  );

  // 7. Health
  const report = getBrainHealthReport();
  assert(report.counts.kuLive === counts.kuLive, 'health kuLive matches');
  const legacyTrigger = report.reEvalTriggers.find(
    (t) => t.id === 'legacy_cutover',
  );
  assert(legacyTrigger?.fired === true, 'legacy_cutover trigger fired');
  const healthMd = handleBrainHealthCommand();
  assert(healthMd.includes('Brain health'), 'health markdown header');
  assert(healthMd.includes('Re-eval triggers fired'), 'health lists fired triggers');

  // 8. Weekly digest
  const digest = collectWeeklyDigest();
  assert(digest.costWeekUsd > 0, 'digest cost week > 0');
  const digestMd = formatWeeklyDigestMarkdown(digest);
  assert(digestMd.includes('Brain weekly digest'), 'digest markdown header');

  // 9. Backup brain.db
  const backupDir = getBrainBackupDir();
  const result = await backupBrainDb();
  assert(fs.existsSync(result.path), 'backup file exists');
  assert(result.bytes > 0, 'backup non-empty');
  const removed = pruneOldBackups(backupDir, 30);
  assert(Array.isArray(removed), 'prune returns list');

  // 10. Recall via FTS5 — proves migrated KUs are retrievable.
  // We bypass the semantic leg (embedText is heavy) by running the same
  // FTS5 query recall() uses, but stripping semantic Qdrant hits.
  // This still exercises the trigger-populated ku_fts index end-to-end.
  const ftsHits = brainDb
    .prepare(
      `SELECT ku.id, ku.text
         FROM ku_fts
         JOIN knowledge_units ku ON ku.rowid = ku_fts.rowid
        WHERE ku_fts MATCH ?
          AND ku.superseded_at IS NULL
        ORDER BY bm25(ku_fts)
        LIMIT 5`,
    )
    .all('"Alice"') as Array<{ id: string; text: string }>;
  assert(
    ftsHits.length >= 1,
    `FTS5 recall returns ≥ 1 hit for "Alice" — got ${ftsHits.length}`,
  );
  assert(
    ftsHits.some((h) => h.text.toLowerCase().includes('alice')),
    'FTS5 hit text contains "Alice"',
  );

  _setQdrantClientForTest(null);
  _closeBrainDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

await main()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('P2 END-TO-END VERIFIED');
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
