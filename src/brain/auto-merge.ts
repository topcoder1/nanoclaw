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
  const pairReasons = new Map<string, HighConfidencePair['reason_code']>();

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
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === fieldName)!;
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = lexOrdered(sorted[i], sorted[j]);
        const pairKey = `${a}|${b}`;
        const fields = pairFields.get(pairKey) ?? new Set();
        fields.add(fieldName);
        pairFields.set(pairKey, fields);
        if (!pairReasons.has(pairKey)) {
          pairReasons.set(pairKey, cfg.reasonCode);
        }
      }
    }
  }

  const out: HighConfidencePair[] = [];
  for (const [pairKey, fields] of pairFields) {
    const [a, b] = pairKey.split('|');
    out.push({
      entity_id_a: a,
      entity_id_b: b,
      reason_code: pairReasons.get(pairKey)!,
      fields_matched: [...fields].sort(),
      confidence: 1.0,
    });
  }
  return out;
}
