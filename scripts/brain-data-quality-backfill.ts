/**
 * One-shot backfill for the two data-quality issues fixed in
 * "fix(brain): readable canonical + topic_key for wiki layer":
 *
 *   1. Person entities created with NULL canonical (renderer falls
 *      through to ULID title). Backfill `canonical = {"email": ...}`
 *      from each person's email alias.
 *
 *   2. KU rows where `topic_key` is a 64-char SHA256 hex hash (the old
 *      shape). NULL them out so the wiki renderer groups them under
 *      `### Other` instead of `### 2f46699c…`. We can't recover the
 *      original `topic_seed` (it was never persisted), so this is the
 *      best we can do without re-extracting.
 *
 * Idempotent: re-running is a no-op once the rows are clean.
 *
 * Usage:
 *   npx tsx scripts/brain-data-quality-backfill.ts            # writes to STORE_DIR/brain.db
 *   npx tsx scripts/brain-data-quality-backfill.ts --dry-run  # report counts only
 */

import { getBrainDb } from '../src/brain/db.js';

const dryRun = process.argv.includes('--dry-run');
const HASH_RE = /^[a-f0-9]{64}$/;

const db = getBrainDb();

// ---- 1. Backfill person canonical from email alias ---------------------
const personRows = db
  .prepare(
    `SELECT e.entity_id, a.field_value AS email
       FROM entities e
       LEFT JOIN entity_aliases a
         ON a.entity_id = e.entity_id
        AND a.field_name = 'email'
        AND a.valid_until IS NULL
      WHERE e.entity_type = 'person'
        AND e.canonical IS NULL`,
  )
  .all() as Array<{ entity_id: string; email: string | null }>;

let personsBackfilled = 0;
let personsSkipped = 0;
const updateCanonical = db.prepare(
  `UPDATE entities SET canonical = ?, updated_at = ? WHERE entity_id = ?`,
);
const now = new Date().toISOString();
for (const r of personRows) {
  if (!r.email) {
    personsSkipped++;
    continue;
  }
  const canonical = JSON.stringify({ email: r.email });
  if (!dryRun) updateCanonical.run(canonical, now, r.entity_id);
  personsBackfilled++;
}

// ---- 2. NULL out hash-shaped topic_keys --------------------------------
const hashKuRows = db
  .prepare(
    `SELECT id, topic_key FROM knowledge_units WHERE topic_key IS NOT NULL`,
  )
  .all() as Array<{ id: string; topic_key: string }>;

let hashesScrubbed = 0;
const nullTopicKey = db.prepare(
  `UPDATE knowledge_units SET topic_key = NULL WHERE id = ?`,
);
for (const r of hashKuRows) {
  if (HASH_RE.test(r.topic_key)) {
    if (!dryRun) nullTopicKey.run(r.id);
    hashesScrubbed++;
  }
}

// eslint-disable-next-line no-console
console.log(
  `${dryRun ? '[dry-run] ' : ''}` +
    `persons_backfilled=${personsBackfilled} ` +
    `persons_skipped_no_email=${personsSkipped} ` +
    `topic_keys_nulled=${hashesScrubbed}`,
);
