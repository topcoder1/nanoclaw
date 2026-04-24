/**
 * Deterministic entity resolution for the augmented brain (v2 §7).
 *
 * Scope: exact matches on email / domain / alias field_value only. Splink
 * and fuzzy dedup are deferred (v2 §2 table). Idempotent — re-resolving
 * the same input returns the same entity_id without creating duplicates.
 *
 * All writes go through `getWriteQueue()` → AsyncWriteQueue so we never
 * contend on the WAL from multiple ingest workers.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { AsyncWriteQueue } from './queue.js';
import { newId } from './ulid.js';

export type EntityType = 'person' | 'company' | 'project' | 'product' | 'topic';

export interface Entity {
  entity_id: string;
  entity_type: EntityType;
  canonical: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface WriteOp {
  run: (db: Database.Database) => void;
}

// Single-process write serializer for entity resolution. Shared within this
// module so overlapping `resolveByEmail` calls don't race on the insert.
let writeQueue: AsyncWriteQueue<WriteOp> | null = null;

function getWriteQueue(): AsyncWriteQueue<WriteOp> {
  if (writeQueue) return writeQueue;
  const db = getBrainDb();
  writeQueue = new AsyncWriteQueue<WriteOp>(
    async (batch) => {
      const txn = db.transaction((ops: WriteOp[]) => {
        for (const op of ops) op.run(db);
      });
      txn(batch);
    },
    { maxBatchSize: 50, maxLatencyMs: 50 },
  );
  return writeQueue;
}

/** @internal — tests only. */
export async function _shutdownEntityQueue(): Promise<void> {
  if (writeQueue) {
    await writeQueue.shutdown();
    writeQueue = null;
  }
}

/** Normalize an email for alias lookup. Lowercase + trim. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalize a domain. Lowercase + strip leading dots and `www.`. */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/^www\./, '');
}

function readEntity(
  db: Database.Database,
  entityId: string,
): Entity | undefined {
  const row = db
    .prepare(
      `SELECT entity_id, entity_type, canonical, created_at, updated_at
       FROM entities WHERE entity_id = ?`,
    )
    .get(entityId) as
    | {
        entity_id: string;
        entity_type: EntityType;
        canonical: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    entity_id: row.entity_id,
    entity_type: row.entity_type,
    canonical: row.canonical ? JSON.parse(row.canonical) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function findEntityIdByAlias(
  db: Database.Database,
  fieldName: string,
  fieldValue: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT entity_id FROM entity_aliases
       WHERE field_name = ? AND field_value = ?
       ORDER BY valid_from ASC LIMIT 1`,
    )
    .get(fieldName, fieldValue) as { entity_id: string } | undefined;
  return row?.entity_id;
}

/**
 * Resolve a person by email. Returns the existing entity if the email alias
 * exists; otherwise null (caller decides whether to create).
 */
export function resolveByEmail(email: string): Entity | null {
  const normalized = normalizeEmail(email);
  const db = getBrainDb();
  const existingId = findEntityIdByAlias(db, 'email', normalized);
  if (!existingId) return null;
  return readEntity(db, existingId) ?? null;
}

/**
 * Resolve a company by domain. Same contract as resolveByEmail.
 */
export function resolveByDomain(domain: string): Entity | null {
  const normalized = normalizeDomain(domain);
  const db = getBrainDb();
  const existingId = findEntityIdByAlias(db, 'domain', normalized);
  if (!existingId) return null;
  return readEntity(db, existingId) ?? null;
}

/**
 * Idempotent: if a person with this email already exists, returns them.
 * Otherwise creates a new person entity + email alias inside a single
 * transaction via the write queue. Optional `name` populates the canonical
 * JSON blob.
 */
export async function createPersonFromEmail(
  email: string,
  name?: string,
): Promise<Entity> {
  const existing = resolveByEmail(email);
  if (existing) return existing;

  const normalized = normalizeEmail(email);
  const entityId = newId();
  const aliasId = newId();
  const now = new Date().toISOString();
  const canonical = name ? JSON.stringify({ name, email: normalized }) : null;

  await getWriteQueue().enqueue({
    run: (db) => {
      // Re-check inside the transaction — another concurrent ingest may
      // have just created the same email. Second writer becomes a no-op.
      const existingId = findEntityIdByAlias(db, 'email', normalized);
      if (existingId) return;
      db.prepare(
        `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
         VALUES (?, 'person', ?, ?, ?)`,
      ).run(entityId, canonical, now, now);
      db.prepare(
        `INSERT INTO entity_aliases
           (alias_id, entity_id, source_type, source_ref, field_name,
            field_value, valid_from, valid_until, confidence)
         VALUES (?, ?, 'email', NULL, 'email', ?, ?, NULL, 1.0)`,
      ).run(aliasId, entityId, normalized, now);
    },
  });

  // Read back — if a racing writer won, we get their id; otherwise ours.
  const final = resolveByEmail(normalized);
  if (!final) {
    throw new Error(`createPersonFromEmail: failed to persist ${normalized}`);
  }
  return final;
}

/**
 * Idempotent: if a company with this domain already exists, returns it.
 * Otherwise creates a new company entity + domain alias.
 */
export async function createCompanyFromDomain(domain: string): Promise<Entity> {
  const existing = resolveByDomain(domain);
  if (existing) return existing;

  const normalized = normalizeDomain(domain);
  const entityId = newId();
  const aliasId = newId();
  const now = new Date().toISOString();
  const canonical = JSON.stringify({ domain: normalized });

  await getWriteQueue().enqueue({
    run: (db) => {
      const existingId = findEntityIdByAlias(db, 'domain', normalized);
      if (existingId) return;
      db.prepare(
        `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
         VALUES (?, 'company', ?, ?, ?)`,
      ).run(entityId, canonical, now, now);
      db.prepare(
        `INSERT INTO entity_aliases
           (alias_id, entity_id, source_type, source_ref, field_name,
            field_value, valid_from, valid_until, confidence)
         VALUES (?, ?, 'domain', NULL, 'domain', ?, ?, NULL, 1.0)`,
      ).run(aliasId, entityId, normalized, now);
    },
  });

  const final = resolveByDomain(normalized);
  if (!final) {
    throw new Error(`createCompanyFromDomain: failed to persist ${normalized}`);
  }
  return final;
}

/**
 * Attach an alias (additional identifier) to an existing entity. Idempotent:
 * if an alias with (field_name, field_value) already points to this entity
 * the call is a no-op. If it points somewhere else the call logs a warning
 * and still creates a new row — merging is a Splink-era problem (v2 §2).
 */
export async function attachAlias(input: {
  entityId: string;
  fieldName: string;
  fieldValue: string;
  sourceType?: string;
  sourceRef?: string;
  confidence?: number;
}): Promise<void> {
  const {
    entityId,
    fieldName,
    fieldValue,
    sourceType = 'manual',
    sourceRef = null,
    confidence = 1.0,
  } = input;

  const db = getBrainDb();
  const existing = db
    .prepare(
      `SELECT entity_id FROM entity_aliases
       WHERE field_name = ? AND field_value = ?`,
    )
    .get(fieldName, fieldValue) as { entity_id: string } | undefined;
  if (existing?.entity_id === entityId) return;
  if (existing && existing.entity_id !== entityId) {
    logger.warn(
      {
        fieldName,
        fieldValue,
        existing: existing.entity_id,
        incoming: entityId,
      },
      'attachAlias: field_value already points to a different entity',
    );
  }

  const aliasId = newId();
  const now = new Date().toISOString();
  await getWriteQueue().enqueue({
    run: (database) => {
      database
        .prepare(
          `INSERT INTO entity_aliases
             (alias_id, entity_id, source_type, source_ref, field_name,
              field_value, valid_from, valid_until, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          aliasId,
          entityId,
          sourceType,
          sourceRef,
          fieldName,
          fieldValue,
          now,
          confidence,
        );
    },
  });
}
