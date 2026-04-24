/**
 * End-to-end smoke test for brain P1 — FTS5-only path.
 *
 *   synthetic KU + raw_event → recall("...") → scored result
 *
 * This script exercises the SQLite + FTS5 + scoring path end-to-end
 * without requiring Qdrant or the transformer models. For the full
 * pipeline (extract → embed → upsert) see
 * `src/brain/__tests__/ingest-pipeline.test.ts`.
 *
 * Run with:  npx tsx scripts/brain-p1-smoke.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// Force STORE_DIR to a temp dir BEFORE importing any brain module.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p1-smoke-'));
process.chdir(tmpDir);
process.env.LOG_LEVEL = 'warn';

// These imports will initialize brain.db inside tmpDir/store/.
const { getBrainDb, _closeBrainDb } = await import('../src/brain/db.js');
const { newId } = await import('../src/brain/ulid.js');
const {
  finalScore,
  recencyScore,
  accessScore,
  rrf,
} = await import('../src/brain/retrieve.js');

async function main(): Promise<void> {
  const db = getBrainDb();

  // Seed a raw_event + KU so FTS5 + scoring math can run end-to-end.
  const kuId = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
     VALUES (?, 'email', 'thread-smoke', ?, ?, ?)`,
  ).run(newId(), Buffer.from('{}'), now, now);
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, confidence,
        valid_from, recorded_at, topic_key, access_count)
     VALUES (?, ?, 'email', 'thread-smoke', 'work', 0.9, ?, ?, 'topic-abc', 3)`,
  ).run(kuId, 'Alice confirmed Acme renewal at $120K for FY26.', now, now);

  // FTS5 path — should find the seeded KU.
  const rows = db
    .prepare(
      `SELECT ku.id
         FROM ku_fts
         JOIN knowledge_units ku ON ku.rowid = ku_fts.rowid
        WHERE ku_fts MATCH '"Acme" OR "renewal"'`,
    )
    .all() as { id: string }[];
  if (rows.length === 0) {
    throw new Error('smoke: FTS5 returned no rows — seed path broken');
  }
  if (rows[0].id !== kuId) {
    throw new Error(`smoke: expected KU ${kuId}, got ${rows[0].id}`);
  }

  // Exercise scoring math directly.
  const fused = rrf([[kuId], [kuId]], 60);
  const nowMs = Date.now();
  const recency = recencyScore(Date.parse(now), nowMs, 180 * 24 * 3600e3);
  const access = accessScore(3);
  const rank = fused[0].score;
  const final = finalScore(rank, recency, access);
  const expected = 0.7 * rank + 0.2 * recency + 0.1 * access;
  if (Math.abs(final - expected) > 1e-9) {
    throw new Error(
      `smoke: finalScore mismatch: ${final} vs ${expected}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log('✅ brain-p1 smoke passed');
  // eslint-disable-next-line no-console
  console.log(
    `   FTS5 hit: ${kuId}  final=${final.toFixed(3)}  (rank=${rank.toFixed(3)} recency=${recency.toFixed(3)} access=${access.toFixed(3)})`,
  );

  _closeBrainDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ brain-p1 smoke failed:', err);
  process.exit(1);
});
