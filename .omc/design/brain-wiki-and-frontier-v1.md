# Brain — Wiki Projection Layer & Frontier Pattern Adoption (v1)

**Status:** draft (2026-04-27)
**Author:** Jon + Claude
**Builds on:** [brain-architecture-v2.md](./brain-architecture-v2.md), [second-brain-v1.md](./second-brain-v1.md)
**Trigger:** TikTok review of NextWork's "AI Second Brain" (Karpathy LLM Wiki adaptation) + independent deep research on 2025–2026 PKM frontier.

## TL;DR

Our `src/brain/` is a generation ahead of consumer "second brain" tools on **retrieval** (hybrid FTS5 + Qdrant + RRF + cross-encoder rerank, bitemporal KUs, deterministic entity resolution, eval harness). It is **a generation behind** on:

1. A **human-readable, compounding surface** — the Karpathy-style wiki layer.
2. **Trust signals** at recall time — source citations are minimal.
3. **Procedural memory** — we store facts and events, not behaviors.
4. **Active context paging** — agent can't explicitly tool-call into the brain mid-turn.

This doc captures the consolidation plan, ranks adoptions by impact-vs-effort, and pins down what we're shipping in v1 vs deferring.

## Inputs

### Input A — TikTok / Karpathy LLM Wiki pattern

[@itsnextwork/photo/7632507307204807944](https://www.tiktok.com/@itsnextwork/photo/7632507307204807944) → NextWork's [AI Second Brain with Claude Code & Obsidian](https://learn.nextwork.org/projects/ai-second-brain-claude-obsidian) → Andrej Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Three layers:

| Layer | Role |
|---|---|
| `raw/` | Immutable source captures. LLM reads, never modifies. |
| `wiki/` | LLM-synthesized cross-linked Markdown — the *compiled* knowledge. |
| `CLAUDE.md` schema | Operating manual that constrains the LLM as a "disciplined wiki maintainer". |
| `index.md` + `log.md` | Cheap deterministic context for cold-start sessions. |
| `/ingest`, `/query`, `/lint` | Three operations. |

Karpathy's framing: **knowledge compilation, not retrieval**. Obsidian = IDE, LLM = programmer, wiki = codebase.

We already have an `add-karpathy-llm-wiki` *NanoClaw* skill (instruction-only, per-group). It is a parallel system to `src/brain/`. **They have not been merged.** This doc is the merger.

### Input B — Frontier deep research (2025–2026 PKM)

Top-5 patterns from frontier systems (Letta/MemGPT, Zep Graphiti, Mem0, LangMem, Cognee, A-MEM, Karpathy LLM Wiki, Granola, Reflect, Heptabase, Reor, Khoj, AnythingLLM, RAGFlow), ranked by impact / effort:

| # | Pattern | Source | Impact | Effort | Adopt? |
|---|---|---|---|---|---|
| 1 | Active context paging via tool-calling | Letta/MemGPT | High | Medium | **v2 — design later** |
| 2 | Async knowledge compilation | Karpathy LLM Wiki | High | High | **v1 — wiki projection layer** |
| 3 | Procedural memory (LLM-written rules) | LangMem / A-MEM | Medium | Low | **v1 — `procedural_memory` table** |
| 4 | Bi-temporal graph traversal (edge-embedded) | Zep Graphiti | High | High | **deferred — re-evaluate when entity-relationship queries become a need** |
| 5 | Ephemeral OS-level ingestion | Granola / Limitless | Medium | High | **deferred — covered by Granola separately if/when** |

Anti-patterns to avoid (all confirmed by both research passes):

- ❌ **Split-brain vector/graph** — two stores with drifting IDs. Mitigated for us today since SQLite is the source of truth and Qdrant payloads carry KU IDs verbatim. Don't introduce a parallel graph store.
- ❌ **Bolted-on Q&A AI** — passive chat over a passive DB. Push toward agentic CRUD with HITL.
- ❌ **Infinite-context reliance** — "lost in the middle" + no contradiction resolution. We already do supersession; keep enforcing.
- ❌ **Raw conversation harvesting** — embedding everything poisons the vector space. Our `transactional-filter.ts` + cheap-rules + budget-gated LLM extract is the right shape; resist "just embed everything" requests.

## Decision: what ships in v1

### v1 scope (this design doc)

1. **Source-citation enrichment on `/recall`** *(landing now — see "v1 down payment" below)*
   - For every email hit, render `[<subject> · <date>](<gmail-url>)` instead of bare `_thread:_ <id>`.
   - Trust signal at the lowest cost — pulls subject from `raw_events.payload` (already on disk), reuses the alias-resolver pattern from the mini-app.
2. **Wiki projection layer** *(separate PR — design pinned here)*
   - Per-entity Markdown pages under `groups/<group>/wiki/{Person|Company|Project|Topic}/<slug>.md`.
   - **Deterministic projection**, not free-form LLM writing. Body sections rendered from KU rows joined on `ku_entities`. LLM is allowed to write the human-prose summary at the top, capped at 4 sentences and regenerated only when the underlying KU set changes meaningfully (digest-trigger, not on every insert).
   - `wiki/index.md` + `wiki/log.md` auto-maintained from `system_state` + recent `knowledge_units`.
   - Reuses existing entity_id ULIDs as page slugs to keep the wiki and brain.db in lockstep — avoids the Mem0 "split-brain drift" anti-pattern.
3. **`/wikilint` command** *(separate PR — design pinned here)*
   - Surface: duplicate KUs (high text similarity, same entity, overlapping `valid_*`), temporal contradictions (same predicate-object, contradictory facts, overlapping windows), orphan entities (<2 KUs), wiki pages whose backing KU set is empty.
   - Output: report only. No autonomous CRUD. Suggests merges; user confirms.
4. **Brain reflection extending the existing `learned_rules` store** *(separate PR — design pinned here)*
   - **Revised from initial draft.** A standalone `procedural_memory` table in `brain.db` would have been a parallel rule store next to the existing `src/learning/rules-engine.ts` (table `learned_rules` in `messages.db`) — the deep research's #1 anti-pattern (split-brain). Reuse the existing store instead.
   - **Schema migration** (idempotent ALTER on `learned_rules`):
     - `supersedes_id TEXT` — points to the rule this one replaces (NULL = original).
     - `superseded_at TEXT` — when this rule was retired by a newer one (NULL = active).
     - `subsource TEXT` — discriminator within the existing `source` enum. Brain reflections use `source='agent_reported', subsource='brain_reflection'`. Avoids the SQLite CHECK-constraint rewrite that expanding the `source` enum would require.
   - **Population**: a weekly job (`src/brain/procedural-reflect.ts`) reads (a) recent `ku_queries`/`ku_retrievals` from `brain.db` and (b) recent `learned_rules WHERE source='user_feedback'` from `messages.db`. Sends a reflection prompt to Haiku 4.5; emits 0–5 rules via existing `addRule()` with `subsource='brain_reflection'`. Cross-DB read is one-way (brain reads messages.db's rules table; messages.db never reads brain.db).
   - **Supersession**: when emitting a new brain-reflection rule, scan existing `active` brain-reflection rules for textual conflicts (LLM-judge or string heuristic) and stamp the older one's `superseded_at` + the new one's `supersedes_id`.
   - **Surface**: brain weekly digest gains a "📐 New procedural rules" section listing brain-reflection rules created in the window.
   - **No prompt injection in v1.** Existing `learning/index.ts:buildRulesBlock` already handles per-group rule injection; brain-reflection rules can opt into that later by setting `groupId=null` (agent-wide). v1 stays digest-surfaced only — first prove the rules are good.

### Deferred (with re-eval triggers)

| Feature | Trigger to reconsider |
|---|---|
| Letta-style tool-calling memory ops (`core_memory_append`, `archival_memory_search`) | When agent turns regularly need to *write* to brain mid-conversation, not just read. Today the brain ingests from email; the agent reads. |
| Zep Graphiti edge-embedded bi-temporal graph | When `/recall` queries regularly require multi-hop reasoning ("who did I work with before X happened") and current `valid_from/until` filtering is empirically insufficient on the golden set. |
| Granola/Limitless ambient capture | When meeting transcripts become a regular ingest source. Separate Granola integration likely owns this if it happens. |
| Procedural memory → automatic prompt injection at agent turn | After `procedural_memory` table has been observed for 30 days and rules look stable. v1 starts read-only / digest-surfaced. |

## Wiki projection layer — design

### Storage

```
groups/<group>/wiki/
  index.md                         ← TOC, rebuilt on every projection run
  log.md                           ← append-only, one line per projection event
  Person/
    01H...<entity_id>.md           ← ULID slug (= entity_id)
  Company/
  Project/
  Topic/
```

ULID slugs (not human-readable handles) avoid rename churn. Human handles live in the page frontmatter.

### Page schema

```markdown
---
entity_id: 01H...
entity_type: person
canonical: { name: "Alice Smith", email: "alice@…" }
ku_count: 23
last_synthesis_at: 2026-04-27T09:00:00Z
synthesis_revision: 4
---

# Alice Smith

> [LLM-written 4-sentence summary, regenerated when ku_count changes by >20% or it's been >7 days.]

## Facts

- **<topic_key>** — <ku.text>  ([source](gmail-url) · 2026-04-12)
- **<topic_key>** — <ku.text>  ([source](gmail-url) · 2026-04-19)

## Aliases
…

## Relationships
…

## Recent activity
…
```

The `## Facts` section is **deterministically projected from KUs** — same retrieval pipeline as `/recall` but filtered to `ku_entities.entity_id = ?` and grouped by `topic_key`. No LLM in this section. The LLM only writes the summary blockquote, and only on a measured-change trigger.

### Projection trigger

Three triggers fire a per-entity rebuild, queued through `AsyncWriteQueue`:

1. **On KU insert** (existing `ingest.ts` hook) — but only enqueue, don't materially regenerate. Coalesce within a 5-minute window.
2. **Daily digest job** — full pass over entities touched in the last 24h.
3. **Manual** — `/wiki <entity>` slash command.

### Why not just write free-form pages with an LLM

Both research passes flag **autonomous LLM CRUD on personal data** as the highest-risk anti-pattern (silent corruption, hallucinated relationships). Karpathy's gist is honest about this — `/lint` is a periodic human-supervised pass for a reason.

Our move: deterministic projection from typed rows, with the LLM constrained to a single bounded summary section. The wiki becomes a **view** over the KU/entity store, not a divergent fork.

## `/wikilint` command — design

Read-only. Reports four classes of issue:

1. **Near-duplicate KUs** — cosine sim ≥ 0.95 in same `topic_key` for same entity, both un-superseded.
2. **Temporal contradictions** — same `(entity, predicate)` with conflicting `text` and overlapping `[valid_from, valid_until]` windows.
3. **Orphan entities** — `entities` row with <2 linked KUs and >30 days old.
4. **Stale wiki pages** — `last_synthesis_at` older than `valid_from` of any newer KU for that entity.

Output: a Markdown report posted back to the chat. Each finding includes a "merge / mark-as-superseded / ignore" suggestion, but **the user runs the action manually**. v1 does no autonomous CRUD.

Cadence: same scheduler hook as the existing `add-karpathy-llm-wiki` lint cron (weekly default).

## Brain reflection (extending `learned_rules`) — design

### Schema migration

Inline in `src/learning/rules-engine.ts:initRulesStore` (matches the existing `CREATE TABLE IF NOT EXISTS` pattern; idempotent for already-deployed DBs via try-catch ALTER):

```sql
ALTER TABLE learned_rules ADD COLUMN supersedes_id TEXT;
ALTER TABLE learned_rules ADD COLUMN superseded_at TEXT;
ALTER TABLE learned_rules ADD COLUMN subsource TEXT;
CREATE INDEX IF NOT EXISTS idx_learned_rules_active
  ON learned_rules(superseded_at, subsource)
  WHERE superseded_at IS NULL;
```

The CHECK constraint on `source` stays as-is (`outcome_pattern | user_feedback | agent_reported`). Brain reflections use `source='agent_reported'` with `subsource='brain_reflection'`. The agent is in fact reporting these rules — the discriminator distinguishes the brain-batch source from event-driven agent reports.

### Population

`src/brain/procedural-reflect.ts`:

1. **Gather signals** (last 7 days):
   - `ku_queries` rows with `result_count = 0` — knowledge gaps.
   - `ku_retrievals` rows where the same KU was returned to ≥3 distinct queries — recurring concerns.
   - `learned_rules WHERE source='user_feedback' AND created_at >= window_start` — explicit user corrections from chat (already captured by `feedback-capture.ts`).
2. **Reflection prompt** to Haiku 4.5 — same `defaultLlmCaller` pattern as `extract.ts`. Output schema: `{rules: [{rule: string, action_classes: string[], evidence: string[], confidence: number}]}`. Cap at 5 rules per window. Each rule must cite ≥2 evidence items by `ku_queries.id` or `learned_rules.id`.
3. **Emit** via existing `addRule({source: 'agent_reported', subsource: 'brain_reflection', groupId: null, ...})`. `groupId=null` means agent-wide.
4. **Supersession**: before insert, fetch active brain-reflection rules whose `action_classes` overlap. Use Haiku-judge (`isContradictory(oldRule, newRule)`) — if true, stamp old rule with `superseded_at = now()` and new rule with `supersedes_id = old.id`. Cap the judge at 5 candidate pairs to bound cost.

### Surface

Brain weekly digest gains a "📐 New procedural rules" section that lists rules with `subsource='brain_reflection' AND created_at >= window_start`. Includes rule text, action classes, and supersession status (`supersedes <id>` if applicable).

**No automatic system-prompt injection in v1.** The existing `learning/index.ts:buildRulesBlock` already handles per-group injection — brain-reflection rules can opt into that path later, but v1 stays digest-only until the rule quality is observed for 30+ days.

### Why this matters (deep research)

Per LangMem and A-MEM, agents that don't develop procedural memory plateau on user-fit quickly. The brain currently encodes *facts* (semantic) and *events* (episodic via raw_events). The existing `learning/` system encodes *behaviors at the group level* from outcome patterns and direct corrections. The missing piece is **batch reflection over query patterns** — looking across a week of `ku_queries` to spot knowledge gaps and recurring concerns that no single chat turn surfaces. That's the LangMem distinction the deep research called out.

## v1 down payment — `/recall` source citations

The smallest concrete change in the consolidation, shipping with this doc:

- New: `src/brain/citations.ts` — pure helper. `buildGmailDeepLink(email, threadId)` (extracted from `mini-app/brain-routes.ts:1939` to be importable from non-UI code) and `enrichCitation(db, sourceType, sourceRef, resolveAlias)` returning `{ subject, senderEmail, url }`.
- `recall-command.ts`: optionally accept `resolveAlias`; render `[<subject> · <yyyy-mm-dd>](<gmail-url>)` for email hits, fall back to the current bare-ref form when subject/url is unavailable.
- Wired from `src/index.ts:1492` using the existing `gmailOpsRouterRef.current.emailAddressForAlias`.

**Why this first.** The deep research flags hallucinated/uncited recall as the #1 trust killer. The fix is a JOIN on `raw_events` (already indexed) per top-N hit (default 5). No schema change. No backfill. Lands in <1 day.

## Open questions / future re-evaluation

- **Wiki page revision storage.** v1 overwrites in place. If the wiki becomes externally consumed (shared with a team, version-controlled), we need git-tracking the wiki dir (Karpathy's recommendation). Defer until anyone except the user reads these pages.
- **Embedding wiki pages back into Qdrant.** Tempting — would let `/recall` retrieve the synthesized summary as a single hit. Risk: doubles vector-space mass, splits retrieval between facts and summaries, and the summary is LLM-written so re-embedding it amplifies any synthesis errors. Decision: **don't** unless retrieval quality on the golden set demonstrates it's worth it.
- **Procedural rules → live system prompt.** v1 keeps rules in a digest-only surface. Move to active injection only after 30+ days of observed stability and a measurable evaluation framework.

## Sources

- Karpathy, *LLM Wiki* gist — pattern primary source.
- NextWork, *AI Second Brain with Claude Code & Obsidian* — adapted tutorial.
- Frontier deep research report (interaction `v1_Chdqc252YWNEV0hzM2p6N0lQb1B6VHNBcxIXanNudmFjRFdIczNqejdJUG9QelRzQXM`, 2026-04-27) covering Letta, Zep Graphiti, Mem0, LangMem, Cognee, A-MEM, Granola, Reflect, Heptabase, Reor, Khoj, AnythingLLM, RAGFlow, et al.
- [`.claude/skills/add-karpathy-llm-wiki/llm-wiki.md`](../../.claude/skills/add-karpathy-llm-wiki/llm-wiki.md) — existing per-group wiki skill (parallel system; merged into the brain via the projection layer above).
