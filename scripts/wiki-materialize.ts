/**
 * Manual full wiki rebuild. Walks every entity in brain.db and writes its
 * markdown page to ${STORE_DIR}/wiki/, then rebuilds the index.
 *
 * Usage:
 *   npx tsx scripts/wiki-materialize.ts            # deterministic only
 *   npx tsx scripts/wiki-materialize.ts --synthesize  # also refresh LLM summaries
 *
 * The automatic version runs via `startWikiSynthesisSchedule` from
 * src/index.ts; this CLI is for out-of-band runs, smoke tests, and
 * one-off rebuilds after schema changes.
 */

import { STORE_DIR } from '../src/config.js';
import {
  appendLog,
  materializeAll,
  rebuildIndex,
} from '../src/brain/wiki-writer.js';

async function main(): Promise<void> {
  const synthesize = process.argv.includes('--synthesize');
  const start = Date.now();
  const counts = await materializeAll(STORE_DIR, { synthesize });
  await rebuildIndex(STORE_DIR);
  const elapsedMs = Date.now() - start;
  const line =
    `[${new Date().toISOString()}] manual rebuild: ` +
    `created=${counts.created} updated=${counts.updated} ` +
    `unchanged=${counts.unchanged} failed=${counts.failed} ` +
    `synthesize=${synthesize} elapsed_ms=${elapsedMs}`;
  await appendLog(STORE_DIR, line);
  // eslint-disable-next-line no-console
  console.log(line);
  if (counts.failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Failures:');
    for (const f of counts.failures) {
      // eslint-disable-next-line no-console
      console.error(`  ${f.path}: ${f.err}`);
    }
    process.exit(1);
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('wiki-materialize failed:', err);
  process.exit(1);
});
