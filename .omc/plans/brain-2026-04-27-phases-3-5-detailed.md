# Brain — phases 3–5 detailed implementation plan

**Status:** ready to execute (2026-04-27)
**Author:** Jon + Claude
**Supersedes:** the high-level [`brain-2026-04-27-remaining-work.md`](./brain-2026-04-27-remaining-work.md) phases 3–5 sections (kept for the deferred-frontier framing only).
**Triggered by:** independent critic review of the high-level plan flagged 2 BLOCKERs, 4 HIGH, 4 MED, and 1 ambiguity that required pinning before code.

## Decisions resolved upfront

These were ambiguous in the prior plan and are now pinned:

| #   | Question                                       | Decision                                                                                                                                                                                                   | Rationale                                                                                                                                                          |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `wiki/` location — per-group or install-wide?  | **Install-wide:** `store/wiki/` alongside `store/brain.db`.                                                                                                                                                | The brain is a single SQLite + Qdrant install. Per-group would duplicate pages. Move it to `groups/<main>/wiki/` later only if the user actively browses it.       |
| D2  | File-tracked or DB-tracked?                    | **Files** (Markdown). Mirrored in git via `.gitignore` exclusion.                                                                                                                                          | Karpathy pattern + Obsidian browsability + the original ask. `wiki_pages` table was considered and rejected — losing the human-readable surface defeats the point. |
| D3  | Where does `last_synthesis_at` live?           | **Real column** on `entities`, added via `applyColumnMigrations`.                                                                                                                                          | Wikilint's class-4 finder needs an indexable predicate; `json_extract` on the `canonical` blob would be unindexable.                                               |
| D4  | How is `ku_count` change detected?             | **`ku_count_at_last_synthesis INTEGER` column** on `entities`.                                                                                                                                             | Same reason as D3. Live count comes from `COUNT(*) FROM ku_entities WHERE entity_id = ?`.                                                                          |
| D5  | Wiki dir in git?                               | **`.gitignore`d.** Regenerable from `brain.db`.                                                                                                                                                            | Avoids commit noise on every email ingest. Backups already cover `brain.db`.                                                                                       |
| D6  | Atomic writes?                                 | **`.tmp` + rename** for every page write.                                                                                                                                                                  | Obsidian / VS Code file watchers can read mid-write.                                                                                                               |
| D7  | Coalescing primitive                           | **New `CoalescingQueue<K>` in `src/brain/queue.ts`** — per-key debounce, last-write-wins. Distinct from existing `AsyncWriteQueue` (batch-flush).                                                          | Critic correctly flagged that "coalesce" requires key-based dedup, not batch-flush.                                                                                |
| D8  | Phase 5 readiness gate                         | **20+ accumulated brain-reflection rules manually reviewed** — not "4 weeks".                                                                                                                              | Statistical sanity per critic. Calendar-based gates are coin flips at this emission rate.                                                                          |
| D9  | Wiki summary LLM                               | **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`), max 256 output tokens.                                                                                                                                 | Same model as `extract.ts` and `procedural-reflect.ts` — keeps the cost-log "anthropic/extract" bucket coherent.                                                   |
| D10 | Phase split                                    | **Phase 3 splits into 3a (projection + tests) and 3b (triggers + wiring + slash command)**.                                                                                                                | Critic estimate of 5–7 days realistic. Splitting lets 3a land + get reviewed before the integration risk in 3b.                                                    |
| D11 | Per-install wiki value if Phase 5 doesn't ship | **Phase 3 stands alone:** human-readable surface for ad-hoc review (browse in Obsidian when you ask "what do I know about Acme"). Phase 5 makes it agent-readable too, but isn't a prerequisite for value. | Skeptic finding correctly identified the dependency. v1 ships the surface; v2 (Phase 5) unlocks the agent grounding.                                               |

---

## Phase 3a — wiki projection (pure render + LLM summary)

**Effort:** 2–3 days. **Base branch:** main (or current top of stack if #29/#31 unmerged). **PR title:** `feat(brain): wiki projection layer (pure render + summary cache)`

### 3a.1 — Schema migration on `entities`

**File:** `src/brain/db.ts:applyColumnMigrations`

Add three idempotent ALTERs + one index:

```sql
ALTER TABLE entities ADD COLUMN last_synthesis_at TEXT;
ALTER TABLE entities ADD COLUMN ku_count_at_last_synthesis INTEGER;
ALTER TABLE entities ADD COLUMN wiki_summary TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_synthesis_stale
  ON entities(last_synthesis_at)
  WHERE last_synthesis_at IS NOT NULL;
```

`wiki_summary` holds the cached LLM blockquote (NULL = never synthesized). Inline column rather than `canonical` JSON for consistency with D3.

**Test:** extend `src/brain/__tests__/schema.test.ts` — assert columns exist, assert ALTER is idempotent (call `applyColumnMigrations` twice, no error).

### 3a.2 — Pure render module

**New file:** `src/brain/wiki-projection.ts`

```ts
export interface RenderInput {
  entityId: string;
  db: Database.Database;
  /** Override clock for golden-file tests. */
  nowIso?: string;
}

export interface RenderedPage {
  /** Slug-style entity_type, used for the directory. */
  entityType: 'person' | 'company' | 'project' | 'product' | 'topic';
  /** Markdown body — frontmatter + sections. */
  markdown: string;
  /** Live ku_count at render time, used by 3a.3 to decide cache invalidation. */
  liveKuCount: number;
}

export function renderEntityPage(input: RenderInput): RenderedPage;
```

Reads — exact SQL pinned to avoid scope creep:

- `SELECT * FROM entities WHERE entity_id = ?` → frontmatter + title
- `SELECT * FROM entity_aliases WHERE entity_id = ? AND valid_until IS NULL ORDER BY confidence DESC` → "## Aliases"
- `SELECT er.relationship, e2.entity_id, e2.canonical FROM entity_relationships er JOIN entities e2 ON e2.entity_id = er.to_entity_id WHERE er.from_entity_id = ? AND er.valid_until IS NULL` → "## Relationships"
- `SELECT ku.* FROM knowledge_units ku JOIN ku_entities ke ON ke.ku_id = ku.id WHERE ke.entity_id = ? AND ku.superseded_at IS NULL ORDER BY ku.topic_key, ku.valid_from DESC` → "## Facts" grouped by `topic_key`
- `SELECT q.query_text, q.recorded_at FROM ku_queries q JOIN ku_retrievals r ON r.query_id = q.id JOIN ku_entities ke ON ke.ku_id = r.ku_id WHERE ke.entity_id = ? AND q.recorded_at > datetime('now', '-30 days') ORDER BY q.recorded_at DESC LIMIT 10` → "## Recent activity"

The `wiki_summary` column (loaded from the entity row) is rendered as the blockquote at the top — **3a.2 doesn't write it, only reads.** Empty cache → empty blockquote.

**Tests** (~7) in `src/brain/__tests__/wiki-projection.test.ts`:

1. Person entity with full data → golden-file match
2. Company entity → golden-file match
3. Topic entity (no aliases or relationships) → minimal page
4. Entity with one KU → "## Facts" still renders correctly
5. Entity with `wiki_summary` set → blockquote present
6. Entity with `wiki_summary` NULL → blockquote absent (not "null")
7. KU set with mixed superseded — only un-superseded surface

### 3a.3 — LLM summary writer + cache

**Same file:** `src/brain/wiki-projection.ts` adds:

```ts
export interface SynthesisInput {
  entityId: string;
  db: Database.Database;
  llm?: SummaryLlmCaller; // injectable like procedural-reflect.ts
  nowIso?: string;
}

export type SummaryLlmCaller = (
  prompt: string,
) => Promise<{ summary: string; inputTokens: number; outputTokens: number }>;

/**
 * Returns 'synthesized' if the cache was refreshed (and writes the new
 * summary + ku_count_at_last_synthesis + last_synthesis_at to entities),
 * 'reused' if the cache was still valid, 'skipped' if the entity has no
 * KUs.
 */
export async function synthesizeEntitySummary(
  input: SynthesisInput,
): Promise<'synthesized' | 'reused' | 'skipped'>;
```

Cache invalidation rule:

```
needsRegen =
  e.last_synthesis_at IS NULL
  OR (now - e.last_synthesis_at) > 7 days
  OR abs(liveKuCount - e.ku_count_at_last_synthesis) / max(1, e.ku_count_at_last_synthesis) > 0.20
```

LLM caller:

- Same `@ai-sdk/anthropic` plumbing as `procedural-reflect.ts:defaultReflectionLlmCaller`. Pinned to **`claude-haiku-4-5-20251001`** with `maxOutputTokens: 256` (D9).
- Prompt: pass entity name + canonical + the deduped KU text list (cap input at 32 KUs by recency to bound prompt size). Output: 2–4 plain sentences, no JSON, no markdown headers.
- Logs cost via existing `cost_log` insert (operation='extract', units=tokens). Same daily-budget gate as `extract.ts:getDailyLlmBudgetUsd` — **explicitly check the gate** to fail-closed if today's budget is blown.

**Tests** (~5) in same test file:

1. First call → 'synthesized', writes all three cache columns
2. Second call within 7 days, ku_count unchanged → 'reused', no LLM call (assert mock not called)
3. ku_count drops by 25% → 'synthesized' (regen trigger)
4. > 7 days since last synthesis → 'synthesized'
5. Entity with 0 KUs → 'skipped', no LLM call, no DB write

### 3a.4 — Definition of done for 3a

- Typecheck clean
- ~12 new tests, all green
- Independent code-reviewer agent pass with HIGH/MED findings addressed
- No filesystem or scheduler touched in this phase — pure computation
- Stacked PR opened

---

## Phase 3b — wiki materialization + triggers

**Effort:** 2 days. **Base:** Phase 3a. **PR title:** `feat(brain): wiki materializer + on-insert/daily/manual triggers`

### 3b.1 — `CoalescingQueue` primitive

**File:** `src/brain/queue.ts` adds (don't modify existing `AsyncWriteQueue`):

```ts
/**
 * Per-key debouncing queue. Multiple enqueues for the same key within
 * `debounceMs` collapse to a single execution. Distinct from
 * `AsyncWriteQueue<T>` (which is batch-flush, not key-keyed).
 *
 * Use case: wiki regen on KU insert. Email storm with 12 KUs for one
 * entity → 1 wiki rebuild, not 12.
 */
export class CoalescingQueue<K> {
  constructor(opts: {
    debounceMs: number;
    handler: (key: K) => Promise<void>;
    onError?: (err: unknown, key: K) => void;
  });
  enqueue(key: K): void;
  /** Flush all pending keys immediately. Resolves when all handlers settle. */
  flushAll(): Promise<void>;
  shutdown(): Promise<void>;
}
```

Implementation: `Map<K, NodeJS.Timeout>`. On `enqueue`, clear any existing timer for that key, set a new one for `debounceMs`. On fire, delete from map and run handler (catch + report errors via `onError`). `flushAll` triggers all timers immediately.

**Tests** (~5) in `src/brain/__tests__/queue-coalescing.test.ts`:

1. 3 enqueues of same key inside debounce → handler called once
2. 3 enqueues of different keys → handler called 3 times
3. handler throws → onError fires, queue stays alive
4. flushAll runs all pending immediately
5. shutdown after enqueue → flushes pending then resolves

### 3b.2 — Filesystem materializer

**New file:** `src/brain/wiki-writer.ts`

```ts
export interface MaterializeResult {
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  path: string;
  bytes?: number;
  err?: string;
}

export async function materializeEntity(
  entityId: string,
  baseDir: string,
  opts?: { synthesize?: boolean; llm?: SummaryLlmCaller },
): Promise<MaterializeResult>;

export async function materializeAll(
  baseDir: string,
  opts: { since?: string; synthesize?: boolean; llm?: SummaryLlmCaller },
): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  failures: MaterializeResult[];
}>;

/** Rebuild wiki/index.md from the entity table — TOC + cached summaries. */
export async function rebuildIndex(baseDir: string): Promise<void>;

/** Append one line to wiki/log.md. Truncates if file > 1MB. */
export async function appendLog(baseDir: string, line: string): Promise<void>;
```

Key behaviors:

- **Atomic write** (D6): write to `${path}.tmp.${pid}.${rand}`, fsync, rename to final path. If anything throws, unlink the .tmp file.
- **Diff detection**: compare new render to existing file content (string equality). Skip write if unchanged → returns 'unchanged'.
- **Path layout** (D1): `${baseDir}/wiki/{Person|Company|Project|Product|Topic}/${entityId}.md`. Create dirs as needed.
- **Failure isolation in `materializeAll`**: per-entity try/catch; one failure doesn't stop the pass. Result includes per-entity status.
- **`rebuildIndex`**: query `SELECT entity_id, entity_type, canonical, wiki_summary FROM entities ORDER BY entity_type, canonical->>'$.name'`. Group by type, render link + 1-line summary per entry. Atomic-write the result.
- **`appendLog`**: rotation per D9 — if `wiki/log.md` exceeds 1MB, rename to `log.md.archived-<date>` before appending. (No multi-archive cleanup in v1.)

**Tests** (~8) in `src/brain/__tests__/wiki-writer.test.ts` with `tmpDir` fixture:

1. First materialize → 'created', file exists, content matches render
2. Re-materialize same entity, no DB change → 'unchanged', no write
3. KU change → 'updated', file rewritten
4. Atomic write: simulate crash during write (mock fs.rename to throw), .tmp file cleaned up
5. Concurrent materialize of same entity → both complete (last write wins, content equal)
6. `materializeAll` with one entity failing → other entities still materialized, failure logged
7. `rebuildIndex` → file exists, contains TOC entries grouped by type
8. `appendLog` rotation: pre-fill log.md to >1MB, next append rotates

### 3b.3 — Trigger paths

**Three independent wiring points:**

#### Trigger A — On KU insert

**File:** `src/brain/ingest.ts:processRawEvent`

After the existing `markProcessed(db, ...)` call (line 132), enqueue affected entity IDs into a singleton `CoalescingQueue<string>` with **5-minute debounce, off the hot path**.

The queue's handler calls `materializeEntity(id, WIKI_BASE_DIR, { synthesize: false })` — note `synthesize: false`. **The on-insert path NEVER calls the LLM.** Summary regen happens only on the daily pass (Trigger B). This bounds tail latency on email ingest to filesystem write speed.

To find affected entities: between `runExtractionPipeline` and `markProcessed`, capture the `kuRows.map(r => r.entities)` set. Pass it through to a new helper `enqueueWikiRebuilds(entityIds: string[])`.

The ingest pipeline does NOT block on the queue handler. Failures in materialization log a warn and are dropped (the next KU insert for that entity rebuilds anyway).

**Test** in `src/brain/__tests__/ingest-pipeline.test.ts`: process a synthetic email with 2 entities, await `coalescingQueue.flushAll()`, verify 2 markdown files exist on disk (under tmpDir).

#### Trigger B — Daily pass (LLM-synthesizing)

**File:** `src/brain/wiki-projection.ts` exports `startWikiSynthesisSchedule(opts)`. Same pattern as `procedural-reflect.ts:startReflectionSchedule`:

- Hourly tick
- Window: every day 09:00–11:59 local
- 22h debounce stamped in `system_state.last_wiki_synthesis` on success
- In-process `running` flag for re-entrancy
- 5-min timeout for the full pass
- Calls `materializeAll(baseDir, { since: stamp_of_last_run, synthesize: true, llm: defaultSummaryLlmCaller })` — `synthesize: true` enables the per-entity cache check + LLM call when stale
- Writes one log.md line + reports `{created, updated, unchanged, failed}` counts to the digest via system_state

**Test:** unit-test the scheduler tick logic with mocked clock + injected llm. ~3 tests.

#### Trigger C — `/wiki <entity>` slash command

**File:** `src/brain/wiki-command.ts` (new), wired in `src/index.ts` next to `/recall`.

```ts
export async function handleWikiCommand(
  rawArgs: string,
  opts: {
    db?: Database.Database;
    llm?: SummaryLlmCaller;
    baseDir?: string;
  },
): Promise<string>;
```

Behavior:

- Resolves entity by id prefix (8 chars) or name (LIKE on `entities.canonical->>'$.name'`).
- On match: calls `materializeEntity(id, baseDir, { synthesize: true })`, then reads the file and replies with the first 4KB plus path to full file. Ambiguous match → reply with candidates list.
- No match → "No entity found matching `<query>`. Try `/recall` for free-text search."
- LLM failure during synthesis → still materializes deterministic content + warning line in reply.

**Tests** (~5) in `src/brain/__tests__/wiki-command.test.ts` — usage text, no match, ambiguous match, single match with synthesis, single match with synthesis-failed degraded path.

### 3b.4 — Wiring + smoke

**Files modified:**

- `src/index.ts` — singleton `CoalescingQueue`, wire `enqueueWikiRebuilds` in ingest path, wire `startWikiSynthesisSchedule()` next to digest, wire `/wiki` command intercept.
- `src/brain/weekly-digest.ts` — add one line "📚 Wiki: N created, M updated this period" pulled from `system_state.last_wiki_pass_counts` JSON.
- `.gitignore` — add `store/wiki/` (D5).
- `scripts/wiki-materialize.ts` — new ad-hoc CLI for full rebuild. Same pattern as `scripts/brain-weekly-digest.ts`.

**Manual smoke:**

1. `npx tsx scripts/wiki-materialize.ts` → eyeball one Person, one Company, one Topic page
2. Send `/wiki <known-entity>` in Telegram → reply with content
3. Trigger an email ingest → wait 5 minutes → verify wiki page updated

**Definition of done:**

- Typecheck + brain test suite green
- Independent code-reviewer pass with HIGH/MED addressed
- ~21 new tests across 3a + 3b (12 + 9)
- Three real entity pages on disk, visually inspected
- `/wiki` returns sensible output for one known entity
- One email ingest produces a wiki update on disk within 5 minutes
- Stacked PR opened

---

## Phase 4 — `/wikilint` command

**Effort:** 1.5 days. **Base:** Phase 3b. **PR title:** `feat(brain): /wikilint health checker (read-only)`

### 4.1 — Detector module

**New file:** `src/brain/wikilint.ts`

Four pure functions, each `(db) => Finding[]`:

```ts
export type Finding =
  | { kind: 'duplicate_kus'; kuIdA: string; kuIdB: string; cosine: number }
  | {
      kind: 'temporal_contradiction';
      entityId: string;
      kuIdA: string;
      kuIdB: string;
    }
  | {
      kind: 'orphan_entity';
      entityId: string;
      kuCount: number;
      ageDays: number;
    }
  | {
      kind: 'stale_wiki_page';
      entityId: string;
      lastSynthesisAt: string;
      newestKuValidFrom: string;
    };

export function findDuplicateKus(db, opts?: { threshold?: number }): Finding[];
export function findTemporalContradictions(db): Finding[];
export function findOrphanEntities(db): Finding[];
export function findStaleWikiPages(db): Finding[];
export function runAll(db): Finding[];
```

Critical SQL pinned (otherwise the implementer reinvents):

- **Duplicates** (cosine ≥ threshold, default 0.95): for each `(entity_id, topic_key)` pair with ≥2 un-superseded KUs, fetch the KU vectors from Qdrant via existing `searchSemantic` with `{ ku_id IN (…) }` payload filter. Compare pairwise. **Cap candidate pairs at 500 per run** to bound cost — any topic_key with >32 KUs is itself a finding (different class, log warn).
- **Temporal contradictions:** `SELECT a.id, b.id FROM knowledge_units a JOIN knowledge_units b ON a.topic_key = b.topic_key AND a.id < b.id JOIN ku_entities kea ON kea.ku_id = a.id JOIN ku_entities keb ON keb.ku_id = b.id AND kea.entity_id = keb.entity_id WHERE a.superseded_at IS NULL AND b.superseded_at IS NULL AND a.text != b.text AND (a.valid_until IS NULL OR b.valid_from < a.valid_until) AND (b.valid_until IS NULL OR a.valid_from < b.valid_until)`. Class needs a same-text guard to avoid trivial duplicates (those go to class 1).
- **Orphans:** `SELECT e.entity_id, COUNT(ke.ku_id) AS n, julianday('now') - julianday(e.created_at) AS age FROM entities e LEFT JOIN ku_entities ke ON ke.entity_id = e.entity_id GROUP BY e.entity_id HAVING n < 2 AND age > 30`.
- **Stale pages:** `SELECT e.entity_id, e.last_synthesis_at, MAX(ku.valid_from) AS newest FROM entities e JOIN ku_entities ke ON ke.entity_id = e.entity_id JOIN knowledge_units ku ON ku.id = ke.ku_id WHERE e.last_synthesis_at IS NOT NULL AND ku.superseded_at IS NULL GROUP BY e.entity_id HAVING newest > e.last_synthesis_at`. Indexable thanks to `idx_entities_synthesis_stale` from 3a.1.

**Tests** (~7) in `src/brain/__tests__/wikilint.test.ts` — one per class on seeded fixtures, plus one for `runAll`, plus one for cap-at-500 on duplicates.

### 4.2 — Report formatter

**Same file:** `src/brain/wikilint.ts`:

```ts
export function formatWikilintReport(findings: Finding[]): string;
```

Output structure (Markdown):

```
🔎 *Wikilint report* — N findings
---
*Near-duplicate KUs (3):*
  1. ku_<id-a> ≈ ku_<id-b>  (cosine 0.96)
     suggested: `/brain merge <id-a> <id-b>` or dismiss
  …
```

**Tests** (~3): empty findings → "no issues", mixed → all sections present, snapshot.

### 4.3 — Slash command + cron

**File:** `src/brain/wikilint-command.ts` (new), wired in `src/index.ts`. Trivially calls `runAll → formatWikilintReport`.

**Cron:** add to the same daily/weekly cadence as the digest, deliver as separate "wikilint" message. Reuse the digest scheduler hook — don't add a new `setInterval`. Concretely, in `startDigestSchedule`'s callback (in `src/index.ts`), after delivering the digest markdown, check if it's been >7 days since `system_state.last_wikilint` and if so, deliver the wikilint report too. Stamp on success.

**Definition of done:**

- Typecheck + tests green
- ~10 new tests
- Independent code-reviewer pass clean
- Manual `/wikilint` on real `brain.db` produces a non-empty report — eyeball
- Stacked PR opened

---

## Phase 5 — brain-reflection → live prompt injection

**Effort:** 0.5 day code + manual review of accumulated rules. **Base:** main. **Gate:** D8 — wait until `learned_rules WHERE subsource='brain_reflection' AND superseded_at IS NULL` returns ≥20 rules manually marked as good.

### 5.0 — Manual review (NOT a code step)

Before opening the PR:

1. Run `SELECT id, rule, action_classes, confidence, created_at FROM learned_rules WHERE subsource = 'brain_reflection' AND superseded_at IS NULL ORDER BY created_at`
2. Eyeball each rule. For false positives (vague, contradictory, or "be helpful"-style), `markSuperseded(id)` manually.
3. After review, count remaining active brain-reflection rules. If <15: don't ship Phase 5 — tune the reflection prompt instead and wait another month.
4. If ≥15 good rules: proceed.

### 5.1 — `queryRules` agent-wide UNION + injection flag

**File:** `src/learning/rules-engine.ts:queryRules`

Critic flagged this — current `queryRules` filters `(group_id = ? OR group_id IS NULL)` BUT also excludes `subsource = 'brain_reflection'` (that exclusion was added in #31 specifically to keep brain-reflection rules out of prompts during the v1 observation window). To enable injection:

1. Add an env-flag check via a new helper `isBrainReflectionInjectionEnabled()` reading `BRAIN_REFLECTION_INJECTION_ENABLED`.
2. Modify `queryRules` to drop the `subsource <> 'brain_reflection'` clause **only when the flag is true**.
3. The existing `superseded_at IS NULL` and `last_matched_at >= cutoff OR created_at >= cutoff` clauses already do the right thing for brain-reflection rules.

Concrete diff:

```ts
const baseFilter = isBrainReflectionInjectionEnabled()
  ? 'superseded_at IS NULL'
  : "superseded_at IS NULL AND (subsource IS NULL OR subsource <> 'brain_reflection')";
```

**Tests** (~3) in `src/learning/__tests__/rules-engine-integration.test.ts`:

1. Flag off → brain-reflection rule does NOT appear in `queryRules` (regression guard)
2. Flag on → brain-reflection rule WITH `groupId=null` DOES appear in `queryRules('email.draft', 'group-1')`
3. Flag on, brain-reflection rule with overlapping subsource gets matched alongside a group-scoped `user_feedback` rule

### 5.2 — Verification test for decay-respects-subsource

Already covered structurally in `rules-engine-integration.test.ts` (decayConfidence skips superseded rules). Add **one** integration test: insert a brain-reflection rule with `last_matched_at` set 35 days in the past via a direct UPDATE, run `decayConfidence()`, confirm its confidence dropped by 0.1. ~10 LOC.

### 5.3 — Documentation update

**File:** `.omc/design/brain-wiki-and-frontier-v1.md` — add a note under "Brain reflection" section recording the promotion decision: date, count of active rules at time of promotion, link to the Phase 5 PR.

**Definition of done:**

- Manual rule review completed and documented in the PR description (rules count + sample of accepted/rejected examples)
- ~4 new test cases, all green
- Independent code-reviewer pass clean
- Env flag set to `true` in the launchd plist (or the `.env` for local dev)
- Design doc updated
- Stacked PR opened

---

## Cross-phase concerns (addresses critic findings)

### Stacking

- Phase 3a base: top of stack at start (currently `claude/brain-procedural-memory`, will rebase to `main` if #29 + #31 merge first).
- Phase 3b base: Phase 3a's branch.
- Phase 4 base: Phase 3b's branch (Phase 4.1 class 4 needs `last_synthesis_at` from 3a).
- Phase 5 base: `main` (no dependency on 3 or 4 — pure rules-engine change).

### Code review discipline

Every phase ends with a `code-reviewer` agent pass. Specifically scrutinize:

- Phase 3a: cache invalidation correctness, LLM cost gating
- Phase 3b: filesystem race, atomic-write correctness, hot-path latency on ingest
- Phase 4: SQL correctness on the four detectors, especially temporal-contradiction joins
- Phase 5: `queryRules` regression — the v1 exclusion was deliberate, must not break the digest-only contract

### Test strategy

- Each phase's PR includes ≥1 integration test (real SQLite, real filesystem) on top of unit tests with mocks.
- For Phase 3b, the integration test must include the `CoalescingQueue` actually firing — tests using `vi.useFakeTimers()` to advance clock.

### Cost ceiling

- Phase 3a: wiki summary regen capped at ~50 entities/week × 256 output tokens × Haiku 4.5 = ~$0.05/week, ~$3/year.
- Phase 3b: filesystem only, no LLM cost.
- Phase 4: existing local cosine via Qdrant, no LLM cost.
- Phase 5: no LLM (just changes rule retrieval).

Total LLM increment over current spend: ~$3/year. No new budget gate.

### Failure modes acknowledged (per critic)

- **Atomic writes:** D6 — `.tmp` + rename, fsync.
- **Git noise:** D5 — `.gitignore` `store/wiki/`.
- **Mid-run failure in `materializeAll`:** per-entity try/catch (3b.2), failure list returned, log.md still appended at end of pass.
- **Ingest hot-path latency:** Trigger A is async via `CoalescingQueue` with `synthesize: false`; LLM never on the hot path.
- **Per-group ambiguity:** D1 — install-wide single `store/wiki/`.
- **Statistical sanity of Phase 5 gate:** D8 — count-based, not calendar-based.

### What this plan does NOT cover

- Live multi-user wiki sharing — defer until anyone other than the user reads pages.
- Wiki page versioning / git tracking — wiki dir is `.gitignore`d (D5); regenerable from `brain.db`.
- Phase 6+ deferred frontier patterns (Letta, Graphiti, Granola) — see [`brain-2026-04-27-remaining-work.md`](./brain-2026-04-27-remaining-work.md) §6+ for the unchanged framing.

---

## Estimate roll-up

| Phase             | Effort   | Cumulative   | Calendar                      |
| ----------------- | -------- | ------------ | ----------------------------- |
| 3a                | 2–3 days | 2–3 days     | week 1                        |
| 3b                | 2 days   | 4–5 days     | week 2                        |
| 4                 | 1.5 days | 5.5–6.5 days | week 3                        |
| 5 (code)          | 0.5 day  | 6–7 days     | after ≥4 weeks observation    |
| 5 (manual review) | varies   | —            | concurrent with calendar wait |

**Total active engineering: 6–7 days** (vs 4.5 in the original plan — corrected per critic).
**Calendar to v1-complete: ~6 weeks** (mostly waiting on Phase 5 observation window).

The Phase 5 calendar gate runs in parallel with Phases 3+4. By the time those land and merge, the brain-reflection rule pool has 4–5 weeks of accumulation. If the count + quality bar is met, Phase 5 ships immediately after; if not, it slips with a documented reason.
