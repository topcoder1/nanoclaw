/**
 * Auto-merge engine. Nightly sweep that finds duplicate entities by
 * deterministic SQL rules and either silently merges them (high confidence)
 * or persists chat suggestions for operator review (medium confidence).
 *
 * Spec: docs/superpowers/specs/2026-04-28-auto-merge-design.md
 */

import type Database from 'better-sqlite3';

/**
 * Return the two entity ids in lex-smaller-first order. Throws if equal —
 * callers should never construct a pair from the same id.
 */
export function lexOrdered(a: string, b: string): [string, string] {
  if (a === b) {
    throw new Error(`lexOrdered: refusing equal pair ${a}`);
  }
  return a < b ? [a, b] : [b, a];
}

/**
 * Normalize a phone string to E.164-ish form. Strips all non-digit chars
 * (except a leading `+`), then re-prefixes `+` if missing. Returns null
 * if no digits remain or the input lacks any digit characters at all.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasDigits = /\d/.test(trimmed);
  if (!hasDigits) return null;
  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  // If the original started with '+' OR begins with a country code (11 digits
  // starting with 1 for NANP), keep it. Otherwise also prefix '+' so all forms
  // collapse — the test fixtures show '16263483472' and '+16263483472' must
  // collide.
  if (startsWithPlus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export interface HighConfidencePair {
  entity_id_a: string;          // lex-smaller
  entity_id_b: string;
  reason_code: 'email_exact' | 'phone_normalized' | 'signal_uuid_exact'
    | 'discord_snowflake_exact' | 'whatsapp_jid_exact';
  fields_matched: string[];     // e.g. ['email','phone']
  confidence: 1.0;
}

const HARD_IDENTIFIER_FIELDS: ReadonlyArray<{
  field: string;
  reasonCode: HighConfidencePair['reason_code'];
  normalize: (raw: string) => string | null;
}> = [
  { field: 'email', reasonCode: 'email_exact', normalize: (r) => r.trim().toLowerCase() || null },
  { field: 'phone', reasonCode: 'phone_normalized', normalize: normalizePhone },
  { field: 'signal_uuid', reasonCode: 'signal_uuid_exact', normalize: (r) => r.trim().toLowerCase() || null },
  { field: 'discord_snowflake', reasonCode: 'discord_snowflake_exact', normalize: (r) => r.trim() || null },
  { field: 'whatsapp_jid', reasonCode: 'whatsapp_jid_exact', normalize: (r) => r.trim().toLowerCase() || null },
];

/**
 * Find every (a, b) pair of person entities that share a normalized value
 * for any hard-identifier field. Returned pairs are lex-ordered and
 * deduplicated across fields — a pair matched by both email AND phone
 * appears once with both names in `fields_matched`.
 */
export function findHighConfidenceCandidates(
  db: Database.Database,
): HighConfidencePair[] {
  type Row = { entity_id: string; entity_type: string; field_name: string; field_value: string };
  const rows = db
    .prepare(
      `SELECT a.entity_id, e.entity_type, a.field_name, a.field_value
         FROM entity_aliases a
         JOIN entities e ON e.entity_id = a.entity_id
        WHERE a.field_name IN (${HARD_IDENTIFIER_FIELDS.map(() => '?').join(',')})`,
    )
    .all(...HARD_IDENTIFIER_FIELDS.map((f) => f.field)) as Row[];

  const buckets = new Map<string, Set<string>>();
  const pairFields = new Map<string, Set<string>>();

  for (const r of rows) {
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === r.field_name);
    if (!cfg) continue;
    const norm = cfg.normalize(r.field_value);
    if (!norm) continue;
    const key = `${r.entity_type}|${r.field_name}|${norm}`;
    const set = buckets.get(key) ?? new Set();
    set.add(r.entity_id);
    buckets.set(key, set);
  }

  for (const [key, ids] of buckets) {
    if (ids.size < 2) continue;
    const fieldName = key.split('|')[1];
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = lexOrdered(sorted[i], sorted[j]);
        const pairKey = `${a}|${b}`;
        const fields = pairFields.get(pairKey) ?? new Set();
        fields.add(fieldName);
        pairFields.set(pairKey, fields);
      }
    }
  }

  const out: HighConfidencePair[] = [];
  for (const [pairKey, fields] of pairFields) {
    // pairKey safely splits on '|' because entity ids are ULIDs (Crockford
    // base32), which never contain '|'.
    const [a, b] = pairKey.split('|');
    // Derive reason_code deterministically from the matched fields by picking
    // the first hard-identifier in declaration order that appears in `fields`.
    // This avoids depending on SQLite row order or Map insertion order.
    const reasonCode = HARD_IDENTIFIER_FIELDS.find((f) => fields.has(f.field))!
      .reasonCode;
    out.push({
      entity_id_a: a,
      entity_id_b: b,
      reason_code: reasonCode,
      fields_matched: [...fields].sort(),
      confidence: 1.0,
    });
  }
  return out;
}

export interface MediumConfidencePair {
  entity_id_a: string;          // lex-smaller
  entity_id_b: string;
  reason_code: 'name_exact';
  confidence: number;           // 0.5–0.8
  evidence: {
    fields_matched: string[];
    canonical_a: Record<string, unknown>;
    canonical_b: Record<string, unknown>;
  };
}

/**
 * Find every (a, b) pair of entities of the same type whose canonical name
 * matches case-insensitively after trim, EXCLUDING pairs that share a
 * hard-identifier field with conflicting values. The conflict short-circuit
 * is what protects us from merging two real people who happen to share a
 * common first name.
 */
export function findMediumConfidenceCandidates(
  db: Database.Database,
): MediumConfidencePair[] {
  type GroupRow = {
    entity_id: string;
    entity_type: string;
    name_norm: string;
    canonical: string;
  };
  // Group by lower(trim(name)) within each entity_type.
  const rows = db
    .prepare(
      `SELECT entity_id, entity_type,
              LOWER(TRIM(json_extract(canonical, '$.name'))) AS name_norm,
              canonical
         FROM entities
        WHERE json_extract(canonical, '$.name') IS NOT NULL
          AND TRIM(json_extract(canonical, '$.name')) != ''`,
    )
    .all() as GroupRow[];

  // Bucket by (entity_type, name_norm).
  const buckets = new Map<string, GroupRow[]>();
  for (const r of rows) {
    const key = `${r.entity_type}|${r.name_norm}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  // For each bucket of size >= 2, emit pairs (i, j) and apply the
  // conflicting-identifier short-circuit.
  const out: MediumConfidencePair[] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ri = list[i];
        const rj = list[j];
        if (hasConflictingIdentifier(db, ri.entity_id, rj.entity_id)) continue;
        const [a, b] = lexOrdered(ri.entity_id, rj.entity_id);
        const canonA = a === ri.entity_id ? safeJson(ri.canonical) : safeJson(rj.canonical);
        const canonB = a === ri.entity_id ? safeJson(rj.canonical) : safeJson(ri.canonical);
        out.push({
          entity_id_a: a,
          entity_id_b: b,
          reason_code: 'name_exact',
          confidence: 0.6,
          evidence: {
            fields_matched: ['name'],
            canonical_a: canonA,
            canonical_b: canonB,
          },
        });
      }
    }
  }
  return out;
}

/**
 * Returns true if the given pair has an active suppression row. A row is
 * active when `suppressed_until` is NULL (permanent) or > now.
 */
export function isSuppressed(
  db: Database.Database,
  entityA: string,
  entityB: string,
  nowMs: number = Date.now(),
): boolean {
  const [a, b] = lexOrdered(entityA, entityB);
  const row = db
    .prepare(
      `SELECT suppressed_until FROM entity_merge_suppressions
        WHERE entity_id_a = ? AND entity_id_b = ?`,
    )
    .get(a, b) as { suppressed_until: number | null } | undefined;
  if (!row) return false;
  if (row.suppressed_until == null) return true;
  return row.suppressed_until > nowMs;
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Returns true if entityA and entityB both have an alias for the same
 * hard-identifier field but with different normalized values. Two
 * entities with the same hard-id field-name but only ONE side populated
 * are NOT a conflict — only the both-populated-and-different case.
 */
function hasConflictingIdentifier(
  db: Database.Database,
  entityA: string,
  entityB: string,
): boolean {
  type Row = { entity_id: string; field_name: string; field_value: string };
  const rows = db
    .prepare(
      `SELECT entity_id, field_name, field_value
         FROM entity_aliases
        WHERE entity_id IN (?, ?)
          AND field_name IN (${HARD_IDENTIFIER_FIELDS.map(() => '?').join(',')})`,
    )
    .all(entityA, entityB, ...HARD_IDENTIFIER_FIELDS.map((f) => f.field)) as Row[];

  // For each field, collect normalized values per entity.
  const byField = new Map<string, { a: Set<string>; b: Set<string> }>();
  for (const r of rows) {
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === r.field_name);
    if (!cfg) continue;
    const norm = cfg.normalize(r.field_value);
    if (!norm) continue;
    const slot = byField.get(r.field_name) ?? { a: new Set(), b: new Set() };
    if (r.entity_id === entityA) slot.a.add(norm);
    else slot.b.add(norm);
    byField.set(r.field_name, slot);
  }
  for (const { a, b } of byField.values()) {
    if (a.size === 0 || b.size === 0) continue;     // not both populated
    // Conflict iff there is no overlap.
    let overlap = false;
    for (const v of a) {
      if (b.has(v)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return true;
  }
  return false;
}
