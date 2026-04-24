/**
 * Re-embed every live KU from brain.db back into Qdrant.
 *
 * Used as the recovery path when the Qdrant collection is lost or rebuilt
 * at a new dimensionality. Idempotent — upserts by UUIDv5(ku_id).
 *
 * Usage:
 *   npx tsx scripts/reembed-all.ts                 # re-embed all live KUs
 *   npx tsx scripts/reembed-all.ts --limit 1000    # dry-test on a small slice
 */

import { getBrainDb } from '../src/brain/db.js';
import { embedText, getEmbeddingModelVersion } from '../src/brain/embed.js';
import { ensureBrainCollection, upsertKu } from '../src/brain/qdrant.js';

interface Row {
  id: string;
  text: string;
  source_type: string;
  account: 'personal' | 'work';
  scope: string | null;
  valid_from: string;
  recorded_at: string;
  topic_key: string | null;
}

/* eslint-disable no-console */
async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i].startsWith('--')) {
      args.set(process.argv[i].slice(2), process.argv[i + 1]);
    }
  }
  const limit = args.has('limit') ? Number(args.get('limit')) : undefined;

  await ensureBrainCollection();

  const db = getBrainDb();
  const sql = `SELECT id, text, source_type, account, scope, valid_from, recorded_at, topic_key
                 FROM knowledge_units
                WHERE superseded_at IS NULL
                ORDER BY recorded_at ASC
                ${limit ? `LIMIT ${Number(limit)}` : ''}`;
  const rows = db.prepare(sql).all() as Row[];
  console.log(`re-embed: ${rows.length} KU rows`);

  const modelVersion = getEmbeddingModelVersion();
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const vec = await embedText(r.text, 'document');
      await upsertKu({
        kuId: r.id,
        vector: vec,
        payload: {
          account: r.account,
          scope: r.scope ? (JSON.parse(r.scope) as string[]) : null,
          model_version: modelVersion,
          valid_from: r.valid_from,
          recorded_at: r.recorded_at,
          source_type: r.source_type,
          topic_key: r.topic_key,
        },
      });
      ok++;
    } catch (err) {
      failed++;
      console.error(
        `  row ${i} (${r.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  progress: ${i + 1}/${rows.length}  ok=${ok} failed=${failed}`);
    }
  }
  console.log(`\n✅ re-embed done. ok=${ok} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error('re-embed failed:', err);
  process.exit(1);
});
