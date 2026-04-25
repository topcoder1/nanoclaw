/**
 * One-off backfill for jonathan.zhang@whoisxmlapi.com classifications that
 * SP triaged but never reached nanoclaw via SSE — the Gmail push subscription
 * was silently dead from 2026-04-01 to 2026-04-25, so all classifications in
 * that window arrived via SP's slower fallback path. SSE only emits future
 * classifications relative to the connection cursor, so those rows never made
 * it into raw_events.
 *
 * This script pulls /api/nanoclaw/triaged-emails for that account, then walks
 * each row through the same insert + extract path the live SSE handler uses
 * (raw_events INSERT OR IGNORE → runExtractionPipeline).
 *
 * Idempotent: raw_events is keyed on UNIQUE(source_type, source_ref). Running
 * twice is a no-op for any thread already ingested.
 *
 * Usage:
 *   npx tsx scripts/brain-backfill-jzhang-missed.ts --dry-run
 *   npx tsx scripts/brain-backfill-jzhang-missed.ts
 */

import https from 'https';

import { getBrainDb } from '../src/brain/db.js';
import { reprocessRawEvent } from '../src/brain/ingest.js';
import { newId } from '../src/brain/ulid.js';
import { NANOCLAW_SERVICE_TOKEN, SUPERPILOT_API_URL } from '../src/config.js';

interface ParsedEmail {
  thread_id: string;
  account?: string;
  subject?: string;
  sender?: string;
  snippet?: string;
}

const ACCOUNT = 'jonathan.zhang@whoisxmlapi.com';
const SINCE = '2026-04-01T00:00:00Z';

interface SpEmail {
  thread_id: string;
  account: string;
  subject: string;
  sender: string;
  sender_email: string;
  received_at: string;
  email_type: string | null;
  needs_reply: boolean;
  suggested_action: string | null;
  snippet: string | null;
}

function fetchSp(token: string): Promise<SpEmail[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPERPILOT_API_URL}/nanoclaw/triaged-emails`);
    url.searchParams.set('since', SINCE);
    url.searchParams.set('account', ACCOUNT);
    const req = https.get(
      url,
      {
        headers: {
          'x-service-token': token,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body) as { emails: SpEmail[] };
            resolve(parsed.emails ?? []);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const token = NANOCLAW_SERVICE_TOKEN.split(',')[0]?.split('@')[0];
  if (!token) {
    console.error('error: NANOCLAW_SERVICE_TOKEN is empty');
    process.exit(2);
  }

  console.log(`Fetching triaged emails for ${ACCOUNT} since ${SINCE}...`);
  const emails = await fetchSp(token);
  console.log(`SP returned ${emails.length} classifications`);

  if (emails.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  const db = getBrainDb();

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO raw_events
       (id, source_type, source_ref, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let alreadyPresent = 0;
  let extracted = 0;
  let extractFailed = 0;

  for (const e of emails) {
    if (!e.thread_id) {
      console.warn(`  skip: missing thread_id (subject="${e.subject}")`);
      continue;
    }

    const parsed: ParsedEmail = {
      thread_id: e.thread_id,
      account: e.account,
      subject: e.subject,
      sender: e.sender_email || e.sender,
      snippet: e.snippet ?? '',
    };

    if (dryRun) {
      console.log(
        `  would ingest ${e.thread_id}  ${e.received_at.slice(0, 19)}  "${e.subject.slice(0, 50)}"`,
      );
      continue;
    }

    const id = newId();
    const payloadJson = JSON.stringify(parsed);
    const result = insertStmt.run(
      id,
      'email',
      e.thread_id,
      Buffer.from(payloadJson, 'utf8'),
      e.received_at,
    );

    if (result.changes === 0) {
      alreadyPresent++;
      continue;
    }
    inserted++;

    try {
      const r = await reprocessRawEvent('email', e.thread_id);
      if (r.reprocessed) {
        extracted++;
        console.log(
          `  ✓ ${e.thread_id}  ${e.received_at.slice(0, 19)}  "${e.subject.slice(0, 50)}"`,
        );
      } else {
        extractFailed++;
        console.error(
          `  ✗ ${e.thread_id}  reprocessRawEvent returned reprocessed=false`,
        );
      }
    } catch (err) {
      extractFailed++;
      console.error(
        `  ✗ ${e.thread_id}  extraction failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log('');
  console.log(`SP rows seen:        ${emails.length}`);
  console.log(`new raw_events:      ${inserted}`);
  console.log(`already in brain:    ${alreadyPresent}`);
  console.log(`extracted (KU+emb):  ${extracted}`);
  console.log(`extraction failed:   ${extractFailed}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
