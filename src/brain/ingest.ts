/**
 * Brain ingestion pipeline (v2 §8).
 *
 * P0 behavior (preserved): capture every inbound email into `raw_events`
 * idempotently via UNIQUE(source_type, source_ref).
 *
 * P1 upgrade: after raw_events insert, drive the full extraction pipeline:
 *   1. cheap-rules extraction
 *   2. LLM extraction (budget-gated)
 *   3. deterministic entity resolution for every claim mention
 *   4. insert knowledge_unit + ku_entities (single transaction)
 *   5. embed text and upsert to Qdrant (separate step — SQLite row stands
 *      even if Qdrant fails; a warn is logged)
 *   6. set raw_events.processed_at = now
 *   7. on failure in any step: set process_error, increment retry_count
 */

import type Database from 'better-sqlite3';

import { eventBus } from '../event-bus.js';
import type { EmailReceivedEvent } from '../events.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { ensureLegacyCutoverTombstone } from './drop-legacy-tombstone.js';
import { embedText } from './embed.js';
import { kuPointId, BRAIN_COLLECTION } from './qdrant.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_URL } from '../config.js';
import {
  _shutdownEntityQueue,
  createCompanyFromDomain,
  createPersonFromEmail,
  type Entity,
} from './entities.js';
import { extractPipeline, type Claim } from './extract.js';
import {
  EMAILS_SEEN_KEY,
  LAST_INGEST_EVENT_KEY,
  incrementSystemCounter,
  setSystemState,
} from './metrics.js';
import { upsertKu } from './qdrant.js';
import { AsyncWriteQueue } from './queue.js';
import { _shutdownAccessQueue } from './retrieve.js';
import { shouldSkipBrainExtraction } from './transactional-filter.js';
import { newId } from './ulid.js';

import { getDb as getNanoclawDb } from '../db.js';

/**
 * Map the Gmail-alias `email.account` (e.g. "personal", "whoisxml",
 * "attaxion", "dev") onto the brain schema's two-bucket taxonomy
 * ('personal' | 'work'). Only the literal `'personal'` lands in the
 * personal bucket; every other value (including undefined) is treated
 * as work. This mirrors the heuristic described in
 * `migrate-knowledge-facts.ts` (sender/account-based triage).
 */
function toAccountBucket(raw?: string): 'personal' | 'work' {
  return raw === 'personal' ? 'personal' : 'work';
}

// --- Raw event capture (P0, preserved) ------------------------------------

interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  payload: Buffer;
  received_at: string;
  /** Parsed payload passed along so the P1 pipeline can consume it. */
  parsedEmail: ParsedEmail | null;
}

interface ParsedEmail {
  thread_id: string;
  account?: string;
  subject?: string;
  sender?: string;
  snippet?: string;
}

let unsubscribe: (() => void) | null = null;
let queue: AsyncWriteQueue<RawEventRow> | null = null;

async function processRawEvent(
  db: Database.Database,
  row: RawEventRow,
): Promise<void> {
  if (!row.parsedEmail) {
    markProcessed(db, row.source_type, row.source_ref);
    return;
  }
  try {
    await runExtractionPipeline(db, row);
    markProcessed(db, row.source_type, row.source_ref);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { threadId: row.parsedEmail.thread_id, err: msg },
      'brain ingest: extraction pipeline failed — raw_event flagged for retry',
    );
    db.prepare(
      `UPDATE raw_events
         SET process_error = ?, retry_count = retry_count + 1
       WHERE source_type = ? AND source_ref = ?`,
    ).run(msg, row.source_type, row.source_ref);
  }
}

function markProcessed(
  db: Database.Database,
  sourceType: string,
  sourceRef: string,
): void {
  db.prepare(
    `UPDATE raw_events SET processed_at = ?
     WHERE source_type = ? AND source_ref = ? AND processed_at IS NULL`,
  ).run(new Date().toISOString(), sourceType, sourceRef);
}

function flushRawEvents(
  db: Database.Database,
  batch: RawEventRow[],
): {
  inserted: string[];
} {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO raw_events
       (id, source_type, source_ref, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction((rows: RawEventRow[]) => {
    const inserted: string[] = [];
    for (const row of rows) {
      const result = stmt.run(
        row.id,
        row.source_type,
        row.source_ref,
        row.payload,
        row.received_at,
      );
      if (result.changes > 0) inserted.push(row.source_ref);
    }
    return inserted;
  });
  const inserted = txn(batch);
  return { inserted };
}

// --- P1: extraction pipeline ----------------------------------------------

async function runExtractionPipeline(
  db: Database.Database,
  row: RawEventRow,
): Promise<void> {
  const email = row.parsedEmail!;
  const text = [email.subject, email.snippet ?? '', email.sender ?? '']
    .filter(Boolean)
    .join('\n');
  if (!text.trim()) {
    logger.debug(
      { threadId: email.thread_id },
      'brain ingest: empty text — skipping',
    );
    return;
  }

  // Skip transactional / already-classified-as-digest emails before paying
  // for the LLM tier. `getNanoclawDb` is only available once the main
  // process has initialised it; if not, fall back to heuristic-only.
  let nanoclawDb: Database.Database | null = null;
  try {
    nanoclawDb = getNanoclawDb();
  } catch {
    nanoclawDb = null;
  }
  const skipReason = shouldSkipBrainExtraction(nanoclawDb, {
    thread_id: email.thread_id,
    sender: email.sender,
    subject: email.subject,
  });
  if (skipReason) {
    logger.debug(
      { threadId: email.thread_id, reason: skipReason, sender: email.sender },
      'brain ingest: transactional/digest — skipping extraction',
    );
    return;
  }

  // Step 1–2: cheap + LLM extraction.
  const claims = await extractPipeline({
    text,
    subject: email.subject,
    sender: email.sender,
  });
  if (claims.length === 0) return;

  // Step 3: deterministic entity resolution for sender + any email/domain
  // mentions on each claim.
  const entitiesPerClaim: Entity[][] = [];
  for (const claim of claims) {
    const set = new Map<string, Entity>();
    // Sender → person.
    if (email.sender && /@/.test(email.sender)) {
      const person = await createPersonFromEmail(email.sender);
      set.set(person.entity_id, person);
      const domain = email.sender.split('@')[1];
      if (domain) {
        const company = await createCompanyFromDomain(domain);
        set.set(company.entity_id, company);
      }
    }
    for (const m of claim.entities_mentioned) {
      if (m.kind === 'email') {
        const p = await createPersonFromEmail(m.value);
        set.set(p.entity_id, p);
      } else if (m.kind === 'domain') {
        const c = await createCompanyFromDomain(m.value);
        set.set(c.entity_id, c);
      }
    }
    entitiesPerClaim.push([...set.values()]);
  }

  // Step 4: insert KU + ku_entities rows in a single transaction.
  const nowIso = new Date().toISOString();
  const kuRows: Array<{ id: string; claim: Claim; entities: Entity[] }> =
    claims.map((c, i) => ({
      id: newId(),
      claim: c,
      entities: entitiesPerClaim[i],
    }));

  const accountBucket = toAccountBucket(email.account);
  const insertKu = db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, confidence,
        valid_from, recorded_at, topic_key, tags, extracted_by,
        extraction_chain, metadata, needs_review)
     VALUES (?, ?, 'email', ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
  );

  const txn = db.transaction(() => {
    for (const ku of kuRows) {
      insertKu.run(
        ku.id,
        ku.claim.text,
        email.thread_id,
        accountBucket,
        ku.claim.confidence,
        nowIso, // valid_from = now for emails
        nowIso,
        ku.claim.topic_key,
        ku.claim.extracted_by,
        ku.claim.needs_review ? 1 : 0,
      );
      for (const ent of ku.entities) {
        insertLink.run(ku.id, ent.entity_id, 'mentioned');
      }
    }
  });
  txn();

  // Step 5: embed and upsert each KU. Best-effort — a Qdrant failure does
  // NOT roll back the SQLite write.
  for (const ku of kuRows) {
    try {
      const vec = await embedText(ku.claim.text, 'document');
      await upsertKu({
        kuId: ku.id,
        vector: vec,
        payload: {
          account: accountBucket,
          scope: null,
          model_version: 'nomic-embed-text-v1.5:768',
          valid_from: nowIso,
          recorded_at: nowIso,
          source_type: 'email',
          topic_key: ku.claim.topic_key ?? null,
        },
      });
    } catch (err) {
      logger.warn(
        {
          kuId: ku.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'brain ingest: embed/upsert failed — SQLite row retained',
      );
    }
  }
}

// --- Startup / shutdown ---------------------------------------------------

/**
 * Start the brain ingest listener. Safe to call multiple times — second
 * call is a no-op if already started.
 */
export function startBrainIngest(): void {
  if (unsubscribe) return;
  const db = getBrainDb();
  // One-time: stamp the legacy-cutover tombstone so the 30-day drop reminder
  // has a start date. Idempotent — subsequent calls reuse the existing row.
  ensureLegacyCutoverTombstone();

  queue = new AsyncWriteQueue<RawEventRow>(async (batch) => {
    const { inserted } = flushRawEvents(db, batch);
    const insertedSet = new Set(inserted);
    // Drive the P1 pipeline only for rows that were actually inserted —
    // duplicates are a no-op.
    for (const row of batch) {
      if (!insertedSet.has(row.source_ref)) continue;
      await processRawEvent(db, row);
    }
  });

  unsubscribe = eventBus.on('email.received', (event: EmailReceivedEvent) => {
    const q = queue;
    if (!q) return;
    const receivedAt = new Date(event.timestamp).toISOString();
    for (const email of event.payload.emails) {
      const threadId = email.thread_id;
      if (!threadId) {
        logger.warn(
          { subject: email.subject },
          'email.received entry missing thread_id — skipping brain capture',
        );
        continue;
      }
      // Canary counter: bumped per email.received that reaches brain
      // ingest, independent of the raw_events insert (which is deduped
      // by UNIQUE(source_type, source_ref)). A zero value over 24h with
      // fresh timestamps elsewhere = SSE wedged or event bus broken.
      try {
        incrementSystemCounter(EMAILS_SEEN_KEY, receivedAt);
        setSystemState(LAST_INGEST_EVENT_KEY, receivedAt, receivedAt);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'brain ingest: canary counter update failed',
        );
      }
      const payloadJson = JSON.stringify(email);
      const row: RawEventRow = {
        id: newId(),
        source_type: 'email',
        source_ref: threadId,
        payload: Buffer.from(payloadJson, 'utf8'),
        received_at: receivedAt,
        parsedEmail: email as ParsedEmail,
      };
      q.enqueue(row).catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), threadId },
          'raw_events enqueue failed — dead-lettered',
        );
      });
    }
  });

  logger.info('Brain ingest started (raw_events + P1 extraction pipeline)');
}

/**
 * Re-run the P1 extraction pipeline for a previously-ingested raw_event,
 * discarding any KUs (and their Qdrant vectors) that the prior run produced.
 *
 * Intended for one-off backfills when the extractor has changed (e.g. the
 * LLM call was misconfigured on a prior pass) — NOT for normal operation.
 * Idempotent: if the raw_event row does not exist, resolves to `{ reprocessed: false }`.
 */
export async function reprocessRawEvent(
  sourceType: string,
  sourceRef: string,
): Promise<{ reprocessed: boolean; deletedKus: number }> {
  const db = getBrainDb();
  const row = db
    .prepare(
      `SELECT payload FROM raw_events WHERE source_type = ? AND source_ref = ?`,
    )
    .get(sourceType, sourceRef) as { payload: Buffer } | undefined;
  if (!row) return { reprocessed: false, deletedKus: 0 };

  // Find existing KUs so we can purge their Qdrant points before the DB rows
  // disappear (Qdrant cleanup is best-effort — a failure logs but does not
  // abort the SQLite cleanup).
  const oldKuIds = (
    db
      .prepare(
        `SELECT id FROM knowledge_units WHERE source_type = ? AND source_ref = ?`,
      )
      .all(sourceType, sourceRef) as Array<{ id: string }>
  ).map((r) => r.id);

  if (oldKuIds.length > 0 && QDRANT_URL) {
    try {
      const client = new QdrantClient({ url: QDRANT_URL });
      await client.delete(BRAIN_COLLECTION, {
        wait: true,
        points: oldKuIds.map(kuPointId),
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sourceRef },
        'reprocessRawEvent: Qdrant delete failed — orphan points may remain',
      );
    }
  }

  db.transaction(() => {
    db.prepare(
      `DELETE FROM ku_entities WHERE ku_id IN (
         SELECT id FROM knowledge_units WHERE source_type = ? AND source_ref = ?
       )`,
    ).run(sourceType, sourceRef);
    db.prepare(
      `DELETE FROM knowledge_units WHERE source_type = ? AND source_ref = ?`,
    ).run(sourceType, sourceRef);
    db.prepare(
      `UPDATE raw_events SET processed_at = NULL, process_error = NULL, retry_count = 0
       WHERE source_type = ? AND source_ref = ?`,
    ).run(sourceType, sourceRef);
  })();

  const parsedEmail = JSON.parse(row.payload.toString('utf8')) as ParsedEmail;
  const fakeRow: RawEventRow = {
    id: '',
    source_type: sourceType,
    source_ref: sourceRef,
    payload: row.payload,
    received_at: '',
    parsedEmail,
  };
  await processRawEvent(db, fakeRow);
  return { reprocessed: true, deletedKus: oldKuIds.length };
}

/**
 * Drain the in-flight queue and unsubscribe.
 */
export async function stopBrainIngest(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (queue) {
    await queue.shutdown();
    queue = null;
  }
  // Entities has its own write-serializer; drain it here so unit tests
  // don't hang on its flushTimer.
  await _shutdownEntityQueue();
  // retrieve.ts lazily creates an access-bump queue on the first recall();
  // drain it too so SIGTERM → process.exit doesn't drop in-flight
  // UPDATEs of access_count / last_accessed_at.
  await _shutdownAccessQueue();
}
