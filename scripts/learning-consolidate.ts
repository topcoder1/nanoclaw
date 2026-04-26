/**
 * LLM-driven consolidation pass over learned procedures.
 *
 * Reads procedures from the file store, clusters near-duplicates by step
 * overlap (>=0.7), asks the utility LLM to merge each cluster, and writes
 * a JSON report + per-cluster candidate files. Originals are NOT modified —
 * a human accepts candidates manually (out of scope for this script).
 *
 * Usage:
 *   npx tsx scripts/learning-consolidate.ts              # all (global) procedures
 *   npx tsx scripts/learning-consolidate.ts <groupId>    # group-scoped
 */

import { runConsolidation } from '../src/learning/consolidator.js';

const groupId = process.argv[2];

(async () => {
  const result = await runConsolidation({ groupId });
  // eslint-disable-next-line no-console
  console.log(
    `Consolidation complete\n` +
      `  group: ${groupId ?? '(global only)'}\n` +
      `  procedures scanned: ${result.totalProcedures}\n` +
      `  clusters found: ${result.clustersFound}\n` +
      `  proposals: ${result.clusters.filter((c) => c.proposed).length}\n` +
      `  report: ${result.reportPath ?? '(none)'}\n` +
      `  candidates: ${result.candidatesDir ?? '(none)'}\n`,
  );
  for (const c of result.clusters) {
    if (c.proposed) {
      // eslint-disable-next-line no-console
      console.log(
        `  ✓ ${c.proposed.name}  ⟵  ${c.members.join(', ')}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`  ✗ [${c.error}] ${c.members.join(', ')}`);
    }
  }
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
