# NanoClaw Memory

Long-lived operational notes for agents working in this repo. Lessons below
follow the regression convention: every bullet is pinned by a test in
`tests/regression/` (see `tests/regression/CONVENTIONS.md`).

## Lessons

- 2026-07-01: `recordTrustDecision` must compute the graduation confidence from the same clock read it stores as `last_updated` — re-reading `Date.now()` inside `calculateConfidence` let a ≥1ms scheduler gap on loaded CI runners decay an exact-threshold confidence (4/5 = 0.80 vs 0.8 gate) below the gate, so `trust.graduated` never fired. (`tests/regression/test_trust-graduation-clock-skew.test.ts`)
- 2026-07-01: brain tests that drive the ingest pipeline must `vi.mock('../embed.js')` (and qdrant.js) — an unmocked test cold-loads the real ~140MB transformers model on CI and `stopBrainIngest()`'s queue drain blows the 10s hook timeout; drain via `stopBrainIngest()` instead of sleeping past `maxLatencyMs` (fixed sleeps are the #89 flake class). (`tests/regression/test_brain-tests-mock-embed.test.ts`)
