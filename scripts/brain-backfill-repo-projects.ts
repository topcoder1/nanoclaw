/**
 * Backfill: turn each repo synced into the brain into a `project` entity
 * and link every repo KU to it via `ku_entities` (role='subject').
 *
 * Why this exists: `claw sync` writes `source_type='repo'` rows directly via
 * Python sqlite3 ([.claude/skills/claw/scripts/claw](.claude/skills/claw/scripts/claw))
 * and only ever populated `knowledge_units` — never `entities` or
 * `ku_entities`. Result: the /brain/entities Projects tab was empty even
 * though the brain held thousands of chunks across dozens of repos.
 *
 * Idempotent: re-running after another `claw sync` only does work for new
 * slugs / unlinked KU rows. Safe to run from cron.
 *
 * Usage:
 *   cd ~/dev/nanoclaw
 *   npx tsx scripts/brain-backfill-repo-projects.ts            # apply
 *   npx tsx scripts/brain-backfill-repo-projects.ts --dry-run  # report only
 */

import { getBrainDb } from '../src/brain/db.js';
import {
  _shutdownEntityQueue,
  createProjectFromRepoSlug,
  parseRepoSlugFromSourceRef,
} from '../src/brain/entities.js';

interface RepoRow {
  id: string;
  source_ref: string | null;
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: npx tsx scripts/brain-backfill-repo-projects.ts [--dry-run]',
      );
      process.exit(0);
    } else {
      console.error(`error: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const db = getBrainDb();

  const rows = db
    .prepare(
      `SELECT id, source_ref FROM knowledge_units
        WHERE source_type = 'repo' AND superseded_at IS NULL`,
    )
    .all() as RepoRow[];

  // Group KU ids by repo slug — skip rows we can't parse.
  const slugToKuIds = new Map<string, string[]>();
  let unparseable = 0;
  for (const r of rows) {
    const slug = parseRepoSlugFromSourceRef(r.source_ref);
    if (!slug) {
      unparseable++;
      continue;
    }
    const list = slugToKuIds.get(slug);
    if (list) list.push(r.id);
    else slugToKuIds.set(slug, [r.id]);
  }

  console.log(
    `Found ${rows.length} repo KUs across ${slugToKuIds.size} distinct slugs ` +
      `(${unparseable} unparseable refs)`,
  );

  if (dryRun) {
    const sorted = [...slugToKuIds.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [slug, ids] of sorted) {
      console.log(`  ${slug.padEnd(28)} ${ids.length} KUs`);
    }
    console.log('--dry-run: no changes written');
    return;
  }

  let createdEntities = 0;
  let linkedRows = 0;
  let alreadyLinked = 0;

  // ku_entities link is idempotent via the (ku_id, entity_id, role) PK.
  const linkStmt = db.prepare(
    `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role)
       VALUES (?, ?, 'subject')`,
  );

  for (const [slug, kuIds] of slugToKuIds) {
    // Treat first sight as "created"; createProjectFromRepoSlug is itself
    // idempotent so re-runs short-circuit. We compare against the count to
    // detect whether this run actually created the row.
    const before = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM entities WHERE entity_type='project'`,
        )
        .get() as { n: number }
    ).n;
    const project = await createProjectFromRepoSlug(slug);
    const after = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM entities WHERE entity_type='project'`,
        )
        .get() as { n: number }
    ).n;
    if (after > before) createdEntities++;

    const txn = db.transaction((ids: string[]) => {
      for (const id of ids) {
        const result = linkStmt.run(id, project.entity_id);
        if (result.changes > 0) linkedRows++;
        else alreadyLinked++;
      }
    });
    txn(kuIds);

    console.log(
      `  ${slug.padEnd(28)} ${kuIds.length} KUs -> entity ${project.entity_id}`,
    );
  }

  // Drain the entity write queue so the process exits cleanly.
  await _shutdownEntityQueue();

  console.log('');
  console.log('Summary:');
  console.log(`  project entities created : ${createdEntities}`);
  console.log(`  ku_entities rows inserted: ${linkedRows}`);
  console.log(`  ku_entities already there: ${alreadyLinked}`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
