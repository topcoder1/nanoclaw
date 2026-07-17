// Lesson 2026-07-16: the seedItem fixture must derive its default detected_at
// from a clock read that cannot post-date a caller-supplied pushed_at /
// resolved_at. JS evaluates argument expressions BEFORE the call, so
// `seedItem({ state: 'pushed', pushed_at: Date.now() })` sampled pushed_at
// first and detected_at second; a >=1ms scheduler gap on a loaded CI runner
// landed pushed_at 1ms BEFORE detected_at and tripped the
// timestamps-monotonic invariant ("predicate returned 1 (want 0)" at
// invariants-runtime-proof.test.ts:90, run 29550755556, PR #98). Measured
// ~1 in 42k on an idle machine, which is why bare re-runs went green.
//
// Same root-cause family as the 2026-07-01 trust-graduation lesson: two
// Date.now() reads assumed to be the same instant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase, _closeDatabase, getDb } from '../../src/db.js';
import { handleDismiss } from '../../src/triage/queue-actions.js';
import { seedItem } from '../../src/__tests__/helpers/seed-tracked-item.js';
import { STATE_MACHINE_INVARIANTS } from '../../scripts/qa/invariant-predicates.js';

const monotonic = STATE_MACHINE_INVARIANTS.find(
  (i) => i.name === 'timestamps-monotonic',
)!;

function monotonicViolations(): number {
  return (getDb().prepare(monotonic.countSql).get() as { n: number }).n;
}

/**
 * Advance the clock 1ms on every read. Models the scheduler gap a loaded
 * runner can insert between two adjacent Date.now() calls — deterministically,
 * instead of waiting ~42k runs for the real race.
 */
function mockTickingClock() {
  const realNow = Date.now.bind(Date);
  let tick = 0;
  return vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ++tick);
}

describe('seedItem fixture under clock skew', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => {
    vi.restoreAllMocks();
    _closeDatabase();
  });

  it('a pushed row seeded with a caller-sampled pushed_at never inverts detected_at', () => {
    mockTickingClock();

    // Exact call shape from invariants-runtime-proof.test.ts:136 — the
    // caller's Date.now() is evaluated before seedItem's own read.
    const item = seedItem({ state: 'pushed', pushed_at: Date.now() });

    expect(item.pushed_at!).toBeGreaterThanOrEqual(item.detected_at);

    handleDismiss(item.id);
    expect(monotonicViolations()).toBe(0);
  });

  it('an explicit detected_at is still honoured verbatim (counter-examples must stay constructible)', () => {
    // The fix derives only the *default* detected_at. A caller that states
    // detected_at outright still gets it unchanged — otherwise the
    // time-reversal counter-example at invariants-runtime-proof.test.ts:377
    // would be silently repaired and stop proving the predicate works.
    mockTickingClock();

    const pinned = 1_700_000_000_000;
    const item = seedItem({ state: 'queued', detected_at: pinned });

    expect(item.detected_at).toBe(pinned);
  });
});
