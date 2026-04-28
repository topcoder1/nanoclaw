/**
 * One-off verification that the drive-resolver bug fix works end-to-end:
 *
 *   1. Pull the WXA v1.5 deck from the actual raw_events row that came in
 *      via Gmail SSE (source_ref = '19dcfbadfb439fc8').
 *   2. Run extractDriveLinks on the email body — must find the
 *      docs.google.com/presentation link.
 *   3. Call productionDriveFetcher (whoisxml token) to export the deck
 *      to plain text.
 *   4. ingestDriveDoc into brain.db with source_type='drive',
 *      source_ref='presentation:1uni_NDswu-oTNUpT_h_3sRcxgbrdCbdj5nbaoBtF0Ss'.
 *   5. Read the row back and print a content preview.
 *
 * Run from the main repo so PROJECT_ROOT (= process.cwd()) resolves
 * STORE_DIR to /Users/topcoder1/dev/nanoclaw/store/brain.db:
 *
 *   cd ~/dev/nanoclaw && \
 *     npx tsx .claude/worktrees/pedantic-aryabhata-60b3e6/scripts/verify-drive-resolver.ts
 */
import { getBrainDb } from '../src/brain/db.js';
import {
  extractDriveLinks,
  ingestDriveDoc,
} from '../src/brain/drive-resolver.js';
import { productionDriveFetcher } from '../src/drive-fetcher.js';

const SOURCE_REF = '19dcfbadfb439fc8';

interface RawEventRow {
  payload: Buffer;
  received_at: string;
}

interface ParsedEmail {
  thread_id: string;
  account?: string;
  subject?: string;
  sender?: string;
  snippet?: string;
  body?: string;
}

async function main(): Promise<void> {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT payload, received_at FROM raw_events
        WHERE source_type = 'email' AND source_ref = ?`,
    )
    .get(SOURCE_REF) as RawEventRow | undefined;
  if (!row) {
    console.error(`No raw_event with source_ref=${SOURCE_REF}`);
    process.exit(2);
  }
  const email = JSON.parse(row.payload.toString('utf8')) as ParsedEmail;
  const bodyText = email.body ?? email.snippet ?? '';
  const haystack = [email.subject ?? '', bodyText].filter(Boolean).join('\n');
  console.log(
    `email subject:    ${email.subject}\n` +
      `email account:    ${email.account}\n` +
      `body length:      ${bodyText.length}\n`,
  );

  const links = extractDriveLinks(haystack);
  console.log(`drive links detected: ${links.length}`);
  for (const l of links) console.log(`  - ${l.kind} ${l.fileId}  ${l.url}`);
  if (links.length === 0) {
    console.error('FAIL: no Drive links detected in email body');
    process.exit(1);
  }

  const account = email.account ?? 'whoisxml';
  for (const link of links) {
    console.log(`\nfetching ${link.kind} ${link.fileId} via ${account} token …`);
    const doc = await productionDriveFetcher(account, link);
    if (!doc) {
      console.error(`  FAIL: fetcher returned null for ${link.fileId}`);
      continue;
    }
    console.log(`  title:    ${doc.title}`);
    console.log(`  text len: ${doc.text.length}`);
    console.log(`  preview:  ${doc.text.slice(0, 200).replace(/\n/g, ' ')}…`);

    const kuId = await ingestDriveDoc(db, link, doc, {
      accountBucket: account === 'personal' ? 'personal' : 'work',
      validFromIso: row.received_at,
      extractedBy: 'verify-drive-resolver',
      extractionChain: [],
    });
    console.log(`  ingested KU: ${kuId}`);
  }

  // Read it back to prove durability.
  console.log('\n--- knowledge_units rows for source_type=drive ---');
  const drives = db
    .prepare(
      `SELECT id, source_ref, account, length(text) AS len,
              substr(text, 1, 240) AS preview, valid_from, recorded_at
         FROM knowledge_units
        WHERE source_type='drive'
        ORDER BY recorded_at DESC
        LIMIT 10`,
    )
    .all() as Array<{
    id: string;
    source_ref: string;
    account: string;
    len: number;
    preview: string;
    valid_from: string;
    recorded_at: string;
  }>;
  for (const r of drives) {
    console.log(
      `  ${r.id}  ${r.source_ref}  account=${r.account}  len=${r.len}\n` +
        `    valid_from=${r.valid_from}  recorded_at=${r.recorded_at}\n` +
        `    preview: ${r.preview.replace(/\n/g, ' ')}`,
    );
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
