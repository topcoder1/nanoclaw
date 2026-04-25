/**
 * Embed repo-source knowledge_units into the brain Qdrant collection.
 *
 * v1.1 of the second-brain delivery (see `.omc/design/second-brain-v1.md`).
 * `claw sync` writes `source_type='repo'` rows directly to brain.db via
 * Python sqlite3 — that path deliberately skips Node and embeddings to
 * stay fast and dep-free. This script is the semantic follow-up: it
 * finds repo KUs that don't yet have a Qdrant point and embeds them with
 * the same Nomic 768-d model the email ingest pipeline uses.
 *
 * Idempotent: a `retrieve` pass batches existing point IDs so we skip
 * anything already embedded. Safe to run after every `claw sync`.
 *
 * Usage:
 *   cd ~/dev/nanoclaw
 *   npx tsx scripts/brain-embed-repos.ts              # embed missing
 *   npx tsx scripts/brain-embed-repos.ts --force      # re-embed everything
 *   npx tsx scripts/brain-embed-repos.ts --limit 100  # cap per run
 */

import { QdrantClient } from '@qdrant/js-client-rest';

import { QDRANT_URL } from '../src/config.js';
import { getBrainDb } from '../src/brain/db.js';
import { embedText, getEmbeddingModelVersion } from '../src/brain/embed.js';
import {
  _shutdownEntityQueue,
  createProjectFromRepoSlug,
  parseRepoSlugFromSourceRef,
} from '../src/brain/entities.js';
import {
  BRAIN_COLLECTION,
  ensureBrainCollection,
  kuPointId,
  upsertKu,
} from '../src/brain/qdrant.js';

interface RepoRow {
  id: string;
  text: string;
  account: 'personal' | 'work';
  source_ref: string | null;
  valid_from: string;
  recorded_at: string;
  topic_key: string | null;
}

function parseArgs(argv: string[]): { force: boolean; limit: number | null } {
  let force = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--limit') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`error: --limit requires a positive integer`);
        process.exit(2);
      }
      limit = n;
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: npx tsx scripts/brain-embed-repos.ts [--force] [--limit N]',
      );
      process.exit(0);
    } else {
      console.error(`error: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return { force, limit };
}

/**
 * Batched Qdrant retrieve to find which of `ids` already have points.
 * Returns a Set of Qdrant-UUID point ids that exist.
 */
async function findExistingPointIds(
  client: QdrantClient,
  pointIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const BATCH = 500;
  for (let i = 0; i < pointIds.length; i += BATCH) {
    const batch = pointIds.slice(i, i + BATCH);
    try {
      const result = await client.retrieve(BRAIN_COLLECTION, {
        ids: batch,
        with_payload: false,
        with_vector: false,
      });
      for (const p of result) existing.add(String(p.id));
    } catch (err) {
      // Collection may not exist yet on a fresh install — ensureBrainCollection
      // runs earlier, so this is a genuine problem. Surface but continue: a
      // subsequent upsert will create points.
      console.warn(
        `warning: retrieve batch failed (${(err as Error).message}) — ` +
          `will upsert without skip check`,
      );
    }
  }
  return existing;
}

async function main(): Promise<void> {
  const { force, limit } = parseArgs(process.argv.slice(2));

  if (!QDRANT_URL) {
    console.error(
      'error: QDRANT_URL not set — cannot write embeddings. ' +
        'Set it in .env or skip this step.',
    );
    process.exit(2);
  }

  const db = getBrainDb();
  await ensureBrainCollection();

  const rows = db
    .prepare(
      `SELECT id, text, account, source_ref, valid_from, recorded_at, topic_key
         FROM knowledge_units
        WHERE source_type = 'repo'
          AND superseded_at IS NULL
        ORDER BY recorded_at ASC`,
    )
    .all() as RepoRow[];

  if (rows.length === 0) {
    console.log('No repo KUs found — nothing to embed.');
    return;
  }

  const client = new QdrantClient({ url: QDRANT_URL });
  const pointIds = rows.map((r) => kuPointId(r.id));

  let existing: Set<string>;
  if (force) {
    existing = new Set();
    console.log(`--force: re-embedding all ${rows.length} repo KU(s)`);
  } else {
    existing = await findExistingPointIds(client, pointIds);
    console.log(
      `Found ${existing.size} / ${rows.length} repo KU(s) already in Qdrant`,
    );
  }

  const todo = rows.filter((r) => !existing.has(kuPointId(r.id)));
  const work = limit ? todo.slice(0, limit) : todo;
  if (work.length === 0) {
    console.log('All repo KUs already embedded — nothing to do.');
    return;
  }
  console.log(
    `Embedding ${work.length}${limit && todo.length > limit ? ` (of ${todo.length} pending; capped by --limit)` : ''}...`,
  );

  const modelVersion = getEmbeddingModelVersion();
  const startMs = Date.now();
  let done = 0;
  let failed = 0;

  // Nomic's context window is 8192 tokens ≈ ~32KB of typical prose; to stay
  // comfortably under we cap raw input at 28KB before embedding. If the full
  // embed still fails (rare), we retry once at a tighter 12KB cap — empirically
  // enough to ship something for files that trip the tokenizer on unusual
  // whitespace/unicode. Either truncation is a v1.1 compromise: v1.2's code
  // indexer will chunk by symbol boundaries and drop the cap.
  const SOFT_CAP_BYTES = 28 * 1024;
  const HARD_CAP_BYTES = 12 * 1024;
  let truncated = 0;

  for (const row of work) {
    let text = row.text;
    if (text.length > SOFT_CAP_BYTES) {
      text = text.slice(0, SOFT_CAP_BYTES);
      truncated++;
    }
    try {
      const vec = await embedText(text, 'document');
      await upsertKu({
        kuId: row.id,
        vector: vec,
        payload: {
          account: row.account,
          scope: null,
          model_version: modelVersion,
          valid_from: row.valid_from,
          recorded_at: row.recorded_at,
          source_type: 'repo',
          topic_key: row.topic_key ?? null,
          source_ref: row.source_ref ?? null,
        },
      });
      done++;
      if (done % 50 === 0 || done === work.length) {
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(`  ${done}/${work.length}  (${elapsed}s)`);
      }
    } catch (err) {
      // Retry once at the hard cap — covers the ~10% of failures caused by
      // token-dense content (code blocks, base64, minified JSON in docs) that
      // slips through the soft cap.
      try {
        const retryText = text.slice(0, HARD_CAP_BYTES);
        const vec = await embedText(retryText, 'document');
        await upsertKu({
          kuId: row.id,
          vector: vec,
          payload: {
            account: row.account,
            scope: null,
            model_version: modelVersion,
            valid_from: row.valid_from,
            recorded_at: row.recorded_at,
            source_type: 'repo',
            topic_key: row.topic_key ?? null,
            source_ref: row.source_ref ?? null,
            truncated_to_bytes: HARD_CAP_BYTES,
          },
        });
        done++;
        truncated++;
      } catch (err2) {
        failed++;
        console.warn(
          `  ✗ ${row.source_ref ?? row.id} — ${(err2 as Error).message}`,
        );
      }
    }
  }

  const totalS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `Done: ${done} embedded, ${failed} failed, ${truncated} truncated, ` +
      `${totalS}s total (${(done / parseFloat(totalS || '1')).toFixed(1)} docs/s)`,
  );

  // Repo → project entity wiring. claw sync writes KUs but doesn't touch
  // the entities table; we close the loop here so the /brain/entities
  // Projects tab stays populated. Idempotent — both calls short-circuit
  // when the project / link already exists.
  const slugToKuIds = new Map<string, string[]>();
  for (const r of rows) {
    const slug = parseRepoSlugFromSourceRef(r.source_ref);
    if (!slug) continue;
    const list = slugToKuIds.get(slug);
    if (list) list.push(r.id);
    else slugToKuIds.set(slug, [r.id]);
  }
  if (slugToKuIds.size > 0) {
    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role)
         VALUES (?, ?, 'subject')`,
    );
    let linked = 0;
    for (const [slug, kuIds] of slugToKuIds) {
      const project = await createProjectFromRepoSlug(slug);
      const txn = db.transaction((ids: string[]) => {
        for (const id of ids) {
          const result = linkStmt.run(id, project.entity_id);
          if (result.changes > 0) linked++;
        }
      });
      txn(kuIds);
    }
    await _shutdownEntityQueue();
    console.log(
      `Project entities: ${slugToKuIds.size} repo slug(s), ` +
        `${linked} new ku_entities link(s)`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
