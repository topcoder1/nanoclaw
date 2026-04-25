/**
 * Embed `source_type='note'` knowledge_units into the brain Qdrant
 * collection. `claw save` writes notes directly to brain.db (FTS5
 * indexed at insert time) but doesn't compute embeddings, so semantic
 * recall and the cross-encoder rerank can't reach them. This script is
 * the semantic follow-up — analogous to brain-embed-repos.ts.
 *
 * Idempotent: a Qdrant retrieve pass identifies points already embedded,
 * and only the missing ones get computed.
 *
 * Usage:
 *   npx tsx scripts/brain-embed-notes.ts              # embed missing
 *   npx tsx scripts/brain-embed-notes.ts --force      # re-embed all notes
 *   npx tsx scripts/brain-embed-notes.ts --limit 100  # cap per run
 */

import { QdrantClient } from '@qdrant/js-client-rest';

import { getBrainDb } from '../src/brain/db.js';
import { embedText, getEmbeddingModelVersion } from '../src/brain/embed.js';
import { kuPointId, upsertKu } from '../src/brain/qdrant.js';
import { QDRANT_URL } from '../src/config.js';

const COLLECTION = 'ku_nomic-embed-text-v1.5_768';

interface NoteRow {
  id: string;
  text: string;
  account: string;
  source_type: string;
  source_ref: string | null;
  valid_from: string;
  recorded_at: string;
  tags: string | null;
  topic_key: string | null;
}

function parseArgs(argv: string[]): { force: boolean; limit: number | null } {
  let force = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') force = true;
    else if (argv[i] === '--limit') limit = parseInt(argv[++i] ?? '0', 10);
  }
  return { force, limit };
}

async function main(): Promise<void> {
  const { force, limit } = parseArgs(process.argv.slice(2));
  if (!QDRANT_URL) {
    console.error('error: QDRANT_URL not set');
    process.exit(2);
  }
  const client = new QdrantClient({ url: QDRANT_URL });
  const db = getBrainDb();

  const baseQuery = `SELECT id, text, account, source_type, source_ref,
                            valid_from, recorded_at, tags, topic_key
                     FROM knowledge_units
                     WHERE source_type = 'note'
                       AND superseded_at IS NULL
                     ORDER BY recorded_at DESC`;
  const sql = limit ? `${baseQuery} LIMIT ${limit}` : baseQuery;
  const rows = db.prepare(sql).all() as NoteRow[];
  console.log(`Found ${rows.length} note KU(s)`);

  if (rows.length === 0) return;

  const pointIds = rows.map((r) => kuPointId(r.id));
  const existing = force
    ? new Set<string>()
    : new Set(
        (
          await client.retrieve(COLLECTION, {
            ids: pointIds,
            with_payload: false,
            with_vector: false,
          })
        ).map((p) => String(p.id)),
      );

  const work = rows.filter((r) => !existing.has(kuPointId(r.id)));
  console.log(
    `${existing.size} already embedded, ${work.length} to embed (force=${force})`,
  );

  let done = 0;
  let failed = 0;
  const modelVersion = getEmbeddingModelVersion();

  for (const r of work) {
    try {
      const vector = await embedText(r.text);
      await upsertKu({
        kuId: r.id,
        vector,
        payload: {
          account: (r.account === 'work' ? 'work' : 'personal') as
            | 'personal'
            | 'work',
          scope: null,
          model_version: modelVersion,
          valid_from: r.valid_from,
          recorded_at: r.recorded_at,
          source_type: 'note',
          source_ref: r.source_ref,
          topic_key: r.topic_key,
          tags: r.tags ? JSON.parse(r.tags) : null,
        },
      });
      done++;
      console.log(`  ✓ ${r.id}  "${r.text.slice(0, 60)}..."`);
    } catch (err) {
      failed++;
      console.error(
        `  ✗ ${r.id}  ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  console.log('');
  console.log(`embedded:        ${done}`);
  console.log(`already present: ${existing.size}`);
  console.log(`failed:          ${failed}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
