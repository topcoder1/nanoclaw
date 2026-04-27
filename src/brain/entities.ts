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

/** Normalize a repo slug. Lowercase + trim. Slug format mirrors the
 *  `claw sync` source_ref prefix (e.g. `nanoclaw`, `inbox_superpilot`). */
function normalizeRepoSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * Extract the repo slug from a `source_type='repo'` source_ref. claw sync
 * writes refs as `<slug>:<path>[#L<a>-L<b>]`, so the slug is everything
 * before the first colon. Returns null for malformed inputs.
 */
export function parseRepoSlugFromSourceRef(
  sourceRef: string | null | undefined,
): string | null {
  if (!sourceRef) return null;
  const idx = sourceRef.indexOf(':');
  if (idx <= 0) return null;
  const slug = sourceRef.slice(0, idx).trim();
  return slug || null;
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

export function findEntityIdByAlias(
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
 * Resolve a project by repo slug. Same contract as resolveByEmail.
 */
export function resolveByRepoSlug(slug: string): Entity | null {
  const normalized = normalizeRepoSlug(slug);
  const db = getBrainDb();
  const existingId = findEntityIdByAlias(db, 'repo_slug', normalized);
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
 * Idempotent: if a project with this repo slug already exists, returns it.
 * Otherwise creates a new project entity + repo_slug alias. Stores the slug
 * as `canonical.name` so the entities directory renderer (which falls back
 * to `name → domain → email`) shows the slug as the entity's display name.
 */
export async function createProjectFromRepoSlug(slug: string): Promise<Entity> {
  const existing = resolveByRepoSlug(slug);
  if (existing) return existing;

  const normalized = normalizeRepoSlug(slug);
  if (!normalized) {
    throw new Error('createProjectFromRepoSlug: empty slug');
  }
  const entityId = newId();
  const aliasId = newId();
  const now = new Date().toISOString();
  const canonical = JSON.stringify({ name: normalized, repo_slug: normalized });

  await getWriteQueue().enqueue({
    run: (db) => {
      const existingId = findEntityIdByAlias(db, 'repo_slug', normalized);
      if (existingId) return;
      db.prepare(
        `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
         VALUES (?, 'project', ?, ?, ?)`,
      ).run(entityId, canonical, now, now);
      db.prepare(
        `INSERT INTO entity_aliases
           (alias_id, entity_id, source_type, source_ref, field_name,
            field_value, valid_from, valid_until, confidence)
         VALUES (?, ?, 'repo', NULL, 'repo_slug', ?, ?, NULL, 1.0)`,
      ).run(aliasId, entityId, normalized, now);
    },
  });

  const final = resolveByRepoSlug(normalized);
  if (!final) {
    throw new Error(
      `createProjectFromRepoSlug: failed to persist ${normalized}`,
    );
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

// ---------------------------------------------------------------------------
// Discord / Signal handle resolution
// ---------------------------------------------------------------------------

export type ChatPlatform = 'discord' | 'signal';

interface HandleNamespace {
  field: string;
  normalize: (raw: string) => string | null;
}

function pickNamespace(
  platform: ChatPlatform,
  raw: string,
): HandleNamespace | null {
  if (platform === 'discord') {
    // Snowflake: 17–20 digit numeric string
    if (/^\d{17,20}$/.test(raw)) {
      return { field: 'discord_snowflake', normalize: (s) => s };
    }
    return {
      field: 'discord_username',
      normalize: (s) => s.replace(/#\d+$/, '').toLowerCase().trim() || null,
    };
  }
  // signal
  if (/^\+?\d[\d\s().-]{6,}$/.test(raw)) {
    return {
      field: 'signal_phone',
      normalize: (s) => {
        const digits = s.replace(/[^\d+]/g, '');
        if (!digits) return null;
        return digits.startsWith('+') ? digits : `+${digits}`;
      },
    };
  }
  if (/^[0-9a-f-]{36}$/i.test(raw)) {
    return { field: 'signal_uuid', normalize: (s) => s.toLowerCase() };
  }
  return {
    field: 'signal_profile_name',
    normalize: (s) => s.normalize('NFC').trim() || null,
  };
}

/**
 * Idempotent: resolve or create a person entity from a chat platform handle.
 * Supports Discord (username / snowflake ID) and Signal (phone / UUID /
 * profile name). Normalizes the handle before lookup and insertion.
 */
export async function createPersonFromHandle(
  platform: ChatPlatform,
  rawHandle: string,
  displayName?: string,
): Promise<Entity> {
  const ns = pickNamespace(platform, rawHandle);
  if (!ns) {
    throw new Error(
      `createPersonFromHandle: cannot classify '${rawHandle}'`,
    );
  }
  const value = ns.normalize(rawHandle);
  if (!value) {
    throw new Error(
      `createPersonFromHandle: empty after normalize '${rawHandle}'`,
    );
  }

  const db = getBrainDb();

  // Fast path: alias already exists.
  const existingId = findEntityIdByAlias(db, ns.field, value);
  if (existingId) {
    const e = readEntity(db, existingId);
    if (e) return e;
  }

  const entityId = newId();
  const aliasId = newId();
  const now = new Date().toISOString();
  const canonical = JSON.stringify(
    displayName
      ? { name: displayName, [ns.field]: value }
      : { [ns.field]: value },
  );

  await getWriteQueue().enqueue({
    run: (database) => {
      // Re-check inside transaction to handle concurrent ingest.
      const raceId = findEntityIdByAlias(database, ns.field, value);
      if (raceId) return;
      database
        .prepare(
          `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
           VALUES (?, 'person', ?, ?, ?)`,
        )
        .run(entityId, canonical, now, now);
      database
        .prepare(
          `INSERT INTO entity_aliases
             (alias_id, entity_id, source_type, source_ref, field_name,
              field_value, valid_from, valid_until, confidence)
           VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 1.0)`,
        )
        .run(aliasId, entityId, platform, ns.field, value, now);
    },
  });

  // Read back — if a racing writer won, we get their entity.
  const finalId = findEntityIdByAlias(db, ns.field, value);
  if (!finalId) {
    throw new Error(
      `createPersonFromHandle: failed to persist ${value}`,
    );
  }
  const final = readEntity(db, finalId);
  if (!final) {
    throw new Error(
      `createPersonFromHandle: entity row missing for ${finalId}`,
    );
  }
  return final;
}
