import type Database from 'better-sqlite3';
import type { EntityMergeRequestedEvent } from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { mergeEntities } from './identity-merge.js';

export interface MergeHandlerOpts {
  db?: Database.Database;
  /**
   * Send an ack/error reply back to the source chat. Wired by chat-ingest
   * to the appropriate channel router. Tests capture into an array.
   */
  sendReply?: (text: string) => Promise<void>;
}

interface ResolvedCandidate {
  entity_id: string;
  reason: 'alias' | 'canonical_name';
}

/**
 * Resolve a handle to person entity_ids.
 *   1. Exact alias match (case-insensitive on field_value, any field_name).
 *   2. Canonical name match (canonical->>'name' lowercased == handle lowered).
 * Returns ALL distinct matches so callers detect ambiguity.
 */
function resolveHandle(
  db: Database.Database,
  handle: string,
): ResolvedCandidate[] {
  const lowered = handle.trim().toLowerCase();
  if (!lowered) return [];

  const aliasHits = db
    .prepare(
      `SELECT DISTINCT entity_id FROM entity_aliases
        WHERE LOWER(field_value) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;

  const nameHits = db
    .prepare(
      `SELECT entity_id FROM entities
        WHERE entity_type = 'person'
          AND LOWER(json_extract(canonical, '$.name')) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;

  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const r of aliasHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'alias' });
      seen.add(r.entity_id);
    }
  }
  for (const r of nameHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'canonical_name' });
      seen.add(r.entity_id);
    }
  }
  return out;
}

export async function handleEntityMergeRequested(
  evt: EntityMergeRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const candA = resolveHandle(db, evt.handle_a);
  const candB = resolveHandle(db, evt.handle_b);

  if (candA.length === 0) {
    await reply(`claw merge: handle '${evt.handle_a}' not found`);
    return;
  }
  if (candB.length === 0) {
    await reply(`claw merge: handle '${evt.handle_b}' not found`);
    return;
  }
  if (candA.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_a}' is ambiguous (${candA.length} matches) — quote a more specific name or pass an entity_id`,
    );
    return;
  }
  if (candB.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_b}' is ambiguous (${candB.length} matches)`,
    );
    return;
  }

  const a = candA[0].entity_id;
  const b = candB[0].entity_id;
  if (a === b) {
    await reply(
      `claw merge: '${evt.handle_a}' and '${evt.handle_b}' already resolve to the same entity`,
    );
    return;
  }

  // Convention: keep the alphabetically-earlier entity_id (deterministic).
  const [keptId, mergedId] = a < b ? [a, b] : [b, a];

  // Pre-check: if either entity has previously participated in a merge
  // (as kept or merged side), surface a clear error rather than silently
  // creating a chain that mergeEntities only catches in one direction.
  const priorChain = db
    .prepare(
      `SELECT merge_id, kept_entity_id, merged_entity_id FROM entity_merge_log
        WHERE merged_entity_id = ? OR merged_entity_id = ?
           OR kept_entity_id   = ? OR kept_entity_id   = ?
        LIMIT 1`,
    )
    .get(keptId, mergedId, keptId, mergedId) as
    | { merge_id: string; kept_entity_id: string; merged_entity_id: string }
    | undefined;
  if (priorChain) {
    await reply(
      `claw merge: failed — one of these entities is already part of merge ${priorChain.merge_id.slice(0, 6)}… (kept=${priorChain.kept_entity_id.slice(0, 6)}…, merged=${priorChain.merged_entity_id.slice(0, 6)}…); resolve chain first`,
    );
    return;
  }

  try {
    const result = await mergeEntities(keptId, mergedId, {
      evidence: {
        trigger: 'manual',
        requested_by: evt.requested_by_handle,
        platform: evt.platform,
        chat_id: evt.chat_id,
      },
      confidence: 1.0,
      mergedBy: `human:${evt.requested_by_handle}`,
      db,
    });
    await reply(
      `claw merge: ✓ merged ${evt.handle_b} (${mergedId.slice(0, 6)}…) into ${evt.handle_a} (${keptId.slice(0, 6)}…) — log ${result.merge_id.slice(0, 6)}…`,
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), evt },
      'identity-merge-handler: merge failed',
    );
    await reply(
      `claw merge: failed — ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
