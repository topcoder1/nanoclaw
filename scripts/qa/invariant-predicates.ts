/**
 * Invariant predicates — canonical SQL for each state-machine invariant.
 *
 * This module is the single source of truth. Both the live checker
 * (scripts/qa/invariants.ts, which reads store/messages.db) and the
 * runtime-proof tests (src/__tests__/invariants-runtime-proof.test.ts,
 * which exercises real mutation APIs against the test DB) import from
 * here so they can't drift. Every predicate returns a count; an
 * invariant holds iff its count is 0.
 *
 * Adding an invariant: add an entry here, reference it from invariants.ts
 * and from invariants-runtime-proof.test.ts.
 */
import type Database from 'better-sqlite3';

export interface InvariantPredicate {
  name: string;
  description: string;
  /**
   * A SQL SELECT returning a single column `n`. The invariant holds iff
   * `n === 0` in the result row. Must be self-contained (no parameters).
   */
  countSql: string;
}

/** State-machine invariants: hold regardless of user behavior or time. */
export const STATE_MACHINE_INVARIANTS: InvariantPredicate[] = [
  {
    name: 'no-orphan-ignore-items',
    description:
      "queue='ignore' items are auto-resolved by the classifier; a queued ignore is a bug",
    countSql: `SELECT COUNT(*) AS n FROM tracked_items WHERE state='queued' AND queue='ignore'`,
  },
  {
    name: 'pushed-state-has-timestamp',
    description: "state='pushed' implies pushed_at is set",
    countSql: `SELECT COUNT(*) AS n FROM tracked_items WHERE state='pushed' AND pushed_at IS NULL`,
  },
  {
    name: 'resolved-state-has-timestamp',
    description:
      "state='resolved' or 'stale' implies resolved_at is set (both are terminal)",
    countSql: `SELECT COUNT(*) AS n FROM tracked_items WHERE state IN ('resolved','stale') AND resolved_at IS NULL`,
  },
  {
    name: 'resolution-fields-paired',
    description:
      'resolved_at and resolution_method are both set or both null',
    countSql: `SELECT COUNT(*) AS n FROM tracked_items WHERE (resolved_at IS NULL) != (resolution_method IS NULL)`,
  },
  {
    name: 'held-state-has-snooze-until',
    description:
      "state='held' implies metadata.snoozed_until is set (otherwise unsnooze sweeper never revives)",
    countSql: `SELECT COUNT(*) AS n FROM tracked_items
               WHERE state='held'
                 AND (metadata IS NULL OR json_extract(metadata,'$.snoozed_until') IS NULL)`,
  },
  {
    name: 'timestamps-monotonic',
    description:
      'pushed_at and resolved_at are always >= detected_at (time monotonicity)',
    countSql: `SELECT COUNT(*) AS n FROM tracked_items
               WHERE (pushed_at IS NOT NULL AND pushed_at < detected_at)
                  OR (resolved_at IS NOT NULL AND resolved_at < detected_at)`,
  },
  {
    name: 'source-id-unique-among-active',
    description:
      'no two active rows (queued/pushed/held) share the same (source, source_id) pair',
    countSql: `SELECT COUNT(*) AS n FROM (
                 SELECT source, source_id FROM tracked_items
                 WHERE state IN ('queued','pushed','held')
                   AND source_id IS NOT NULL AND source_id != ''
                 GROUP BY source, source_id
                 HAVING COUNT(*) > 1
               )`,
  },
  {
    name: 'resolution-method-well-formed-malformed',
    description:
      "state='resolved' rows have 'category:detail' resolution_method (stale state has its own legacy 'stale' value and is excluded)",
    countSql: `SELECT COUNT(*) AS n FROM tracked_items
               WHERE state='resolved'
                 AND (resolution_method IS NULL OR resolution_method = '' OR instr(resolution_method, ':') = 0)`,
  },
];

/**
 * Cross-table invariant: no unresolved tracked_item may share a thread
 * with a muted_threads row. If a thread is muted, every tracked_item on
 * that thread must already be terminal (`state='resolved'`). A non-
 * resolved row in a muted thread means either the mute-filter path
 * skipped a cascade, or a race let a row land after the mute — both are
 * bugs the mini-app mute feature must prevent.
 *
 * Returns the list of violating rows so the QA report can surface `id`
 * and `thread_id` directly, not just a count. The existing state-machine
 * predicates use a count-only SQL shape because they surface as "N rows
 * violate …"; this one benefits from row-level detail because the fix
 * usually requires looking at which thread leaked.
 */
export function mutedThreadsNeverVisible(
  db: Database.Database,
): { ok: boolean; violations: Array<{ id: string; thread_id: string }> } {
  const rows = db
    .prepare(
      `SELECT ti.id, ti.thread_id
         FROM tracked_items ti
         JOIN muted_threads m ON m.thread_id = ti.thread_id
        WHERE ti.state != 'resolved'`,
    )
    .all() as Array<{ id: string; thread_id: string }>;
  return { ok: rows.length === 0, violations: rows };
}

/**
 * Resolution-method category allowlist. Any category not in this set
 * fails the well-formed check even if the string has a colon.
 */
export const RESOLUTION_METHOD_PREFIXES = [
  'manual', // manual:button, manual:archive_all, manual:orphan_cleanup, manual:stale_cleanup
  'classifier', // classifier:ignore
  'reconciler', // reconciler:gmail-archived, reconciler:gmail-missing
  'miniapp', // miniapp:bulk_archive
  'gmail', // gmail:external
  'digest', // digest:rollup
  'auto', // auto:gmail_reply, auto:archived, auto:label_changed, auto:rsvp, auto:discord_resolved
  'delegated', // delegated (legacy, treated as category)
] as const;
