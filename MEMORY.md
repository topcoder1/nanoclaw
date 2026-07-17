# NanoClaw Memory

Long-lived operational notes for agents working in this repo. Lessons below
follow the regression convention: every bullet is pinned by a test in
`tests/regression/` (see `tests/regression/CONVENTIONS.md`).

## Lessons

- 2026-07-01: `recordTrustDecision` must compute the graduation confidence from the same clock read it stores as `last_updated` — re-reading `Date.now()` inside `calculateConfidence` let a ≥1ms scheduler gap on loaded CI runners decay an exact-threshold confidence (4/5 = 0.80 vs 0.8 gate) below the gate, so `trust.graduated` never fired. (`tests/regression/test_trust-graduation-clock-skew.test.ts`)
- 2026-07-01: brain tests that drive the ingest pipeline must `vi.mock('../embed.js')` (and qdrant.js) — an unmocked test cold-loads the real ~140MB transformers model on CI and `stopBrainIngest()`'s queue drain blows the 10s hook timeout; drain via `stopBrainIngest()` instead of sleeping past `maxLatencyMs` (fixed sleeps are the #89 flake class). (`tests/regression/test_brain-tests-mock-embed.test.ts`)
- 2026-07-16: never pass a caller-side `Date.now()` into a fixture that samples its own clock — JS evaluates arguments _before_ the call, so `seedItem({ pushed_at: Date.now() })` sampled `pushed_at` first and `detected_at` second, and a ≥1ms gap landed `pushed_at` 1ms _before_ `detected_at`, tripping `timestamps-monotonic` (~1 in 42k idle; far more on a loaded runner — bare re-runs went green, so it read as "just flaky"). Fixture defaults derive from the earliest stamp on the row; an explicit `detected_at` still wins so counter-examples stay constructible. Same family as the 2026-07-01 trust-graduation bullet: **two clock reads assumed to be one instant**. Loosening the predicate would have been wrong — it is already `>=`-tolerant, and the invariant is real. (`tests/regression/test_invariants-seed-clock-skew.test.ts`)
