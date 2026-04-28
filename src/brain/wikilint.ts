/**
 * `/wikilint` health checker (Phase 4) — read-only audit over `brain.db`
 * surfacing four classes of issue that compound silently as KUs accumulate:
 *
 *   1. Near-duplicate KUs (cosine ≥ threshold within same `topic_key` for
 *      the same entity, both un-superseded).
 *   2. Temporal contradictions (same `(entity, predicate-ish topic_key)`
 *      with overlapping `[valid_from, valid_until]` and conflicting text).
 *   3. Orphan entities (`entities` row with <2 linked KUs and >30 days old).
 *   4. Stale wiki pages (`last_synthesis_at` older than the most recent
 *      `valid_from` of any non-superseded KU for that entity).
 *
 * **No autonomous CRUD.** Each finding ships with a "merge / mark-superseded
 * / ignore" suggestion in the report, but the user runs the action manually
 * (top anti-pattern from both deep-research passes). The detectors here
 * never write to `brain.db`.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { fetchKuVectors } from './qdrant.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Finding =
  | { kind: 'duplicate_kus'; kuIdA: string; kuIdB: string; cosine: number }
  | {
      kind: 'temporal_contradiction';
      entityId: string;
      kuIdA: string;
      kuIdB: string;
    }
  | {
      kind: 'orphan_entity';
      entityId: string;
      kuCount: number;
      ageDays: number;
    }
  | {
      kind: 'stale_wiki_page';
      entityId: string;
      lastSynthesisAt: string;
      newestKuValidFrom: string;
    };

// ---------------------------------------------------------------------------
// Class 3 — orphan entities
// ---------------------------------------------------------------------------

/**
 * Entities with <2 linked KUs and a `created_at` older than 30 days. The
 * threshold is a heuristic: real entities accumulate ≥2 mentions quickly
 * (a person gets at least one email + one calendar event), so anything
 * below that after a month is almost certainly an extraction artifact.
 *
 * Pure SQL — uses `julianday` for the age calculation. `nowIso` is
 * injectable so tests are deterministic without faking the clock.
 */
export function findOrphanEntities(
  db: Database.Database,
  opts: { nowIso?: string } = {},
): Finding[] {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT e.entity_id AS entity_id,
              COUNT(ke.ku_id) AS ku_count,
              julianday(?) - julianday(e.created_at) AS age_days
         FROM entities e
         LEFT JOIN ku_entities ke ON ke.entity_id = e.entity_id
        GROUP BY e.entity_id
        HAVING ku_count < 2
           AND age_days > 30`,
    )
    .all(nowIso) as Array<{
    entity_id: string;
    ku_count: number;
    age_days: number;
  }>;

  return rows.map((r) => ({
    kind: 'orphan_entity',
    entityId: r.entity_id,
    kuCount: r.ku_count,
    ageDays: r.age_days,
  }));
}

// ---------------------------------------------------------------------------
// Other detectors + report formatter — landed incrementally below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Class 4 — stale wiki pages
// ---------------------------------------------------------------------------

/**
 * Entities whose `last_synthesis_at` predates the most recent `valid_from`
 * of any non-superseded linked KU. Excludes entities never synthesized
 * (NULL last_synthesis_at) — those are not "stale", just unmaterialized,
 * and the on-insert `WikiRebuildHandler` covers them.
 *
 * Backed by `idx_entities_synthesis_stale` (partial index on
 * `last_synthesis_at IS NOT NULL`) so this scales as the entity table
 * grows; the join key is the existing `idx_ku_entities_entity`.
 */
export function findStaleWikiPages(db: Database.Database): Finding[] {
  const rows = db
    .prepare(
      `SELECT e.entity_id AS entity_id,
              e.last_synthesis_at AS last_synthesis_at,
              MAX(ku.valid_from) AS newest
         FROM entities e
         JOIN ku_entities ke ON ke.entity_id = e.entity_id
         JOIN knowledge_units ku ON ku.id = ke.ku_id
        WHERE e.last_synthesis_at IS NOT NULL
          AND ku.superseded_at IS NULL
        GROUP BY e.entity_id
        HAVING newest > e.last_synthesis_at`,
    )
    .all() as Array<{
    entity_id: string;
    last_synthesis_at: string;
    newest: string;
  }>;

  return rows.map((r) => ({
    kind: 'stale_wiki_page',
    entityId: r.entity_id,
    lastSynthesisAt: r.last_synthesis_at,
    newestKuValidFrom: r.newest,
  }));
}

// ---------------------------------------------------------------------------
// Class 2 — temporal contradictions
// ---------------------------------------------------------------------------

/**
 * Pairs of un-superseded KUs that share the same `topic_key` and the same
 * linked entity, have different text, and have overlapping
 * `[valid_from, valid_until]` intervals (NULL = open-ended). Identical text
 * is excluded — that's a class-1 duplicate, not a contradiction.
 *
 * `a.id < b.id` enforces a canonical pair ordering so each conflict is
 * reported once. NULL `topic_key` rows are filtered out by SQL's NULL
 * inequality semantics (NULL = NULL evaluates to NULL, not TRUE).
 */
export function findTemporalContradictions(
  db: Database.Database,
): Finding[] {
  const rows = db
    .prepare(
      `SELECT a.id AS ku_a,
              b.id AS ku_b,
              kea.entity_id AS entity_id
         FROM knowledge_units a
         JOIN knowledge_units b
           ON a.topic_key = b.topic_key
          AND a.id < b.id
         JOIN ku_entities kea ON kea.ku_id = a.id
         JOIN ku_entities keb
           ON keb.ku_id = b.id
          AND keb.entity_id = kea.entity_id
        WHERE a.superseded_at IS NULL
          AND b.superseded_at IS NULL
          AND a.text != b.text
          AND (a.valid_until IS NULL OR b.valid_from < a.valid_until)
          AND (b.valid_until IS NULL OR a.valid_from < b.valid_until)`,
    )
    .all() as Array<{ ku_a: string; ku_b: string; entity_id: string }>;

  return rows.map((r) => ({
    kind: 'temporal_contradiction',
    entityId: r.entity_id,
    kuIdA: r.ku_a,
    kuIdB: r.ku_b,
  }));
}

// ---------------------------------------------------------------------------
// Class 1 — near-duplicate KUs (cosine ≥ threshold)
// ---------------------------------------------------------------------------

/** Default cosine threshold above which two KUs are flagged as near-duplicates. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

/**
 * Cap on candidate pairs evaluated per `findDuplicateKus` call. The plan
 * (`brain-2026-04-27-phases-3-5-detailed.md` §4.1) sets this at 500 to
 * bound Qdrant fetch cost; once exceeded we stop generating pairs.
 */
export const DEFAULT_MAX_PAIRS = 500;

/**
 * Groups with more than this many un-superseded KUs sharing a single
 * `(entity, topic_key)` tuple are themselves anomalous (an extraction
 * runaway, almost certainly), so we skip them with a `warn` log rather
 * than burning the entire pair budget on one runaway group.
 *
 * 32 KUs → 32*31/2 = 496 pairs, just shy of `DEFAULT_MAX_PAIRS`. Beyond
 * that and a single bad group would eat the whole budget.
 */
export const DEFAULT_MAX_KUS_PER_GROUP = 32;

export interface DuplicateKusOptions {
  /** Cosine cutoff. Default {@link DEFAULT_DUPLICATE_THRESHOLD}. */
  threshold?: number;
  /** Hard cap on candidate pairs across all groups. */
  maxPairs?: number;
  /** Per-group KU cap; groups above this are logged + skipped. */
  maxKusPerGroup?: number;
  /**
   * Vector source. Default: `fetchKuVectors` against the live Qdrant
   * client. Tests inject a stub.
   */
  fetchVectors?: (kuIds: string[]) => Promise<Map<string, number[]>>;
}

interface KuPair {
  a: string;
  b: string;
  entityId: string;
  topicKey: string;
}

/**
 * Cosine similarity for two equal-length vectors. Returns 0 if either is
 * zero-length (avoids NaN when Qdrant returns an empty vector).
 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Near-duplicate KU detector. Walks `(entity, topic_key)` groups of
 * un-superseded KUs, generates candidate pairs (`a.id < b.id` for canonical
 * ordering), fetches vectors in one Qdrant round-trip, and emits findings
 * for pairs whose cosine clears the threshold. Bounded by `maxPairs` so a
 * pathological topic_key can't blow up the run.
 *
 * `fetchVectors` is injected for tests; production passes through to
 * `qdrant.fetchKuVectors` (default).
 */
export async function findDuplicateKus(
  db: Database.Database,
  opts: DuplicateKusOptions = {},
): Promise<Finding[]> {
  const threshold = opts.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
  const maxKusPerGroup = opts.maxKusPerGroup ?? DEFAULT_MAX_KUS_PER_GROUP;
  const fetchVectors = opts.fetchVectors ?? fetchKuVectors;

  // Pull one row per (entity, topic_key, ku) so the grouping happens in JS.
  // SQLite GROUP_CONCAT would also work but the in-JS form keeps the per-
  // group cap easy to enforce and the output testable.
  const rows = db
    .prepare(
      `SELECT ke.entity_id AS entity_id,
              ku.topic_key AS topic_key,
              ku.id AS ku_id
         FROM knowledge_units ku
         JOIN ku_entities ke ON ke.ku_id = ku.id
        WHERE ku.superseded_at IS NULL
          AND ku.topic_key IS NOT NULL
        ORDER BY ke.entity_id, ku.topic_key, ku.id`,
    )
    .all() as Array<{ entity_id: string; topic_key: string; ku_id: string }>;

  // Group by `${entity_id} ${topic_key}`. Null byte is illegal in
  // entity_id (ULID base32) and topic_key (extractor convention) so it's a
  // safe separator.
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.entity_id} ${r.topic_key}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r.ku_id);
  }

  // Generate candidate pairs, applying both caps.
  const pairs: KuPair[] = [];
  for (const [key, kuIds] of groups) {
    if (kuIds.length < 2) continue;
    if (kuIds.length > maxKusPerGroup) {
      logger.warn(
        { entityId: key.split(' ')[0], topicKey: key.split(' ')[1], count: kuIds.length },
        'wikilint: skipping oversize duplicate-candidate group',
      );
      continue;
    }
    const [entityId, topicKey] = key.split(' ');
    for (let i = 0; i < kuIds.length; i++) {
      for (let j = i + 1; j < kuIds.length; j++) {
        if (pairs.length >= maxPairs) break;
        pairs.push({ a: kuIds[i], b: kuIds[j], entityId, topicKey });
      }
      if (pairs.length >= maxPairs) break;
    }
    if (pairs.length >= maxPairs) {
      logger.warn(
        { maxPairs },
        'wikilint: duplicate-candidate cap reached; remaining groups skipped',
      );
      break;
    }
  }

  if (pairs.length === 0) return [];

  // Single Qdrant round-trip for all unique KU ids in the candidate set.
  const uniqueIds = Array.from(new Set(pairs.flatMap((p) => [p.a, p.b])));
  const vectors = await fetchVectors(uniqueIds);

  const findings: Finding[] = [];
  for (const p of pairs) {
    const va = vectors.get(p.a);
    const vb = vectors.get(p.b);
    if (!va || !vb) continue; // Vector missing — nothing to compare.
    const c = cosine(va, vb);
    if (c >= threshold) {
      findings.push({
        kind: 'duplicate_kus',
        kuIdA: p.a,
        kuIdB: p.b,
        cosine: c,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// runAll — composes all four detectors in a single pass
// ---------------------------------------------------------------------------

export interface RunAllOptions {
  /** Pinned clock for the orphan-age calculation. ISO. */
  nowIso?: string;
  /** Forwarded to {@link findDuplicateKus}. */
  duplicates?: DuplicateKusOptions;
}

/**
 * Run every detector and return the concatenated findings. Order within
 * each class is whatever SQL/Qdrant returns; downstream `formatWikilintReport`
 * groups the output by class for the user-facing report so call-site
 * ordering doesn't matter.
 */
export async function runAll(
  db: Database.Database,
  opts: RunAllOptions = {},
): Promise<Finding[]> {
  const dup = await findDuplicateKus(db, opts.duplicates);
  return [
    ...dup,
    ...findTemporalContradictions(db),
    ...findOrphanEntities(db, { nowIso: opts.nowIso }),
    ...findStaleWikiPages(db),
  ];
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

/**
 * Render findings as a Telegram-friendly Markdown report. Empty input
 * returns a positive "no issues" line so the cron can deliver it without
 * a special case. Per-class sections are omitted when empty.
 *
 * The user runs all suggested actions manually (`/brain merge …`,
 * `/brain mark-superseded …`, etc.) — this report never autonomously
 * mutates `brain.db`.
 */
export function formatWikilintReport(findings: Finding[]): string {
  if (findings.length === 0) {
    return '🔎 *Wikilint report* — no issues ✅';
  }

  const bucket = {
    duplicate_kus: [] as Extract<Finding, { kind: 'duplicate_kus' }>[],
    temporal_contradiction: [] as Extract<
      Finding,
      { kind: 'temporal_contradiction' }
    >[],
    orphan_entity: [] as Extract<Finding, { kind: 'orphan_entity' }>[],
    stale_wiki_page: [] as Extract<Finding, { kind: 'stale_wiki_page' }>[],
  };
  for (const f of findings) {
    if (f.kind === 'duplicate_kus') bucket.duplicate_kus.push(f);
    else if (f.kind === 'temporal_contradiction')
      bucket.temporal_contradiction.push(f);
    else if (f.kind === 'orphan_entity') bucket.orphan_entity.push(f);
    else bucket.stale_wiki_page.push(f);
  }

  const lines: string[] = [
    `🔎 *Wikilint report* — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    '---',
  ];

  if (bucket.duplicate_kus.length) {
    lines.push(`*Near-duplicate KUs (${bucket.duplicate_kus.length}):*`);
    for (const f of bucket.duplicate_kus) {
      lines.push(
        `  • \`${f.kuIdA}\` ≈ \`${f.kuIdB}\`  (cosine ${f.cosine.toFixed(2)})`,
        `    suggested: \`/brain merge ${f.kuIdA} ${f.kuIdB}\` or dismiss`,
      );
    }
  }

  if (bucket.temporal_contradiction.length) {
    if (lines.length > 2) lines.push('');
    lines.push(
      `*Temporal contradictions (${bucket.temporal_contradiction.length}):*`,
    );
    for (const f of bucket.temporal_contradiction) {
      lines.push(
        `  • entity \`${f.entityId}\`: \`${f.kuIdA}\` ↔ \`${f.kuIdB}\``,
        `    suggested: \`/brain mark-superseded\` on whichever is older`,
      );
    }
  }

  if (bucket.orphan_entity.length) {
    if (lines.length > 2) lines.push('');
    lines.push(`*Orphan entities (${bucket.orphan_entity.length}):*`);
    for (const f of bucket.orphan_entity) {
      lines.push(
        `  • \`${f.entityId}\` — ${f.kuCount} KU${f.kuCount === 1 ? '' : 's'}, ${Math.round(f.ageDays)}d old`,
        `    suggested: \`/brain delete-entity ${f.entityId}\` or ignore`,
      );
    }
  }

  if (bucket.stale_wiki_page.length) {
    if (lines.length > 2) lines.push('');
    lines.push(`*Stale wiki pages (${bucket.stale_wiki_page.length}):*`);
    for (const f of bucket.stale_wiki_page) {
      lines.push(
        `  • \`${f.entityId}\` — synthesized ${f.lastSynthesisAt}, newer KU at ${f.newestKuValidFrom}`,
        `    suggested: re-run \`/wiki ${f.entityId}\` to refresh`,
      );
    }
  }

  return lines.join('\n');
}
