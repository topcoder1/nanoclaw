/**
 * Shared seeding fixture for the tracked_items invariant suites.
 *
 * Lives outside the *.test.ts glob so vitest treats it as a module, not a
 * suite. Imported by src/__tests__/invariants-runtime-proof.test.ts and by
 * tests/regression/test_invariants-seed-clock-skew.test.ts, so the regression
 * test pins the real fixture rather than a copy of it.
 */
import { insertTrackedItem, type TrackedItem } from '../../tracked-items.js';

export function seedItem(overrides: Partial<TrackedItem> = {}): TrackedItem {
  const now = Date.now();
  // JS evaluates argument expressions before the call, so a caller writing
  // `seedItem({ pushed_at: Date.now() })` sampled that stamp *before* the
  // `now` above. A millisecond tick in between (routine on a loaded CI
  // runner) would seed detected_at 1ms after pushed_at and trip
  // timestamps-monotonic. Derive the default from the earliest stamp on the
  // row instead. An explicit detected_at in `overrides` still wins, so the
  // time-reversal counter-examples stay constructible.
  const detectedAt = Math.min(
    now,
    ...[overrides.pushed_at, overrides.resolved_at].filter(
      (t): t is number => typeof t === 'number',
    ),
  );
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
    detected_at: detectedAt,
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
