/**
 * Runtime proof of the state-machine invariants.
 *
 * Companion to scripts/qa/invariants.ts. The live checker runs the same
 * SQL predicates (imported from scripts/qa/invariant-predicates.ts)
 * against the production store; this suite runs them against the test
 * DB after exercising each real mutation API.
 *
 * The claim being proven: "every real code path that mutates a
 * tracked_items row preserves every state-machine invariant." Each test
 * exercises one mutation API end-to-end, then asserts every predicate
 * returns 0. If a future change introduces an UPDATE that forgets to
 * set resolved_at / pushed_at / snoozed_until / etc., the matching
 * predicate trips here before it ever reaches prod.
 *
 * The final test ("predicates actually detect violations") is the
 * counter-example — it inserts a hand-crafted violation via raw SQL and
 * asserts the relevant predicate trips, so we know the predicates
 * aren't trivially always-zero.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import {
  handleArchive,
  handleDismiss,
  handleSnooze,
} from '../triage/queue-actions.js';
import {
  insertTrackedItem,
  transitionItemState,
  type TrackedItem,
} from '../tracked-items.js';
import {
  STATE_MACHINE_INVARIANTS,
  mutedThreadsNeverVisible,
} from '../../scripts/qa/invariant-predicates.js';

function seedItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  const now = Date.now();
  const item: TrackedItem = {
    id: `item-${Math.random().toString(36).slice(2, 10)}`,
    source: 'gmail',
    source_id: `src-${Math.random().toString(36).slice(2, 10)}`,
    group_name: 'main',
    state: 'queued',
    classification: 'push',
    superpilot_label: null,
    trust_tier: null,
    title: 'test',
    summary: null,
    thread_id: 't',
    detected_at: now,
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: { sender: 'x@example.com', account: 'me@gmail.com' },
    confidence: 0.9,
    model_tier: 1,
    action_intent: null,
    facts_extracted: null,
    repo_candidates: null,
    reasons: null,
    ...overrides,
  };
  insertTrackedItem(item);
  return item;
}

/**
 * Run every state-machine predicate against the test DB. Each must
 * return 0. The label is prefixed onto the assertion message so failures
 * name the mutation path that broke the invariant.
 */
function assertAllInvariants(label: string): void {
  const db = getDb();
  for (const inv of STATE_MACHINE_INVARIANTS) {
    const n = (db.prepare(inv.countSql).get() as { n: number }).n;
    expect(
      n,
      `after ${label}: invariant "${inv.name}" predicate returned ${n} (want 0) — ${inv.description}`,
    ).toBe(0);
  }
}

describe('invariants runtime proof — every mutation path preserves every state-machine invariant', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('baseline: empty DB satisfies every predicate', () => {
    assertAllInvariants('empty DB');
  });

  it('baseline: freshly-seeded queued item satisfies every predicate', () => {
    seedItem();
    assertAllInvariants('seeded queued item');
  });

  it('worker push UPDATE (state → pushed, with pushed_at)', () => {
    const item = seedItem({ state: 'queued' });
    // Mirror of src/triage/worker.ts:206.
    getDb()
      .prepare(
        `UPDATE tracked_items SET state = 'pushed', pushed_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(Date.now(), item.id);
    assertAllInvariants('worker push UPDATE');
  });

  it('worker ignore auto-resolve UPDATE (state → resolved, classifier:ignore)', () => {
    const item = seedItem({ state: 'queued' });
    // Mirror of src/triage/worker.ts:145 (the CASE-WHEN shouldAutoResolve path).
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'classifier:ignore',
             resolved_at = ?,
             queue = 'ignore'
         WHERE id = ?`,
      )
      .run(Date.now(), item.id);
    assertAllInvariants('worker ignore auto-resolve');
  });

  it('handleDismiss (state → resolved, manual:button)', () => {
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });
    handleDismiss(item.id);
    assertAllInvariants('handleDismiss');
  });

  it('handleArchive success path (Gmail → local resolve)', async () => {
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });
    const gmailOps = { archiveThread: vi.fn().mockResolvedValue(undefined) };
    const r = await handleArchive(item.id, { gmailOps });
    expect(r.archived).toBe(true);
    assertAllInvariants('handleArchive success');
  });

  it('handleArchive Gmail-failure path (leaves row queued, no local resolve)', async () => {
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });
    const gmailOps = {
      archiveThread: vi.fn().mockRejectedValue(new Error('429')),
    };
    const r = await handleArchive(item.id, { gmailOps });
    expect(r.archived).toBe(false);
    // Critical: failure path must NOT have written resolution_method
    // without resolved_at (or vice versa). If the pairing breaks here,
    // the invariant catches it.
    assertAllInvariants('handleArchive Gmail-failure');
  });

  it('handleSnooze 1h (state → held, snoozed_until set)', () => {
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });
    handleSnooze(item.id, '1h');
    assertAllInvariants('handleSnooze 1h');
  });

  it('handleSnooze tomorrow (state → held, snoozed_until set)', () => {
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });
    handleSnooze(item.id, 'tomorrow');
    assertAllInvariants('handleSnooze tomorrow');
  });

  it('Gmail-reconciler external-archive UPDATE (state → resolved, gmail:external)', () => {
    const item = seedItem({ state: 'queued' });
    // Mirror of src/triage/gmail-reconciler.ts:171.
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'gmail:external',
             resolved_at = ?
         WHERE state IN ('queued','pushed','pending','held') AND id = ?`,
      )
      .run(Date.now(), item.id);
    assertAllInvariants('gmail-reconciler external archive');
  });

  it('archive_all bulk UPDATE (state → resolved, manual:archive_all)', () => {
    seedItem({ id: 'bulk-a', source_id: 'src-bulk-a', state: 'queued' });
    seedItem({ id: 'bulk-b', source_id: 'src-bulk-b', state: 'queued' });
    // Mirror of src/callback-router.ts:678 and src/memory/cost-dashboard.ts:230.
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'manual:archive_all',
             resolved_at = ?
         WHERE state = 'queued'`,
      )
      .run(Date.now());
    assertAllInvariants('archive_all bulk UPDATE');
  });

  it('miniapp bulk-archive UPDATE (state → resolved, miniapp:bulk_archive)', () => {
    const ids = ['mini-a', 'mini-b'];
    ids.forEach((id, i) =>
      seedItem({ id, source_id: `src-${id}-${i}`, state: 'queued' }),
    );
    // Mirror of src/mini-app/server.ts:267.
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'miniapp:bulk_archive',
             resolved_at = ?
         WHERE state = 'queued' AND id IN (?, ?)`,
      )
      .run(Date.now(), ...ids);
    assertAllInvariants('miniapp bulk-archive UPDATE');
  });

  it('transitionItemState to stale (state → stale, resolved_at + resolution_method set)', () => {
    const item = seedItem({ state: 'queued' });
    transitionItemState(item.id, 'queued', 'digested');
    transitionItemState(item.id, 'digested', 'stale', {
      resolved_at: Date.now(),
      resolution_method: 'stale',
    });
    assertAllInvariants('transitionItemState → stale');
  });

  it('full lifecycle: seed → push → archive', async () => {
    const item = seedItem({ state: 'queued' });
    // push
    getDb()
      .prepare(
        `UPDATE tracked_items SET state = 'pushed', pushed_at = ? WHERE id = ?`,
      )
      .run(Date.now(), item.id);
    assertAllInvariants('after push');
    // archive via button
    const gmailOps = { archiveThread: vi.fn().mockResolvedValue(undefined) };
    await handleArchive(item.id, { gmailOps });
    assertAllInvariants('after archive');
  });

  it('multiple inserts with distinct source_ids preserve uniqueness', () => {
    for (let i = 0; i < 10; i++) {
      seedItem({
        id: `multi-${i}`,
        source_id: `src-multi-${i}`,
        state: i % 2 === 0 ? 'queued' : 'pushed',
        pushed_at: i % 2 === 0 ? null : Date.now(),
      });
    }
    assertAllInvariants('10 seeded rows');
  });

  it('INSERT OR IGNORE on duplicate (source, source_id) does not violate uniqueness', () => {
    seedItem({
      id: 'dup-a',
      source: 'gmail',
      source_id: 'shared-sid',
      state: 'queued',
    });
    // Second insert with same (source, source_id) but different id —
    // the UNIQUE INDEX idx_tracked_source causes INSERT OR IGNORE to
    // no-op silently. This is the schema-level proof that
    // source-id-unique-among-active can't be violated by the insert path.
    seedItem({
      id: 'dup-b',
      source: 'gmail',
      source_id: 'shared-sid',
      state: 'queued',
    });
    const rowCount = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM tracked_items`).get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(1); // the second insert was ignored
    assertAllInvariants('after duplicate source_id insert attempt');
  });

  // ── Counter-example: prove the predicates actually detect violations ──
  // Without this, "every predicate returns 0" could be an artifact of
  // the predicates being trivially always-zero (e.g. if I typo'd the
  // SQL). Each case below reaches under the API and writes a hand-
  // crafted violation, then asserts the matching predicate trips.

  it('predicate catches: state=pushed with NULL pushed_at (bypassing worker)', () => {
    seedItem({
      id: 'bad-p',
      source_id: 'src-bad-p',
      state: 'queued',
    });
    // Bypass the mutation API: write state='pushed' without pushed_at.
    getDb()
      .prepare(
        `UPDATE tracked_items SET state = 'pushed', pushed_at = NULL WHERE id = ?`,
      )
      .run('bad-p');
    const inv = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'pushed-state-has-timestamp',
    )!;
    const n = (getDb().prepare(inv.countSql).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('predicate catches: state=stale with NULL resolved_at (terminal without timestamp)', () => {
    // Targets resolved-state-has-timestamp specifically. Chosen so that
    // resolution-fields-paired does NOT also trip (both fields NULL → pair
    // holds). Without this, #3 has no dedicated counter-example and a
    // typo'd predicate could go undetected.
    seedItem({ id: 'bad-s', source_id: 'src-bad-s', state: 'queued' });
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'stale', resolved_at = NULL, resolution_method = NULL
         WHERE id = ?`,
      )
      .run('bad-s');
    const resolvedTs = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'resolved-state-has-timestamp',
    )!;
    expect(
      (getDb().prepare(resolvedTs.countSql).get() as { n: number }).n,
    ).toBe(1);
    // Sanity: resolution-fields-paired must NOT trip (both NULL is paired).
    const paired = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'resolution-fields-paired',
    )!;
    expect((getDb().prepare(paired.countSql).get() as { n: number }).n).toBe(0);
  });

  it('DB-enforced: CHECK rejects resolved with resolution_method but NULL resolved_at', () => {
    // The `resolution-fields-paired` invariant is now enforced by the
    // `resolution_fields_paired` CHECK constraint on tracked_items. A
    // raw SQL write that breaks the pair can no longer land — SQLite
    // raises SQLITE_CONSTRAINT_CHECK before the row changes. This test
    // proves the enforcement; the predicate in the shared module
    // remains as a belt-and-suspenders audit if the CHECK is ever
    // removed by a future schema change.
    seedItem({ id: 'bad-r', source_id: 'src-bad-r', state: 'queued' });
    expect(() =>
      getDb()
        .prepare(
          `UPDATE tracked_items
           SET state = 'resolved', resolution_method = 'manual:button', resolved_at = NULL
           WHERE id = ?`,
        )
        .run('bad-r'),
    ).toThrow(/CHECK constraint/i);
  });

  it('predicate catches: held with no snoozed_until metadata', () => {
    seedItem({
      id: 'bad-h',
      source_id: 'src-bad-h',
      state: 'pushed',
      pushed_at: Date.now(),
    });
    // Move to 'held' without setting snoozed_until — the buggy pattern.
    getDb()
      .prepare(
        `UPDATE tracked_items SET state = 'held', metadata = '{}' WHERE id = ?`,
      )
      .run('bad-h');
    const inv = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'held-state-has-snooze-until',
    )!;
    const n = (getDb().prepare(inv.countSql).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('predicate catches: resolved_at earlier than detected_at (time reversal)', () => {
    const now = Date.now();
    seedItem({
      id: 'bad-t',
      source_id: 'src-bad-t',
      detected_at: now,
      state: 'queued',
    });
    // Clock skew / bad import: resolved_at before detected_at.
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved', resolution_method = 'manual:button', resolved_at = ?
         WHERE id = ?`,
      )
      .run(now - 10_000, 'bad-t');
    const inv = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'timestamps-monotonic',
    )!;
    const n = (getDb().prepare(inv.countSql).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('predicate catches: resolved with malformed (colonless) resolution_method', () => {
    seedItem({ id: 'bad-m', source_id: 'src-bad-m', state: 'queued' });
    getDb()
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved', resolution_method = 'ohno', resolved_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), 'bad-m');
    const inv = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'resolution-method-well-formed-malformed',
    )!;
    const n = (getDb().prepare(inv.countSql).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  // `no-orphan-ignore-items` was upgraded from predicate-detected to
  // schema-enforced via a CHECK constraint (see src/db.ts). The violation
  // is now *literally impossible to construct* from the app layer, so the
  // counter-example instead proves the constraint rejects the raw SQL
  // that would have been required. Predicate count stays at 0 because the
  // row never lands.
  it('schema rejects: no-orphan-ignore-items (CHECK constraint fires on raw UPDATE)', () => {
    seedItem({ id: 'bad-i', source_id: 'src-bad-i', state: 'queued' });
    expect(() =>
      getDb()
        .prepare(`UPDATE tracked_items SET queue = 'ignore' WHERE id = ?`)
        .run('bad-i'),
    ).toThrow(/CHECK constraint/i);
    const inv = STATE_MACHINE_INVARIANTS.find(
      (i) => i.name === 'no-orphan-ignore-items',
    )!;
    const n = (getDb().prepare(inv.countSql).get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe('muted-threads-never-visible', () => {
  it('muted thread with unresolved tracked_item is flagged', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT
      );
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY, account TEXT NOT NULL, muted_at INTEGER NOT NULL, reason TEXT
      );
      INSERT INTO tracked_items (id, thread_id, state) VALUES ('bad', 'T1', 'pushed');
      INSERT INTO muted_threads (thread_id, account, muted_at) VALUES ('T1', 'x', 1000);
    `);
    const result = mutedThreadsNeverVisible(db);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].id).toBe('bad');
  });

  it('passes when all muted-thread tracked_items are resolved', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT
      );
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY, account TEXT NOT NULL, muted_at INTEGER NOT NULL, reason TEXT
      );
      INSERT INTO tracked_items (id, thread_id, state) VALUES ('ok', 'T1', 'resolved');
      INSERT INTO muted_threads (thread_id, account, muted_at) VALUES ('T1', 'x', 1000);
    `);
    expect(mutedThreadsNeverVisible(db).ok).toBe(true);
  });

  it('passes when no muted threads exist', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (id TEXT PRIMARY KEY, thread_id TEXT, state TEXT);
      CREATE TABLE muted_threads (thread_id TEXT PRIMARY KEY, account TEXT NOT NULL, muted_at INTEGER NOT NULL, reason TEXT);
      INSERT INTO tracked_items (id, thread_id, state) VALUES ('x', 'T1', 'pushed');
    `);
    expect(mutedThreadsNeverVisible(db).ok).toBe(true);
  });
});
