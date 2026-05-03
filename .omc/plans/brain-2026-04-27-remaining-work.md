# Brain — remaining work plan (post #29, #31)

**Status:** draft (2026-04-27)
**Author:** Jon + Claude
**Source of truth:** [`.omc/design/brain-wiki-and-frontier-v1.md`](../design/brain-wiki-and-frontier-v1.md). This plan **sequences** that design — it does not redesign.

## Already shipped

- **PR #29** — rich `/recall` source citations + design doc + frontier deep-research synthesis.
- **PR #31** — procedural memory via brain-batch reflection (extends `learned_rules` with subsource + supersession; weekly Haiku reflection; surfaced in digest; v1 digest-only).

## Remaining from design doc — phased

Three more pieces from v1 design + one observation-gated promotion + (separately) the deferred frontier patterns. Ranked by impact-vs-effort and prerequisite dependencies.

| Phase  | Deliverable                                                             | Effort     | Blocks                            | Triggers / readiness                        |
| ------ | ----------------------------------------------------------------------- | ---------- | --------------------------------- | ------------------------------------------- |
| **3**  | Wiki projection layer                                                   | 3–4 days   | —                                 | None — can start now                        |
| **4**  | `/wikilint` command                                                     | 1–1.5 days | Phase 3 (wiki layer must exist)   | After #31 + Phase 3 in main                 |
| **5**  | Brain-reflection → live prompt injection                                | 0.5 day    | #31 in main + 30 days observation | After 4+ weeks of digests with stable rules |
| **6+** | Deferred frontier patterns (Letta tool memory, Graphiti edges, Granola) | varies     | dedicated re-eval triggers        | data signals — not blocked by 3–5           |

---

## Phase 3 — wiki projection layer

The largest piece. Builds the human-readable, compounding "what do I know about X" surface that the Karpathy LLM Wiki pattern (and the TikTok review) called out. **Deterministic projection from KUs + entities, not autonomous LLM CRUD** — explicitly to avoid the auto-CRUD anti-pattern flagged by the deep research.

### Goal

For every active entity in `brain.db`, maintain a Markdown page at `groups/<group>/wiki/{Person|Company|Project|Topic}/{entity_id}.md` that:

1. Renders deterministically from typed rows (KUs + entity_aliases + entity_relationships).
2. Has one bounded LLM-written summary section, regenerated only on a measured-change trigger.
3. Stays in lockstep with `brain.db` via the entity_id as the page slug (no rename churn, no split-brain).

### Sub-steps

#### 3.1 — Schema + projection module skeleton (0.5 day)

- New file `src/brain/wiki-projection.ts`. Export `renderEntityPage(entityId, db) → string` that returns the full Markdown for a single entity. Pure function — no I/O, no LLM. Reads:
  - `entities` row → frontmatter + page title
  - `entity_aliases` → "## Aliases"
  - `entity_relationships` → "## Relationships"
  - `ku_entities` ⨝ `knowledge_units` → "## Facts" grouped by `topic_key`
  - `ku_queries` filtered to recent → "## Recent activity"
- Page format already specced in design doc § "Page schema". Stick to it.
- No persistence, no LLM, no scheduler in this step. Just the deterministic render.

**Tests:** golden-file tests over a fixed in-memory `brain.db` for each entity_type. ~6 tests.

#### 3.2 — LLM-written summary block (0.5 day)

- Add `renderEntitySummary(entityId, db, llm) → Promise<string>` — produces the bounded 4-sentence blockquote at the top of the page.
- Constraints:
  - Cap output tokens at 256.
  - Prompt sees only the KU set for the entity (not raw_events) — bounded input.
  - Cache result in `entities.canonical` JSON (new key: `wiki_summary`, with `synthesis_revision` and `last_synthesis_at`).
  - Regenerate only when (a) `ku_count` for the entity changed by >20% since last synthesis OR (b) it's been >7 days. Otherwise reuse cached.
- LLM caller injectable for tests, mirrors `procedural-reflect.ts` pattern.

**Tests:** mocked LLM, regenerate triggers, cache reuse, summary truncation. ~5 tests.

#### 3.3 — File materialization + diff-aware writing (0.5 day)

- New `src/brain/wiki-writer.ts`. `materializeEntity(entityId, baseDir) → 'created' | 'updated' | 'unchanged'`. Reads existing file (if any), compares to fresh render, writes only on diff.
- `materializeAll(baseDir, opts)` iterates entities (paginated) and calls per-entity. Returns counts.
- `wiki/index.md` regen: rebuilt from scratch every full pass — TOC of all entity pages grouped by type, with one-line summaries from the cached `wiki_summary`.
- `wiki/log.md` append-only — one line per `materializeAll` run with counts (created / updated / unchanged) and timestamp.

**Tests:** filesystem fixture, idempotent re-run = "unchanged", diff detection, log.md append behavior. ~5 tests.

#### 3.4 — Trigger paths (0.5 day)

Three independent trigger paths writing into the same projection module:

1. **On KU insert** (existing `ingest.ts` hook) — coalesce per-entity rebuilds within a 5-minute window via `AsyncWriteQueue`. Don't regenerate the LLM summary on every insert; just re-materialize the deterministic sections.
2. **Daily digest job** — full pass over entities touched in the last 24h. Add a single line to the existing daily/weekly digest report ("📚 Wiki: 12 pages updated, 1 new").
3. **Manual** — new chat command `/wiki <entity-name-or-id>` that materializes one entity and replies with the rendered page (truncated to 4KB) + a path to the full file.

**Tests:** queue coalescing, full-pass run with mixed states, slash command parsing + handler. ~5 tests.

#### 3.5 — Wiring + smoke test (0.25 day)

- Wire the on-insert hook into `ingest.ts`.
- Wire the daily-pass into the existing digest scheduler (separate runner, identical pattern to procedural reflection).
- Wire the `/wiki` command in `src/index.ts`, alongside `/recall`.
- Add a `scripts/wiki-materialize.ts` for ad-hoc full-vault rebuilds.
- Manual smoke: run `npx tsx scripts/wiki-materialize.ts`, eyeball a few generated pages.

**Definition of done:**

- ✅ Typecheck + brain test suite green
- ✅ Independent code-reviewer pass clean (HIGH/MED findings addressed)
- ✅ One real entity rendered to disk and visually inspected
- ✅ `/wiki` command returns sensible output for a known entity
- ✅ Stacked PR opened (base = main if #29/#31 are merged, else stacked)

**Risks:**

- LLM summary drift — mitigated by the regen trigger + bounded prompt.
- Disk pressure on large entity sets — mitigated by per-entity files (not one giant index) + `wiki_summary` cached in DB.
- Race between on-insert coalesce and daily-pass — both writers go through the same `AsyncWriteQueue`; collision is a no-op (last write wins, deterministic content).

---

## Phase 4 — `/wikilint` command

Read-only health checker. **No autonomous CRUD** — surfaces issues as a Markdown report; user runs the actions manually.

### Goal

Surface four classes of issue:

1. **Near-duplicate KUs** — cosine sim ≥ 0.95 in same `topic_key`, same entity, both un-superseded.
2. **Temporal contradictions** — same `(entity, predicate)` with conflicting `text` and overlapping `[valid_from, valid_until]` windows.
3. **Orphan entities** — `entities` row with <2 linked KUs and >30 days old.
4. **Stale wiki pages** — `last_synthesis_at` older than `valid_from` of any newer KU for that entity.

### Sub-steps

#### 4.1 — Detector module (0.5 day)

- New `src/brain/wikilint.ts`. Four pure functions, one per class. Each takes `db` and returns an array of finding objects.
- Cosine sim for class 1 reuses existing Qdrant calls (no new infra).
- Class 4 depends on Phase 3 having shipped (`last_synthesis_at` field exists on entities).

**Tests:** seeded fixtures with one of each class of issue → assert correct findings. ~6 tests.

#### 4.2 — Report formatter (0.25 day)

- `formatWikilintReport(findings) → string` (Markdown). Each finding includes:
  - The defect (with KU/entity ids)
  - Suggested action (merge X into Y / mark X superseded / dismiss)
  - The exact command to run the action manually

**Tests:** snapshot-style tests over fixtures. ~3 tests.

#### 4.3 — Slash command + cron (0.25 day)

- Wire `/wikilint` chat command in `src/index.ts`.
- Optional: add to the existing weekly cadence — fire once a week alongside the digest, deliver as a separate message tagged `wikilint`.
- Reuse `add-karpathy-llm-wiki` skill's lint cron pattern; one less abstraction.

**Definition of done:**

- ✅ Typecheck + tests green
- ✅ Independent code-reviewer pass clean
- ✅ Manual run on real `brain.db` produces a non-empty report — eyeball the findings
- ✅ Stacked PR opened

**Risk:** false-positive rate on near-duplicates. Mitigation: start the threshold at 0.95 cosine; if noisy, raise. Add a "dismissed" log so the same finding doesn't surface week after week.

---

## Phase 5 — Brain-reflection → live prompt injection (gated)

The promotion path the design doc explicitly defers. **Don't ship until 30+ days of stable digests prove the rules are good.**

### Readiness check (manual, not code)

After 4+ weekly digests with `📐 New procedural rules` populated, evaluate:

- Are the rules specific and imperative (not "be helpful")?
- Are they consistent with how you'd want the agent to behave?
- Are supersession decisions matching your judgment?
- False-positive rate < 20%?

If yes → ship Phase 5. If no → tune the prompt in `procedural-reflect.ts:buildReflectionPrompt`, or raise the confidence floor for emission.

### Sub-steps (if greenlit)

#### 5.1 — Inject into agent system prompt (0.25 day)

- Modify `src/learning/outcome-enricher.ts:buildRulesBlock` to optionally include brain-reflection rules.
- Gated by an env flag `BRAIN_REFLECTION_INJECTION_ENABLED=true` for staged rollout.
- Default off until the readiness check above is met.
- Re-revise the design doc to record the promotion decision and date.

#### 5.2 — Confidence-weighted decay (0.25 day)

- The existing `decayConfidence` cron now matters for brain-reflection rules in production.
- Add an integration test verifying that a brain-reflection rule with no matches in 30 days decays toward prune threshold.

**Definition of done:**

- ✅ Live in production behind the env flag
- ✅ One golden-set retrieval test that verifies a brain-reflection rule influences agent behavior
- ✅ Design doc updated with the promotion note + measurement window

---

## Phase 6+ — deferred frontier patterns

Pinned in the design doc with explicit re-eval triggers. **Don't pre-build any of these** — they need data justification.

| Pattern                                      | Re-eval trigger                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Letta-style `core_memory_*` tool calls       | When the agent regularly needs to write to brain mid-turn (not just read)                                                                        |
| Zep Graphiti edge-embedded bi-temporal graph | When `/recall` queries regularly need multi-hop temporal reasoning and the golden set shows current `valid_from/until` filtering is insufficient |
| Granola/Limitless ambient capture            | If meeting transcripts become a regular ingest source                                                                                            |

When a trigger fires, write a new design doc (`brain-architecture-v3-...md`), don't extend v1.

---

## Cross-cutting concerns

### Stacking strategy

If #29 + #31 haven't merged when Phase 3 starts:

- Phase 3 base = `claude/brain-procedural-memory` (top of stack)
- Phase 4 base = `claude/brain-wiki-projection`
- When upstream PRs merge, GitHub auto-rebases the children

If #29 + #31 are merged:

- Phase 3 base = `main`, simpler
- Phase 4 base = Phase 3's branch (still stacked because it depends on `last_synthesis_at`)

### Code review discipline

Every phase ends with an independent `code-reviewer` agent pass. Don't self-approve. Findings rated HIGH/MED get fixed before PR opens; LOW get acknowledged in PR description.

### Test strategy

- Unit tests with mocked dependencies for fast feedback (~5–6 per module)
- One integration test per phase exercising the real SQLite + filesystem (catches column-ordering and IPC issues mocks miss)
- No browser-observable changes (all server-side) → no preview verification needed

### Cost ceiling

Total LLM spend across all phases worst case:

- Procedural reflection (already shipped): ~$0.50/yr
- Wiki summaries (Phase 3.2): ~250 tokens × ~50 entities × weekly = ~$0.05/wk × 52 = **~$3/yr**
- Wikilint near-duplicate scoring uses existing local cosine, no LLM cost.

Total brain LLM budget: well under $10/yr above the existing `extract.ts` Haiku budget. No new budget gate needed.

### Observability

Each new module logs to the existing `pino` instance. Each phase adds:

- One line per scheduler tick (info-level)
- One line per emitted artifact (created/updated count)
- Warn on degraded paths (no LLM, no DB, etc.)

No new metrics tables — ride on `system_state` for last-fire timestamps, `cost_log` for LLM spend.

---

## Estimated total

| Phase                            | Effort     | Calendar                                            |
| -------------------------------- | ---------- | --------------------------------------------------- |
| 3 — Wiki projection              | 3–4 days   | 1 week, parallel-able with Phase 5 readiness window |
| 4 — `/wikilint`                  | 1–1.5 days | After Phase 3 merges                                |
| 5 — Live injection (if greenlit) | 0.5 day    | ≥30 days after #31 merges                           |

**Total active engineering: ~5 days. Calendar: ~6 weeks** (mostly waiting on the Phase 5 observation window).

After Phase 5 ships, the brain has a complete v1 surface stack: deterministic retrieval (#29), procedural memory (#31), human-readable wiki (Phase 3), health checking (Phase 4), and learned-behavior injection (Phase 5). At that point, the next iteration is data-driven — re-eval triggers for the deferred frontier patterns fire only when the golden set / cost / multi-hop-failure metrics demand them.
