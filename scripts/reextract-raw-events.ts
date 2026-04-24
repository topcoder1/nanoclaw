/**
 * One-shot: re-run the P1 extraction pipeline for previously-ingested
 * raw_events whose first pass missed the LLM tier (e.g. ANTHROPIC_BASE_URL
 * was shadowed by a stale shell env). Deletes the prior KUs + Qdrant points,
 * resets raw_events.processed_at, and calls processRawEvent fresh.
 *
 * Run from the main install so PROJECT_ROOT → ~/dev/nanoclaw/store/brain.db:
 *   cd ~/dev/nanoclaw && \
 *   ANTHROPIC_BASE_URL=https://api.anthropic.com/v1 \
 *   npx tsx .claude/worktrees/dazzling-turing-16eb94/scripts/reextract-raw-events.ts
 */

import { reprocessRawEvent } from '../src/brain/ingest.js';
import { getBrainDb } from '../src/brain/db.js';
import { _shutdownEntityQueue } from '../src/brain/entities.js';
import { _shutdownAccessQueue } from '../src/brain/retrieve.js';

const SOURCE_TYPE = 'email';
const SOURCE_REFS = [
  '19db563dcf06663e', // Stellar Cyber licensing — verifies 4096-token cap
];

async function main(): Promise<void> {
  const db = getBrainDb();
  for (const ref of SOURCE_REFS) {
    const before = db
      .prepare(
        'SELECT COUNT(*) AS n FROM knowledge_units WHERE source_ref = ?',
      )
      .get(ref) as { n: number };
    console.log(`[${ref}] before: ${before.n} KUs`);
    const { reprocessed, deletedKus } = await reprocessRawEvent(
      SOURCE_TYPE,
      ref,
    );
    const after = db
      .prepare(
        'SELECT COUNT(*) AS n, GROUP_CONCAT(DISTINCT extracted_by) AS tiers, GROUP_CONCAT(DISTINCT account) AS acct FROM knowledge_units WHERE source_ref = ?',
      )
      .get(ref) as { n: number; tiers: string | null; acct: string | null };
    console.log(
      `[${ref}] reprocessed=${reprocessed}  deleted=${deletedKus}  ` +
        `after=${after.n} KUs  tiers=${after.tiers ?? '-'}  account=${after.acct ?? '-'}`,
    );
  }
  await _shutdownEntityQueue();
  await _shutdownAccessQueue();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
