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
  matched_field?:
    | 'email'
    | 'phone'
    | 'name'
    | 'slack_id'
    | 'signal_uuid'
    | 'discord_snowflake'
    | 'whatsapp_jid';
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
  if (!kept)
    throw new Error(`mergeEntities: kept entity ${keptEntityId} not found`);
  if (!merged)
    throw new Error(`mergeEntities: merged entity ${mergedEntityId} not found`);
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

  // Capture pre-merge state of both entities so unmergeEntities can restore.
  // Done outside the transaction since these are reads — the transaction body
  // then mutates rows we just snapshotted.
  const keptKuEntities = db
    .prepare(
      `SELECT ku_id, entity_id, role FROM ku_entities WHERE entity_id = ?`,
    )
    .all(keptEntityId);
  const mergedKuEntities = db
    .prepare(
      `SELECT ku_id, entity_id, role FROM ku_entities WHERE entity_id = ?`,
    )
    .all(mergedEntityId);
  const mergedAliases = db
    .prepare(`SELECT * FROM entity_aliases WHERE entity_id = ?`)
    .all(mergedEntityId);
  const mergedRelsFrom = db
    .prepare(`SELECT * FROM entity_relationships WHERE from_entity_id = ?`)
    .all(mergedEntityId);
  const mergedRelsTo = db
    .prepare(`SELECT * FROM entity_relationships WHERE to_entity_id = ?`)
    .all(mergedEntityId);

  const snapshot = JSON.stringify({
    schema_version: 2,
    kept,
    merged,
    kept_ku_entities: keptKuEntities,
    merged_ku_entities: mergedKuEntities,
    merged_aliases: mergedAliases,
    merged_relationships_from: mergedRelsFrom,
    merged_relationships_to: mergedRelsTo,
  });

  db.transaction(() => {
    // 1. Rebind ku_entities. INSERT OR IGNORE handles the case where the winner
    //    is already linked to the same KU (would otherwise hit UNIQUE).
    db.prepare(
      `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role)
       SELECT ku_id, ?, role FROM ku_entities WHERE entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);
    db.prepare(`DELETE FROM ku_entities WHERE entity_id = ?`).run(
      mergedEntityId,
    );

    // 2. Rebind entity_aliases (no UNIQUE on entity_id — UPDATE is safe).
    db.prepare(
      `UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);

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

    // 6. Lifecycle: mark any pending suggestion that matches this pair as
    //    accepted. The suggestions table is lex-ordered by (a, b), so we
    //    must lex-sort the inputs before the UPDATE.
    const [sa, sb] =
      keptEntityId < mergedEntityId
        ? [keptEntityId, mergedEntityId]
        : [mergedEntityId, keptEntityId];
    db.prepare(
      `UPDATE entity_merge_suggestions
          SET status = 'accepted', status_at = ?
        WHERE entity_id_a = ? AND entity_id_b = ? AND status = 'pending'`,
    ).run(Date.now(), sa, sb);
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

export interface UnmergeOpts {
  db?: Database.Database;
  /** Override: skip the post-merge-mutation guardrail (default false). */
  force?: boolean;
}

export interface UnmergeResult {
  merge_id: string;
  kept_entity_id: string;
  merged_entity_id: string;
}

/**
 * Undo a previously-executed merge identified by `mergeId`. Reads the
 * pre_merge_snapshot from entity_merge_log, atomically restores the
 * loser's `ku_entities`/`aliases`/`relationships` rows, removes from the
 * winner the rows that came from the loser (rows present in the loser's
 * pre-merge state AND not in the winner's pre-merge state), and deletes
 * the merge_log row.
 *
 * Guardrail (ku_entities only today): if the kept entity has a
 * `ku_entities` row that did NOT exist at merge time AND is not
 * pre-existing in the loser's snapshot (i.e., added after the merge),
 * unmerge refuses unless `force: true`. Aliases and relationships are
 * NOT checked yet — post-merge additions to those will be silently
 * reverted by the restore logic. Tighten if/when this command is
 * exposed beyond manual ops.
 *
 * Snapshots from the v1 era (`schema_version` missing) cannot be undone
 * — the per-row data wasn't captured. The function rejects with a clear
 * error.
 */
export async function unmergeEntities(
  mergeId: string,
  opts: UnmergeOpts = {},
): Promise<UnmergeResult> {
  const db = opts.db ?? getBrainDb();

  const row = db
    .prepare(`SELECT * FROM entity_merge_log WHERE merge_id = ?`)
    .get(mergeId) as
    | {
        merge_id: string;
        kept_entity_id: string;
        merged_entity_id: string;
        pre_merge_snapshot: string;
      }
    | undefined;
  if (!row) {
    throw new Error(`unmergeEntities: merge_id ${mergeId} not found`);
  }

  let snap: {
    schema_version?: number;
    kept_ku_entities?: Array<{
      ku_id: string;
      entity_id: string;
      role: string;
    }>;
    merged_ku_entities?: Array<{
      ku_id: string;
      entity_id: string;
      role: string;
    }>;
    merged_aliases?: Array<Record<string, unknown>>;
    merged_relationships_from?: Array<Record<string, unknown>>;
    merged_relationships_to?: Array<Record<string, unknown>>;
  };
  try {
    snap = JSON.parse(row.pre_merge_snapshot);
  } catch (err) {
    throw new Error(
      `unmergeEntities: snapshot is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if ((snap.schema_version ?? 1) < 2) {
    throw new Error(
      `unmergeEntities: snapshot schema_version is < 2 — predates the rich snapshot capture and cannot be undone`,
    );
  }

  const kept = row.kept_entity_id;
  const merged = row.merged_entity_id;

  // Optional guardrail: refuse if there are new rows on either entity that
  // didn't exist in the snapshot.
  if (!opts.force) {
    const keptPreKuKey = new Set(
      (snap.kept_ku_entities ?? []).map((r) => `${r.ku_id}|${r.role}`),
    );
    const mergedPreKuKey = new Set(
      (snap.merged_ku_entities ?? []).map((r) => `${r.ku_id}|${r.role}`),
    );
    // Today's kept ku_entities must be a subset of (kept_pre ∪ merged_pre);
    // anything else is a post-merge addition.
    const todayKeptKu = db
      .prepare(`SELECT ku_id, role FROM ku_entities WHERE entity_id = ?`)
      .all(kept) as Array<{ ku_id: string; role: string }>;
    const newOnKept = todayKeptKu.filter((r) => {
      const k = `${r.ku_id}|${r.role}`;
      return !keptPreKuKey.has(k) && !mergedPreKuKey.has(k);
    });
    if (newOnKept.length > 0) {
      throw new Error(
        `unmergeEntities: kept entity has ${newOnKept.length} ku_entities row(s) added after the merge — pass force:true to discard them`,
      );
    }
  }

  db.transaction(() => {
    // 1. Reset ku_entities for both entities to their pre-merge state.
    db.prepare(
      `DELETE FROM ku_entities WHERE entity_id = ? OR entity_id = ?`,
    ).run(kept, merged);
    const insertKu = db.prepare(
      `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
    );
    for (const r of snap.kept_ku_entities ?? [])
      insertKu.run(r.ku_id, r.entity_id, r.role);
    for (const r of snap.merged_ku_entities ?? [])
      insertKu.run(r.ku_id, r.entity_id, r.role);

    // 2. Restore loser's aliases (UPDATE entity_id back).
    const restoreAlias = db.prepare(
      `UPDATE entity_aliases SET entity_id = ? WHERE alias_id = ?`,
    );
    for (const a of snap.merged_aliases ?? []) {
      restoreAlias.run(merged, (a as { alias_id: string }).alias_id);
    }

    // 3. Restore loser's relationships in both directions.
    const restoreRelFrom = db.prepare(
      `UPDATE entity_relationships SET from_entity_id = ? WHERE rel_id = ?`,
    );
    for (const r of snap.merged_relationships_from ?? []) {
      restoreRelFrom.run(merged, (r as { rel_id: string }).rel_id);
    }
    const restoreRelTo = db.prepare(
      `UPDATE entity_relationships SET to_entity_id = ? WHERE rel_id = ?`,
    );
    for (const r of snap.merged_relationships_to ?? []) {
      restoreRelTo.run(merged, (r as { rel_id: string }).rel_id);
    }

    // 4. Delete the merge log row.
    db.prepare(`DELETE FROM entity_merge_log WHERE merge_id = ?`).run(mergeId);
  })();

  logger.info(
    { merge_id: mergeId, kept, merged },
    'identity-merge: entities unmerged (rolled back)',
  );

  return {
    merge_id: mergeId,
    kept_entity_id: kept,
    merged_entity_id: merged,
  };
}
