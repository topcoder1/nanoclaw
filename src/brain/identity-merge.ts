/**
 * Identity merge engine. Atomically pivots ku_entities, entity_aliases,
 * and entity_relationships rows from `mergedEntityId` to `keptEntityId`,
 * then writes a row to entity_merge_log capturing the pre-merge state for
 * audit / future undo.
 *
 * Both entity_id rows remain in `entities` after merge — soft-delete via
 * the merge_log table is the convention. Active queries should LEFT JOIN
 * entity_merge_log to filter out the loser when its display matters.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { newId } from './ulid.js';

export interface MergeEvidence {
  trigger: 'manual' | 'deterministic' | 'splink';
  requested_by?: string;
  matched_field?: 'email' | 'phone' | 'name' | 'slack_id' | 'signal_uuid';
  matched_value?: string;
  [k: string]: unknown;
}

export interface MergeOpts {
  evidence: MergeEvidence;
  confidence: number;
  mergedBy: string; // 'deterministic' | 'splink' | `human:${id}`
  db?: Database.Database;
}

export interface MergeResult {
  merge_id: string;
  kept_entity_id: string;
  merged_entity_id: string;
}

/**
 * Merge `mergedEntityId` into `keptEntityId`. Both entities must exist and
 * share entity_type. Self-merges are rejected. Re-merging a loser that's
 * already in entity_merge_log.merged_entity_id is rejected (caller must
 * resolve through the chain first). Error paths are tested in Task 2.
 */
export async function mergeEntities(
  keptEntityId: string,
  mergedEntityId: string,
  opts: MergeOpts,
): Promise<MergeResult> {
  if (keptEntityId === mergedEntityId) {
    throw new Error(`mergeEntities: refusing self-merge of ${keptEntityId}`);
  }
  const db = opts.db ?? getBrainDb();

  const kept = db
    .prepare(`SELECT * FROM entities WHERE entity_id = ?`)
    .get(keptEntityId) as any;
  const merged = db
    .prepare(`SELECT * FROM entities WHERE entity_id = ?`)
    .get(mergedEntityId) as any;
  if (!kept) throw new Error(`mergeEntities: kept entity ${keptEntityId} not found`);
  if (!merged) throw new Error(`mergeEntities: merged entity ${mergedEntityId} not found`);
  if (kept.entity_type !== merged.entity_type) {
    throw new Error(
      `mergeEntities: type mismatch ${kept.entity_type} vs ${merged.entity_type}`,
    );
  }

  const prior = db
    .prepare(
      `SELECT kept_entity_id FROM entity_merge_log WHERE merged_entity_id = ? LIMIT 1`,
    )
    .get(mergedEntityId) as { kept_entity_id: string } | undefined;
  if (prior) {
    throw new Error(
      `mergeEntities: ${mergedEntityId} was already merged into ${prior.kept_entity_id}; resolve chain first`,
    );
  }

  const mergeId = newId();
  const mergedAt = new Date().toISOString();
  const snapshot = JSON.stringify({ kept, merged });

  db.transaction(() => {
    // 1. Rebind ku_entities. INSERT OR IGNORE handles the case where the winner
    //    is already linked to the same KU (would otherwise hit UNIQUE).
    db.prepare(
      `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role)
       SELECT ku_id, ?, role FROM ku_entities WHERE entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);
    db.prepare(`DELETE FROM ku_entities WHERE entity_id = ?`).run(mergedEntityId);

    // 2. Rebind entity_aliases (no UNIQUE on entity_id — UPDATE is safe).
    db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?`).run(
      keptEntityId,
      mergedEntityId,
    );

    // 3. Rebind entity_relationships in both directions.
    db.prepare(
      `UPDATE entity_relationships SET from_entity_id = ? WHERE from_entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);
    db.prepare(
      `UPDATE entity_relationships SET to_entity_id = ? WHERE to_entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);

    // 4. Bump kept entity's updated_at.
    db.prepare(`UPDATE entities SET updated_at = ? WHERE entity_id = ?`).run(
      mergedAt,
      keptEntityId,
    );

    // 5. Write merge log.
    db.prepare(
      `INSERT INTO entity_merge_log
         (merge_id, kept_entity_id, merged_entity_id, pre_merge_snapshot,
          confidence, evidence, merged_at, merged_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mergeId,
      keptEntityId,
      mergedEntityId,
      snapshot,
      opts.confidence,
      JSON.stringify(opts.evidence),
      mergedAt,
      opts.mergedBy,
    );
  })();

  logger.info(
    {
      merge_id: mergeId,
      kept: keptEntityId,
      merged: mergedEntityId,
      by: opts.mergedBy,
    },
    'identity-merge: entities merged',
  );

  return {
    merge_id: mergeId,
    kept_entity_id: keptEntityId,
    merged_entity_id: mergedEntityId,
  };
}
