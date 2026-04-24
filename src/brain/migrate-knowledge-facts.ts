/**
 * Migration: legacy `knowledge_facts` (FTS5 in store/messages.db) →
 * new `knowledge_units` (in store/brain.db). See design §4 Phase B.
 *
 * Legacy schema (inspected 2026-04-23):
 *   CREATE VIRTUAL TABLE knowledge_facts USING fts5(
 *     text, domain, group_id, source, created_at
 *   )
 *
 * Mapping:
 *   legacy.rowid        → metadata.legacy_knowledge_fact_rowid
 *   legacy.text         → ku.text
 *   legacy.source       → ku.source_type  (strings like 'manual', 'email')
 *   legacy.group_id     → ku.source_ref
 *   legacy.domain       → tags[0]         (single-tag JSON array)
 *   legacy.created_at   → ku.valid_from AND ku.recorded_at
 *
 *   ku.account = 'work' (we triage personal/work later via sender heuristics;
 *   see design §4 Phase B.3).
 *   ku.confidence = 1.0 (legacy had no confidence — assume user-accepted).
 *   ku.extracted_by = 'legacy-migration'.
 *
 * Idempotency: we skip any legacy row whose rowid already appears as
 * `metadata.legacy_knowledge_fact_rowid` in knowledge_units. Safe to re-run.
 *
 * Dry-run: when `dryRun=true` we open the databases read-only, count matches,
 * and return the plan without inserting.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { embedText, getEmbeddingModelVersion } from './embed.js';
import { upsertKu } from './qdrant.js';
import { newId } from './ulid.js';

export interface MigrationReport {
  dryRun: boolean;
  legacyPath: string;
  legacyRowsTotal: number;
  legacyRowsSkippedEmpty: number;
  alreadyMigrated: number;
  inserted: number;
  qdrantWritten: number;
  qdrantFailed: number;
  /** raw_events rollup counts for legacy tables not covered by knowledge_facts. */
  trackedItemsLinked: number;
  commitmentsLinked: number;
  actedEmailsLinked: number;
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

export interface MigrateOptions {
  dryRun?: boolean;
  /** Override path to legacy messages.db — tests pass a temp path. */
  legacyDbPath?: string;
  /** Override brain.db handle — tests pass an in-memory one. */
  brainDb?: Database.Database;
}

interface LegacyRow {
  rowid: number;
  text: string | null;
  domain: string | null;
  group_id: string | null;
  source: string | null;
  created_at: string | null;
}

/**
 * Run (or preview) the legacy → knowledge_units migration.
 *
 * - Opens `store/messages.db` read-only (never mutates legacy).
 * - Inserts into `knowledge_units` via a single transaction per batch of 500
 *   for throughput.
 * - Dry-run: counts and returns but does not insert.
 */
export async function migrateKnowledgeFacts(
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? false;
  const legacyPath = opts.legacyDbPath ?? path.join(STORE_DIR, 'messages.db');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  const report: MigrationReport = {
    dryRun,
    legacyPath,
    legacyRowsTotal: 0,
    legacyRowsSkippedEmpty: 0,
    alreadyMigrated: 0,
    inserted: 0,
    qdrantWritten: 0,
    qdrantFailed: 0,
    trackedItemsLinked: 0,
    commitmentsLinked: 0,
    actedEmailsLinked: 0,
    startedAt,
    finishedAt: startedAt,
    errors,
  };

  if (!fs.existsSync(legacyPath)) {
    // Missing legacy DB is an acceptable no-op — fresh installs have no
    // messages.db. Return a zero report instead of throwing.
    logger.info(
      { legacyPath },
      'migrateKnowledgeFacts: legacy DB missing — nothing to migrate',
    );
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const legacy = new Database(legacyPath, { readonly: true });
  try {
    // Legacy schema check — bail cleanly if the table is missing.
    const tableExists = legacy
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_facts'`,
      )
      .get() as { name: string } | undefined;
    if (!tableExists) {
      logger.info(
        { legacyPath },
        'migrateKnowledgeFacts: no knowledge_facts table — nothing to migrate',
      );
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const rows = legacy
      .prepare(
        `SELECT rowid, text, domain, group_id, source, created_at
           FROM knowledge_facts
          ORDER BY rowid ASC`,
      )
      .all() as LegacyRow[];
    report.legacyRowsTotal = rows.length;

    const brain = opts.brainDb ?? getBrainDb();

    // Build the set of already-migrated legacy rowids so reruns skip them.
    // Uses a JSON match on the metadata column — acceptable at P2 scale (≤ 10K
    // rows typical) without a dedicated index.
    const existingIds = new Set<number>(
      (
        brain
          .prepare(
            `SELECT json_extract(metadata, '$.legacy_knowledge_fact_rowid') as rid
               FROM knowledge_units
              WHERE extracted_by = 'legacy-migration'`,
          )
          .all() as { rid: number | null }[]
      )
        .map((r) => r.rid)
        .filter((r): r is number => typeof r === 'number'),
    );

    const insertStmt = brain.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, source_ref, account, scope, confidence,
          valid_from, recorded_at, topic_key, tags, extracted_by,
          extraction_chain, metadata, needs_review)
       VALUES (?, ?, ?, ?, 'work', NULL, 1.0,
               ?, ?, NULL, ?, 'legacy-migration',
               NULL, ?, 0)`,
    );

    const pending: Array<
      [string, string, string, string, string, string, string | null, string]
    > = [];
    for (const r of rows) {
      if (existingIds.has(r.rowid)) {
        report.alreadyMigrated++;
        continue;
      }
      const text = (r.text ?? '').trim();
      if (!text) {
        report.legacyRowsSkippedEmpty++;
        continue;
      }
      const sourceType = (r.source ?? 'legacy').trim() || 'legacy';
      const sourceRef = (r.group_id ?? '').trim() || null;
      const createdAt = (r.created_at ?? '').trim() || startedAt;
      const domain = (r.domain ?? '').trim();
      const tagsJson = domain ? JSON.stringify([domain]) : null;
      const metaJson = JSON.stringify({
        legacy_knowledge_fact_rowid: r.rowid,
        legacy_domain: domain || null,
      });
      pending.push([
        newId(),
        text,
        sourceType,
        sourceRef ?? '',
        createdAt,
        createdAt,
        tagsJson,
        metaJson,
      ]);
    }

    if (dryRun) {
      report.inserted = pending.length;
      // Don't actually insert. Leave alreadyMigrated + legacyRowsSkippedEmpty
      // untouched so the caller sees the full plan.
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const BATCH = 500;
    const doInsert = brain.transaction((items: typeof pending) => {
      for (const row of items) {
        insertStmt.run(
          row[0],
          row[1],
          row[2],
          row[3] === '' ? null : row[3],
          row[4],
          row[5],
          row[6],
          row[7],
        );
      }
    });

    // Track the KU rows that made it to SQLite so we can embed + upsert
    // them to Qdrant below. Each entry = [kuId, text, sourceType, createdAt].
    const insertedKus: Array<{
      kuId: string;
      text: string;
      sourceType: string;
      validFrom: string;
      recordedAt: string;
    }> = [];

    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      try {
        doInsert(slice);
        report.inserted += slice.length;
        for (const row of slice) {
          insertedKus.push({
            kuId: row[0],
            text: row[1],
            sourceType: row[2],
            validFrom: row[4],
            recordedAt: row[5],
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`batch ${i}/${pending.length}: ${msg}`);
        logger.error(
          { err: msg, batchStart: i, batchSize: slice.length },
          'migrateKnowledgeFacts: batch failed — continuing',
        );
      }
    }

    // Phase B of the migration (design §4): re-embed each inserted KU and
    // push the vector to Qdrant so recall's semantic leg can find migrated
    // rows. A Qdrant failure follows the same contract as ingest.ts:217-242
    // — warn, keep the SQLite row, bump qdrantFailed.
    //
    // Bounded concurrency: we run at most CONCURRENCY embeds in flight so
    // we don't starve CPU on the local Nomic model. Inline gate rather than
    // a new dep.
    const CONCURRENCY = 4;
    const PROGRESS_EVERY = 100;
    const total = insertedKus.length;
    let cursor = 0;
    let done = 0;
    const modelVersion = getEmbeddingModelVersion();

    async function worker(): Promise<void> {
      for (;;) {
        const idx = cursor;
        cursor++;
        if (idx >= insertedKus.length) return;
        const ku = insertedKus[idx];
        try {
          const vec = await embedText(ku.text, 'document');
          await upsertKu({
            kuId: ku.kuId,
            vector: vec,
            payload: {
              account: 'work',
              scope: null,
              model_version: modelVersion,
              valid_from: ku.validFrom,
              recorded_at: ku.recordedAt,
              source_type: ku.sourceType,
            },
          });
          report.qdrantWritten++;
        } catch (err) {
          report.qdrantFailed++;
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              kuId: ku.kuId,
            },
            'Qdrant upsert failed during migration',
          );
        }
        done++;
        if (done % PROGRESS_EVERY === 0 || done === total) {
          logger.info(
            {
              done,
              total,
              embedded: done,
              qdrantWritten: report.qdrantWritten,
              qdrantFailed: report.qdrantFailed,
            },
            'migration progress',
          );
        }
      }
    }

    if (total > 0) {
      const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () =>
        worker(),
      );
      await Promise.all(workers);
    }

    // Second pass — preserve other legacy tables as raw_events so the
    // append-only capture log has parity with pre-migration history. Each
    // legacy row becomes one raw_events row keyed by (source_type, source_ref)
    // so a rerun is idempotent.
    //
    // Skipped when dryRun — caller only wants counts; we'd need real
    // transactions to produce them, and legacy tables are small.
    if (!dryRun) {
      const legacyTables: Array<{
        table: 'tracked_items' | 'commitments' | 'acted_emails';
        srcType: 'tracked_item' | 'commitment' | 'acted_email';
        reportField:
          | 'trackedItemsLinked'
          | 'commitmentsLinked'
          | 'actedEmailsLinked';
      }> = [
        {
          table: 'tracked_items',
          srcType: 'tracked_item',
          reportField: 'trackedItemsLinked',
        },
        {
          table: 'commitments',
          srcType: 'commitment',
          reportField: 'commitmentsLinked',
        },
        {
          table: 'acted_emails',
          srcType: 'acted_email',
          reportField: 'actedEmailsLinked',
        },
      ];
      const nowIso = new Date().toISOString();
      const insertRaw = brain.prepare(
        `INSERT OR IGNORE INTO raw_events
           (id, source_type, source_ref, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const { table, srcType, reportField } of legacyTables) {
        // Some installs may not have every table — probe first.
        let exists = false;
        try {
          legacy.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
          exists = true;
        } catch {
          logger.info(
            { table },
            'migrateKnowledgeFacts: legacy table missing — skipped',
          );
          continue;
        }
        if (!exists) continue;

        const rows = legacy.prepare(`SELECT * FROM ${table}`).all() as Array<
          Record<string, unknown>
        >;

        const txn = brain.transaction(
          (batch: Array<Record<string, unknown>>) => {
            for (const row of batch) {
              const sourceRef = String(
                (row as { id?: unknown; uuid?: unknown; thread_id?: unknown })
                  .id ??
                  (row as { uuid?: unknown }).uuid ??
                  (row as { thread_id?: unknown }).thread_id ??
                  '',
              );
              if (!sourceRef) continue;
              const payload = Buffer.from(JSON.stringify(row), 'utf8');
              const result = insertRaw.run(
                newId(),
                srcType,
                sourceRef,
                payload,
                nowIso,
              );
              if (result.changes > 0) report[reportField]++;
            }
          },
        );
        txn(rows);
        logger.info(
          { table, srcType, rows: rows.length, linked: report[reportField] },
          'migrateKnowledgeFacts: legacy table rolled into raw_events',
        );
      }
    }
  } finally {
    legacy.close();
  }

  report.finishedAt = new Date().toISOString();
  logger.info(
    {
      legacyRowsTotal: report.legacyRowsTotal,
      inserted: report.inserted,
      alreadyMigrated: report.alreadyMigrated,
      skippedEmpty: report.legacyRowsSkippedEmpty,
      qdrantWritten: report.qdrantWritten,
      qdrantFailed: report.qdrantFailed,
      errors: report.errors.length,
      dryRun: report.dryRun,
    },
    'migrateKnowledgeFacts completed',
  );
  return report;
}
