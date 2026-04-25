/**
 * Backfill: re-extract email raw_events that were wrongly skipped by the
 * stale `classification='digest'` filter. See git history of
 * `src/brain/transactional-filter.ts` — the v1.1 triage migration made
 * `classification='digest'` a catch-all default, so the brain refused to
 * extract from any post-migration email regardless of its actual
 * `queue` ('attention'/'action'/'archive_candidate'/'ignore').
 *
 * Selection criteria: raw_events where source_type='email' AND
 * processed_at IS NOT NULL (already "processed" by being skipped) AND
 * the matching tracked_items row has queue NOT IN
 * ('archive_candidate','ignore'). The new filter would extract these.
 *
 * Idempotency: re-running risks duplicate KUs because the pipeline
 * INSERTs unconditionally. Default behavior reprocesses only events
 * with NO existing brain KU on that thread — this short-circuits the
 * common "ran it twice" case while still recovering everything that
 * was lost.
 *
 * Usage:
 *   cd ~/dev/nanoclaw
 *   npx tsx /path/to/scripts/brain-backfill-skipped-emails.ts --dry-run
 *   npx tsx /path/to/scripts/brain-backfill-skipped-emails.ts
 *
 * Pass --since '<ISO>' to limit to events after a cutoff (default:
 * 2026-04-24T06:13:17Z, the last successful KU before the filter bug
 * silently kicked in).
 */

import path from 'path';

import Database from 'better-sqlite3';

import { getBrainDb } from '../src/brain/db.js';
import {
  runExtractionPipeline,
  type ParsedEmail,
  type RawEventRow,
} from '../src/brain/ingest.js';
import { STORE_DIR } from '../src/config.js';

interface CliOpts {
  dryRun: boolean;
  since: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    dryRun: false,
    since: '2026-04-24T06:13:17.008Z',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--since') opts.since = argv[++i] ?? opts.since;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: brain-backfill-skipped-emails [--dry-run] [--since ISO]',
      );
      process.exit(0);
    } else {
      console.error(`error: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

interface Candidate {
  id: string;
  source_ref: string;
  received_at: string;
  payload: Buffer;
  thread_id: string;
  queue: string | null;
  has_existing_ku: number;
}

async function main(): Promise<void> {
  const { dryRun, since } = parseArgs(process.argv.slice(2));
  const brainDb = getBrainDb();

  // tracked_items lives in nanoclaw's messages.db, not brain.db. Attach so
  // we can join in a single query.
  const messagesDbPath = path.join(STORE_DIR, 'messages.db');
  brainDb.exec(`ATTACH '${messagesDbPath}' AS mdb`);

  const rows = brainDb
    .prepare(
      `SELECT
         r.id,
         r.source_ref,
         r.received_at,
         r.payload,
         json_extract(r.payload, '$.thread_id') AS thread_id,
         t.queue AS queue,
         (SELECT COUNT(*) FROM knowledge_units ku
            WHERE ku.source_type = 'email'
              AND ku.source_ref = json_extract(r.payload, '$.thread_id')
              AND ku.superseded_at IS NULL) AS has_existing_ku
       FROM raw_events r
       LEFT JOIN mdb.tracked_items t
         ON t.thread_id = json_extract(r.payload, '$.thread_id')
       WHERE r.source_type = 'email'
         AND r.processed_at IS NOT NULL
         AND r.received_at > ?
         AND (t.queue IS NULL OR t.queue NOT IN ('archive_candidate', 'ignore'))
       ORDER BY r.received_at ASC`,
    )
    .all(since) as Candidate[];

  // Detach (best-effort).
  try {
    brainDb.exec(`DETACH mdb`);
  } catch {
    /* ignore */
  }

  console.log(
    `Found ${rows.length} candidate raw_event(s) since ${since} that should ` +
      `extract under the fixed filter`,
  );

  const skippedDup = rows.filter((r) => r.has_existing_ku > 0);
  const work = rows.filter((r) => r.has_existing_ku === 0);

  for (const r of skippedDup) {
    console.log(
      `  skip (already has KU)  ${r.source_ref}  queue=${r.queue ?? 'null'}`,
    );
  }
  for (const r of work) {
    console.log(
      `  reprocess              ${r.source_ref}  queue=${r.queue ?? 'null'}`,
    );
  }

  if (dryRun) {
    console.log(
      `--dry-run: would reprocess ${work.length}, skip ${skippedDup.length}`,
    );
    return;
  }

  if (work.length === 0) {
    console.log('Nothing to reprocess.');
    return;
  }

  let extracted = 0;
  let failed = 0;
  let kusBefore = (
    brainDb
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_units WHERE source_type='email'`)
      .get() as { n: number }
  ).n;

  for (const row of work) {
    let parsed: ParsedEmail;
    try {
      parsed = JSON.parse(row.payload.toString('utf8')) as ParsedEmail;
    } catch (err) {
      console.warn(
        `  ✗ parse failed: ${row.source_ref} — ${(err as Error).message}`,
      );
      failed++;
      continue;
    }
    const eventRow: RawEventRow = {
      id: row.id,
      source_type: 'email',
      source_ref: row.source_ref,
      payload: row.payload,
      received_at: row.received_at,
      parsedEmail: parsed,
    };
    try {
      await runExtractionPipeline(brainDb, eventRow);
      extracted++;
    } catch (err) {
      failed++;
      console.warn(
        `  ✗ ${row.source_ref} — ${(err as Error).message}`,
      );
    }
  }

  const kusAfter = (
    brainDb
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_units WHERE source_type='email'`)
      .get() as { n: number }
  ).n;

  console.log('');
  console.log('Summary:');
  console.log(`  reprocessed         : ${extracted}`);
  console.log(`  failed              : ${failed}`);
  console.log(`  skipped (had KU)    : ${skippedDup.length}`);
  console.log(`  email KUs before    : ${kusBefore}`);
  console.log(`  email KUs after     : ${kusAfter}`);
  console.log(`  net new KUs         : ${kusAfter - kusBefore}`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
