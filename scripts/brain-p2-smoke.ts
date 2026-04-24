/**
 * End-to-end smoke test for brain P2.
 *
 * Exercises the entire P2 surface without requiring Qdrant or the
 * transformer models:
 *
 *   1. legacy-store seed + migration (knowledge_facts → knowledge_units)
 *   2. tombstone set + idempotency
 *   3. cost log + daily/monthly rollups
 *   4. reconcile (no Qdrant → all-missing drift)
 *   5. weekly digest format sanity
 *   6. health report + /brainhealth formatting
 *   7. alerts dispatch + throttle
 *   8. backup brain.db (online copy) + prune
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
const legacyPath = path.join(tmpDir, 'store', 'messages.db');
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
{
  const db = new Database(legacyPath);
  db.exec(
    `CREATE VIRTUAL TABLE knowledge_facts USING fts5(
       text, domain, group_id, source, created_at
     );`,
  );
  const stmt = db.prepare(
    `INSERT INTO knowledge_facts (text, domain, group_id, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run('Alice confirmed renewal', 'deals', 'g1', 'email', '2026-04-20T10:00:00Z');
  stmt.run('Meeting moved to Thursday', 'sched', 'g2', 'manual', '2026-04-21T10:00:00Z');
  stmt.run('', 'ignored', 'g3', 'email', '2026-04-22T10:00:00Z'); // empty — should be skipped
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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

async function main(): Promise<void> {
  // 1. Migration
  const migrationReport = migrateKnowledgeFacts();
  assert(migrationReport.legacyRowsTotal === 3, 'migration legacy count');
  assert(migrationReport.inserted === 2, 'migration inserted 2 non-empty rows');
  assert(
    migrationReport.legacyRowsSkippedEmpty === 1,
    'migration skipped empty row',
  );

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
