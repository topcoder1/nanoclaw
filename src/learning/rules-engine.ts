import { randomUUID } from 'crypto';

import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface LearnedRule {
  id: string;
  rule: string;
  source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
  /**
   * Discriminator within `source`. NULL for legacy rows. Brain-batch
   * reflections use `source='agent_reported', subsource='brain_reflection'`
   * so they can be filtered apart from real-time agent-reported rules
   * without expanding the existing CHECK constraint on `source`.
   */
  subsource: string | null;
  actionClasses: string[];
  groupId: string | null;
  confidence: number;
  evidenceCount: number;
  createdAt: string;
  lastMatchedAt: string;
  /** ID of the rule this one replaces (NULL = original). */
  supersedesId: string | null;
  /** When this rule was retired by a newer one (NULL = active). */
  supersededAt: string | null;
}

export type AddRuleInput = Omit<
  LearnedRule,
  | 'id'
  | 'createdAt'
  | 'lastMatchedAt'
  | 'supersedesId'
  | 'supersededAt'
  | 'subsource'
> & {
  /** Optional discriminator — defaults to NULL (legacy / generic rule). */
  subsource?: string | null;
  /** Optional — supplied when this rule is replacing an older one. */
  supersedesId?: string | null;
};

interface RuleRow {
  id: string;
  rule: string;
  source: string;
  subsource: string | null;
  action_classes: string;
  group_id: string | null;
  confidence: number;
  evidence_count: number;
  created_at: string;
  last_matched_at: string;
  supersedes_id: string | null;
  superseded_at: string | null;
}

function rowToRule(row: RuleRow): LearnedRule {
  return {
    id: row.id,
    rule: row.rule,
    source: row.source as LearnedRule['source'],
    subsource: row.subsource ?? null,
    actionClasses: JSON.parse(row.action_classes) as string[],
    groupId: row.group_id,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    createdAt: row.created_at,
    lastMatchedAt: row.last_matched_at,
    supersedesId: row.supersedes_id ?? null,
    supersededAt: row.superseded_at ?? null,
  };
}

export function initRulesStore(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_rules (
      id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('outcome_pattern', 'user_feedback', 'agent_reported')),
      action_classes TEXT NOT NULL,
      group_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_matched_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS learned_rules_fts USING fts5(
      rule,
      action_classes,
      content=learned_rules,
      content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS learned_rules_fts_insert
      AFTER INSERT ON learned_rules BEGIN
        INSERT INTO learned_rules_fts(rowid, rule, action_classes)
        VALUES (new.rowid, new.rule, new.action_classes);
      END;
    CREATE TRIGGER IF NOT EXISTS learned_rules_fts_delete
      AFTER DELETE ON learned_rules BEGIN
        INSERT INTO learned_rules_fts(learned_rules_fts, rowid, rule, action_classes)
        VALUES ('delete', old.rowid, old.rule, old.action_classes);
      END;
  `);
  applyColumnMigrations(db);
  logger.debug('Rules store initialized');
}

/**
 * Idempotent column additions for pre-existing learned_rules tables. Same
 * pattern as src/brain/db.ts:applyColumnMigrations — re-applying is a no-op
 * because SQLite throws "duplicate column" when the column already exists.
 *
 * Adds (brain-reflection v1):
 *   - subsource     — discriminator within `source` (e.g. 'brain_reflection')
 *   - supersedes_id — FK to the rule this one replaces
 *   - superseded_at — when this rule was retired by a newer one
 */
function applyColumnMigrations(db: ReturnType<typeof getDb>): void {
  for (const sql of [
    `ALTER TABLE learned_rules ADD COLUMN subsource TEXT`,
    `ALTER TABLE learned_rules ADD COLUMN supersedes_id TEXT`,
    `ALTER TABLE learned_rules ADD COLUMN superseded_at TEXT`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* column already exists — idempotent no-op */
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_learned_rules_active
       ON learned_rules(superseded_at, subsource)
       WHERE superseded_at IS NULL`,
  );
}

export function addRule(input: AddRuleInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO learned_rules
       (id, rule, source, subsource, action_classes, group_id,
        confidence, evidence_count, created_at, last_matched_at,
        supersedes_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.rule,
    input.source,
    input.subsource ?? null,
    JSON.stringify(input.actionClasses),
    input.groupId,
    input.confidence,
    input.evidenceCount,
    now,
    now,
    input.supersedesId ?? null,
  );

  logger.debug(
    {
      id,
      source: input.source,
      subsource: input.subsource ?? null,
      groupId: input.groupId,
    },
    'Rule added',
  );
  return id;
}

/**
 * List active (non-superseded) rules, optionally narrowed to a source /
 * subsource / time window. Used by the brain reflection job to find
 * candidates for supersession and by the weekly digest to surface
 * freshly-emitted rules.
 */
export function listActiveRules(
  opts: {
    source?: LearnedRule['source'];
    subsource?: string;
    since?: string;
    limit?: number;
  } = {},
): LearnedRule[] {
  const db = getDb();
  const filters: string[] = ['superseded_at IS NULL'];
  const params: (string | number)[] = [];
  if (opts.source !== undefined) {
    filters.push('source = ?');
    params.push(opts.source);
  }
  if (opts.subsource !== undefined) {
    filters.push('subsource = ?');
    params.push(opts.subsource);
  }
  if (opts.since) {
    filters.push('created_at >= ?');
    params.push(opts.since);
  }
  const limit = opts.limit ?? 100;
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM learned_rules
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(...params) as RuleRow[];
  return rows.map(rowToRule);
}

/**
 * Mark a rule superseded. The new rule (already inserted via `addRule`)
 * carries `supersedes_id = oldId`; here we stamp the old row's
 * `superseded_at` so it stops surfacing as active.
 */
export function markSuperseded(oldId: string, atIso?: string): void {
  const db = getDb();
  const ts = atIso ?? new Date().toISOString();
  db.prepare(
    `UPDATE learned_rules
        SET superseded_at = ?
      WHERE id = ? AND superseded_at IS NULL`,
  ).run(ts, oldId);
}

export function queryRules(
  actionClasses: string[],
  groupId: string,
  limit = 5,
): LearnedRule[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const classFilter = actionClasses
    .map(() => 'action_classes LIKE ?')
    .join(' OR ');
  // Excludes (a) superseded rules (the new pointer chain stays intact for
  // audit but they don't surface to live prompts) and (b) brain-reflection
  // rules — those use group_id=NULL by design (agent-wide), but v1 of the
  // brain reflection layer is digest-only. Without this guard,
  // `buildRulesBlock(...)` would inject brain-reflection rules into every
  // group's container prompt via the `group_id IS NULL` branch below,
  // skipping the observation period the design doc requires before
  // promotion.
  const baseFilter =
    'superseded_at IS NULL ' +
    `AND (subsource IS NULL OR subsource <> 'brain_reflection')`;
  const sql = classFilter
    ? `SELECT * FROM learned_rules
       WHERE ${baseFilter}
         AND (group_id = ? OR group_id IS NULL)
         AND (${classFilter})
         AND (last_matched_at >= ? OR created_at >= ?)
       ORDER BY confidence DESC LIMIT ?`
    : `SELECT * FROM learned_rules
       WHERE ${baseFilter}
         AND (group_id = ? OR group_id IS NULL)
         AND (last_matched_at >= ? OR created_at >= ?)
       ORDER BY confidence DESC LIMIT ?`;

  const params: (string | number)[] = [groupId];
  if (classFilter) {
    for (const cls of actionClasses) params.push(`%${cls}%`);
  }
  params.push(cutoff, cutoff, limit);

  const rows = db.prepare(sql).all(...params) as RuleRow[];
  return rows.map(rowToRule);
}

export function markMatched(ruleId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE learned_rules SET last_matched_at = ? WHERE id = ?`).run(
    now,
    ruleId,
  );
}

export function pruneStaleRules(): number {
  const db = getDb();
  // Skip superseded rules — the supersession chain (new rule's
  // supersedes_id → old rule.id) is needed for audit and would dangle if
  // the old rule were deleted. Confidence-based pruning only applies to
  // live rules.
  const result = db
    .prepare(
      `DELETE FROM learned_rules
        WHERE confidence < 0.1
          AND superseded_at IS NULL`,
    )
    .run();
  const count = result.changes;
  if (count > 0) logger.info({ count }, 'Pruned stale rules');
  return count;
}

export function deleteRule(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM learned_rules WHERE id = ?`).run(id);
}

export function decayConfidence(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // Don't decay superseded rules — they will never match again so the decay
  // loop pointlessly grinds them toward the prune threshold.
  const result = db
    .prepare(
      `UPDATE learned_rules
          SET confidence = MAX(0.0, confidence - 0.1)
        WHERE last_matched_at < ?
          AND superseded_at IS NULL`,
    )
    .run(cutoff);
  return result.changes;
}
