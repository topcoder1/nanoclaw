# Augmented Brain Architecture — v2 (pragmatic core)

**Status:** Signed off 2026-04-23. P0 in progress.
**Date:** 2026-04-23
**Host:** NanoClaw (`~/dev/nanoclaw`)
**Strategy:** Commit all schema-level decisions now. Defer operational machinery until data justifies it. Ship in 3 weeks, not 9.

### Locked decisions (from sign-off)

1. **Embeddings: local `nomic-embed-text-v1.5` via `@huggingface/transformers`.** Privacy + free re-embedding + no external dependency. Quality gap closed by reranker enabled from day 1 of P1.
2. **Location: `store/brain.db`** (alongside existing `store/messages.db`). Future split → `store/brain/{work,personal}.db`.
3. **Recall UX: free-form `/recall <question>`.** Structured shortcuts layered on later from digest-observed patterns.
4. **Golden set: template-driven (§10), instantiated from migrated data, validated with user in 30-min session at end of P1.**
5. **LLM extraction: Claude Haiku 4.5, ~$0.05/day budget.**
6. **Reranker (`ms-marco-MiniLM-L-6-v2`) enabled from P1 onward, not opt-in later.**

---

## 1. Goals (unchanged from v1)

1. Auto-capture from email, Gong, HubSpot, browser, manual.
2. Auto-research & enrich new signals.
3. Produce deliverables (feature requests, todos, digests).
4. Learn from behavior.
5. Maintain temporal world-model.
6. Hard wall personal vs work — when colleagues onboard. Not yet.

---

## 2. What's in v2 vs. deferred

### In v2 (schema commitments — expensive to retrofit)

- Entity spine with ULIDs and time-bound aliases
- Bitemporal Knowledge Units (`valid_from/until` + `recorded_at/superseded_at`)
- Immutable `raw_events`
- `account` + `scope` columns (even while single-file)
- Model-versioned Qdrant collections
- Hybrid retrieval (FTS5 + Qdrant + RRF; rerank as opt-in)
- Indexes from day 1
- WAL mode + write-serializer
- Migration from existing `knowledge_facts` / `nanoclaw_knowledge`
- Observability and cost tracking

### Deferred (operational — add when data justifies)

| Feature                                               | Trigger to add                                      | Cost to add later |
| ----------------------------------------------------- | --------------------------------------------------- | ----------------- |
| Split to two SQLite files (`personal.db` / `work.db`) | First colleague onboards OR audit requirement       | Weekend, bounded  |
| Splink nightly dedup sidecar                          | Entity count > 10K OR >5% dedup precision miss      | 1 week            |
| Cross-encoder reranker                                | Measured retrieval quality < target on eval harness | 2 days            |
| Tier demotion (hot/warm/cold/forgotten)               | Working set > 100K KUs OR Qdrant RAM pressure       | 1 week            |
| Sleep-time consolidation                              | Retrieval results show material redundancy          | 1 week            |
| OpenFGA RBAC                                          | Second user in work scope                           | 1 week            |
| HyDE fallback                                         | Retrieval confidence < 0.4 on >10% of queries       | 2 days            |
| Local embeddings (`nomic-embed-text-v1.5`)            | Privacy review flags OpenAI exposure                | 2 days            |
| Entity review queue UI                                | Review queue backlog > 50                           | 3 days            |

Every deferred feature gets a **measurable re-evaluation trigger**, not "we'll get to it."

---

## 3. Top-level architecture (v2)

```
Sources: Gmail SSE · (later: Gong · HubSpot · browser · manual)
   │
   ▼  raw_events (immutable, append-only)
┌────────────────────────────────────────────┐
│ Ingestion (write-serializer, batched)      │
│  1. raw_event insert (idempotent)          │
│  2. cheap-rules extraction → KU            │
│  3. LLM extraction if signal > threshold   │
│  4. deterministic entity resolution        │
│  5. embed + index (FTS5 + Qdrant)          │
└────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────┐     ┌───────────────────────┐
│ SQLite: store/brain.db│     │ Qdrant: per-model     │
│ (entities, KUs,       │ ←→ │ collections           │
│  aliases, raw_events) │     │ ku_{model}_{dim}      │
└──────────────────────┘     └───────────────────────┘
   │
   ▼
Retrieval: FTS5 + Qdrant → RRF(k=60) → [rerank if enabled]
           → score = α·rank + β·recency + γ·access
   │
   ▼
Consumers: agents · Telegram /recall · weekly digest
```

**Key simplifications vs. v1:**

- One SQLite file (`store/brain.db`), separate from existing `store/messages.db`.
- `account` and `scope` are columns, not separate files.
- Deterministic entity resolution only; Splink deferred.
- No tier column on write (all KUs start "live"); tier added when demotion lands.
- No consolidation pass; `topic_key` still written for future use.

---

## 4. Migration from existing NanoClaw

Existing state (confirmed via codebase review):

- `store/messages.db` has `knowledge_facts` (FTS5-backed), `tracked_items`, `commitments`, `contact_activity`, `acted_emails`, etc.
- Qdrant collection `nanoclaw_knowledge` exists at 1536d, points have **no** `model_version` in payload.
- `src/memory/knowledge-store.ts:202` hardcodes `COLLECTION_NAME = 'nanoclaw_knowledge'`.
- No WAL mode on `messages.db`.

### Migration plan (runs once, idempotent)

**Phase A — Qdrant model-version backfill (before any schema work):**

1. Update all existing `nanoclaw_knowledge` points to add `model_version: "openai:text-embedding-3-small:1536"` in payload via bulk upsert.
2. Update `knowledge-store.ts` to write `model_version` on every new upsert (2-line fix).
3. Rename collection logically: `nanoclaw_knowledge` → conceptually treated as `ku_openai_text-embedding-3-small_1536`. We keep the physical name for backward compat; new collections created with the new naming scheme.

**Phase B — Introduce `store/brain.db`:**

1. New file, WAL mode, `synchronous=NORMAL` set on open.
2. Create full v2 schema (see §5).
3. `knowledge_facts` → `knowledge_units` migration:
   - For each row in `knowledge_facts`, insert a `knowledge_unit` with:
     - `id`: new ULID
     - `text`: existing text
     - `source_type`: existing source type mapped
     - `valid_from`: existing timestamp
     - `recorded_at`: existing timestamp
     - `account`: 'work' (we'll triage personal/work later via sender heuristics)
     - `confidence`: 1.0
   - Reference back to original: `metadata JSON` includes `legacy_knowledge_fact_id`.
4. Link existing `tracked_items`/`commitments`/`acted_emails` as `raw_events` with source_type `tracked_item` etc., so the ingestion pipeline can re-derive KUs with better extraction later.
5. `messages.db` stays as-is. Brain layer does not touch it.

**Phase C — Cutover:**

1. `knowledge-store.ts` rewired to write to `brain.db` via the new API.
2. Old `knowledge_facts` table kept read-only for 30 days, then deleted.

**Test harness for migration:** before cutover, run migration on a snapshot, query a known set of facts from both old and new paths, diff results. Go/no-go on identical recall.

---

## 5. Schema

All tables in `store/brain.db`.

### 5.1 Entities

```sql
CREATE TABLE entities (
  entity_id    TEXT PRIMARY KEY,       -- ULID
  entity_type  TEXT NOT NULL CHECK (entity_type IN
                 ('person','company','project','product','topic')),
  canonical    TEXT,                   -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_entity_type ON entities(entity_type);

CREATE TABLE entity_aliases (
  alias_id     TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES entities(entity_id),
  source_type  TEXT NOT NULL,
  source_ref   TEXT,
  field_name   TEXT NOT NULL,          -- email|domain|phone|name|slack_id
  field_value  TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_until  TEXT,
  confidence   REAL NOT NULL
);
CREATE INDEX idx_alias_entity      ON entity_aliases(entity_id);
CREATE INDEX idx_alias_field_value ON entity_aliases(field_name, field_value);
CREATE INDEX idx_alias_source      ON entity_aliases(source_type, source_ref);

CREATE TABLE entity_relationships (
  rel_id          TEXT PRIMARY KEY,    -- ULID
  from_entity_id  TEXT NOT NULL REFERENCES entities(entity_id),
  relationship    TEXT NOT NULL,       -- works_at|reports_to|owns|member_of|mentions
  to_entity_id    TEXT NOT NULL REFERENCES entities(entity_id),
  valid_from      TEXT NOT NULL,
  valid_until     TEXT,
  source_type     TEXT,
  confidence      REAL NOT NULL,
  UNIQUE (from_entity_id, relationship, to_entity_id, valid_from)
);
CREATE INDEX idx_rel_from ON entity_relationships(from_entity_id, relationship);
CREATE INDEX idx_rel_to   ON entity_relationships(to_entity_id, relationship);

-- Ever reversal/undo needed for bad merges
CREATE TABLE entity_merge_log (
  merge_id        TEXT PRIMARY KEY,    -- ULID
  kept_entity_id  TEXT NOT NULL,
  merged_entity_id TEXT NOT NULL,
  pre_merge_snapshot TEXT NOT NULL,    -- JSON: full state of merged entity + its aliases
  confidence      REAL NOT NULL,
  evidence        TEXT,                -- JSON
  merged_at       TEXT NOT NULL,
  merged_by       TEXT NOT NULL        -- 'deterministic'|'splink'|'human:<id>'
);
```

### 5.2 Knowledge Units

```sql
CREATE TABLE knowledge_units (
  id                TEXT PRIMARY KEY,  -- ULID
  text              TEXT NOT NULL,
  source_type       TEXT NOT NULL,     -- email|gong|hubspot|browser|manual|attachment|tracked_item
  source_ref        TEXT,
  account           TEXT NOT NULL CHECK (account IN ('personal','work')),
  scope             TEXT,              -- JSON array of tags: ["sales","exec"] — default NULL (unscoped)
  confidence        REAL NOT NULL DEFAULT 1.0,
  valid_from        TEXT NOT NULL,     -- event time
  valid_until       TEXT,
  recorded_at       TEXT NOT NULL,     -- ingestion time — used for recency decay
  superseded_at     TEXT,
  topic_key         TEXT,              -- SHA256 of normalized(subject|title|claim). Defined in §7.
  tags              TEXT,              -- JSON array
  extracted_by      TEXT,
  extraction_chain  TEXT,              -- JSON array of source KU ids
  metadata          TEXT,              -- JSON
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_accessed_at  TEXT,
  needs_review      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ku_account         ON knowledge_units(account, valid_from);
CREATE INDEX idx_ku_source          ON knowledge_units(source_type, source_ref);
CREATE INDEX idx_ku_topic           ON knowledge_units(topic_key) WHERE topic_key IS NOT NULL;
CREATE INDEX idx_ku_superseded      ON knowledge_units(superseded_at) WHERE superseded_at IS NULL;
CREATE INDEX idx_ku_recorded        ON knowledge_units(recorded_at);
CREATE INDEX idx_ku_needs_review    ON knowledge_units(needs_review) WHERE needs_review = 1;

CREATE TABLE ku_entities (
  ku_id      TEXT NOT NULL REFERENCES knowledge_units(id),
  entity_id  TEXT NOT NULL REFERENCES entities(entity_id),
  role       TEXT NOT NULL,            -- subject|object|mentioned|author
  PRIMARY KEY (ku_id, entity_id, role)
);
CREATE INDEX idx_ku_entities_entity ON ku_entities(entity_id);
```

### 5.3 Raw events

```sql
CREATE TABLE raw_events (
  id            TEXT PRIMARY KEY,      -- ULID
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  payload       BLOB NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  process_error TEXT,                  -- last error if processing failed
  retry_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_type, source_ref)
);
CREATE INDEX idx_raw_unprocessed ON raw_events(processed_at) WHERE processed_at IS NULL;
```

### 5.4 System state (observability)

```sql
CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,        -- 'last_qdrant_reconcile', 'last_weekly_digest', etc.
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE cost_log (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,           -- YYYY-MM-DD
  provider    TEXT NOT NULL,           -- openai|anthropic|cohere
  operation   TEXT NOT NULL,           -- embed|extract|rerank
  units       INTEGER NOT NULL,        -- tokens or calls
  cost_usd    REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_cost_day ON cost_log(day, provider);
```

### 5.5 FTS5

```sql
CREATE VIRTUAL TABLE ku_fts USING fts5(
  text,
  content=knowledge_units,
  content_rowid=rowid,
  tokenize='porter unicode61'
);
-- Triggers to keep in sync with knowledge_units (insert/update/delete).
```

---

## 6. Retrieval (single formula, no contradictions)

```
query
  │
  ├─ FTS5          → top 100 (BM25 rank)
  ├─ Qdrant        → top 100 (cosine)
  │                  filter: account, scope, superseded_at IS NULL,
  │                  model_version matches active embedding
  │
  └─ RRF(k=60)     → merged top 50
       │
       └─ [opt] cross-encoder rerank  (off until quality measured)
            │
            └─ final score = 0.7 · rank_score + 0.2 · recency + 0.1 · access
                 rank_score = rerank_score if reranker enabled, else rrf_score
                 recency    = exp(-ln(2) · (now - recorded_at) / 180d)
                 access     = min(log2(1 + access_count) / 5, 1.0)
                 → top 10–20
```

- **Recency uses `recorded_at`**, not `valid_from`. Ingesting an old Gong call should not immediately decay it.
- **Half-life 180d default.** Configurable per query intent ("recent" = 7d, "all-time" = disabled).
- **Single canonical formula.** Previous contradiction (rerank-stage vs RRF-stage recency blend) resolved.

---

## 7. Topic key, scope, extraction rules — defined

### topic_key

```
topic_key = sha256(normalize(topic_seed)) where topic_seed =
  coalesce(extracted_subject, title, first_sentence)
  lowercased, stop-words removed, stemmed, truncated to 128 chars
```

Stable across re-ingestions. Used later for supersession / consolidation.

### scope

JSON array of department tags: `["sales"]`, `["eng","exec"]`. `NULL` = unscoped work. Multi-tag OR: KU is visible to anyone authorized for _any_ tag. Empty array = private-to-owner.

### Extraction rules (cheap tier — runs on every event)

1. Regex patterns for: URLs, emails, phone numbers, dates, money amounts, ticker symbols, HubSpot deal IDs, Gong call IDs.
2. Named entities from existing NanoClaw sender/subject classifiers.
3. If structured signals present (explicit ask, deal mention, named project) → queue LLM tier.

### LLM extraction tier (runs only on signal-positive events)

- Model: Claude Haiku 4.5 for cost. Budget: $0.10/day soft cap.
- Output schema: JSON with `claims[]`, each with `text`, `topic_seed`, `entities_mentioned[]`, `confidence`.
- Confidence gates: `>0.7` → KU stored; `0.4–0.7` → KU stored + `needs_review=1`; `<0.4` → dropped.

---

## 8. Ingestion flow

```
on raw event:
  1. insert into raw_events (idempotent via UNIQUE)
  2. enqueue to write-serializer
  3. cheap-rules extraction; if nothing → mark processed, done
  4. if signal-positive → LLM extraction (budget-gated)
  5. deterministic entity resolution for each extracted entity mention:
       - exact email/domain/ULID match → attach existing entity_id
       - no match → create new entity + alias
  6. embed KU text with active model; upsert to matching Qdrant collection
     with payload {ku_id, account, scope, model_version, valid_from}
  7. FTS5 triggers handle text index
  8. set raw_events.processed_at
  9. emit event on bus for downstream consumers
```

### Failure handling

- Step 6 (Qdrant upsert) fails → KU row written but Qdrant miss. Reconciliation job (§9) fixes.
- Step 4 (LLM) fails → raw_event.process_error set, retry_count++. Retry on next cycle up to 3x; after that, alert.
- Step 2 queue full → backpressure on SSE handler via existing IPC trigger path.

---

## 9. Observability, reliability, cost

### Metrics (written to `system_state` + `cost_log`)

- Ingestion rate (events/hour), processing lag, error rate.
- Qdrant ↔ SQLite consistency: nightly job compares KU count; alerts on drift.
- Embedding cost per day, per source.
- Retrieval latency p50/p95/p99 (in-memory ring buffer, flushed to log).
- Entity count, alias count, unresolved-candidate count.

### Health

- Embedding provider reachability probe every 5min (write to `system_state`).
- Weekly digest includes: cost YTD, ingestion volume, top-retrieved KUs, new entities, any drift alerts.
- On any critical alert (provider down > 15min, cost spike > 2x rolling avg, consistency drift > 1%): Telegram ping to user.

### Backup / recovery

- `brain.db` backed up nightly via `.backup()` API to `store/backups/brain-YYYY-MM-DD.db`. Keep 30 days.
- Qdrant snapshot nightly via API to `store/qdrant-snapshots/`. Keep 14 days.
- **Recovery contract:** if Qdrant is lost, re-embed from `brain.db` (all text retained). If `brain.db` is lost, re-derive from `raw_events` table AND existing `store/messages.db`. Document this as the re-derivation procedure — tested quarterly.

### Cost model (rough)

At ~100 events/day, 20% signal-positive:

- Embeddings: ~100 × $0.00002 × avg 200 tokens = **$0.0004/day** (negligible)
- LLM extraction (Haiku 4.5, 20 calls × 2K tokens): ~**$0.05/day**
- Rerank (local, free when enabled)
- **Budget: $3/month. Alert if > $10/month.**

---

## 10. Evaluation harness

Without measurement, tuning is guesswork. Before P0 ships:

1. Build a **golden query set** (25 queries with expected KU ids) covering: recent recall, historical recall, entity lookup, multi-hop ("who worked on X at company Y").
2. Tests run on every PR touching retrieval. Report: precision@10, recall@10, MRR.
3. Monthly: user validates 10 random retrievals, feedback logged as `needs_review` or `irrelevant`.
4. All deferred features (rerank, HyDE, consolidation) gated on **measurable improvement** on the golden set.

---

## 11. Stack (final)

| Layer            | Choice                                                                                            | Note                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| SQLite           | `better-sqlite3`                                                                                  | WAL mode, `synchronous=NORMAL`                            |
| Query builder    | **Raw SQL** (matches existing NanoClaw style)                                                     | Kysely can come later                                     |
| Vector           | Qdrant + `@qdrant/js-client-rest`                                                                 | Current version 1.14.0                                    |
| Embeddings       | **Local: `nomic-embed-text-v1.5` via `@huggingface/transformers`** (768d, Matryoshka-truncatable) | ONNX runtime, ~140MB model. No external API.              |
| LLM extraction   | Claude Haiku 4.5 via Anthropic SDK                                                                | Matches existing NanoClaw patterns                        |
| Reranker         | `@huggingface/transformers` + `ms-marco-MiniLM-L-6-v2`                                            | **Enabled from P1 day 1** to close embedding quality gap. |
| IDs              | `ulid`                                                                                            | npm                                                       |
| Write-serializer | Simple `AsyncQueue` class in `src/brain/queue.ts`                                                 | No new dep                                                |
| RRF              | Native JS (~20 lines in `src/brain/retrieval.ts`)                                                 |                                                           |

**Code location:** new `src/brain/` directory in NanoClaw:

```
src/brain/
  db.ts          — brain.db init, WAL, migrations
  schema.sql     — full schema
  queue.ts       — write-serializer
  ingest.ts      — pipeline
  entities.ts    — deterministic resolution
  extract.ts     — cheap rules + LLM tier
  embed.ts       — embedding + Qdrant upsert (model-version aware)
  retrieve.ts    — FTS5 + Qdrant + RRF + scoring
  eval.ts        — golden set harness
  migrate.ts     — one-shot migration from messages.db
```

---

## 12. Phased rollout (3 weeks)

| Phase  | Duration | Deliverable                                                                                               | Exit criteria                                                                            |
| ------ | -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **P0** | Week 1   | `brain.db` + schema + WAL + serializer + `raw_events` capture from SSE + Qdrant `model_version` backfill  | All new emails land in `raw_events`; `model_version` present on every Qdrant point       |
| **P1** | Week 2   | Entity spine + deterministic resolution + FTS5 + RRF retrieval + golden-set eval harness                  | Golden set passes baseline threshold; Telegram `/recall` returns results from `brain.db` |
| **P2** | Week 3   | `knowledge_facts` → `knowledge_units` migration + cutover + observability + cost tracking + weekly digest | Old `knowledge_facts` read-only; daily cost report in digest; drift alerts work          |

After P2 ships: 30-day **measurement phase** — real ingestion, real queries, real cost data. Then revisit the deferred list with evidence.

---

## 13. Re-evaluation triggers (machine-checkable)

Each deferred feature has a concrete metric that fires re-evaluation:

```
IF entity_count > 10_000 OR dedup_precision < 0.95   → build Splink sidecar
IF working_set_kus > 100_000 OR qdrant_ram > 8GB    → build tier demotion
IF retrieval_precision_at_10 < 0.6 on golden set    → enable cross-encoder rerank
IF retrieval_confidence < 0.4 on > 10% of queries   → add HyDE fallback
IF second_user_in_work_scope                        → add OpenFGA
IF colleague_access_requested OR audit_requirement  → split brain.db into personal.db / work.db
IF topic_redundancy > 3 per week in retrieval       → add consolidation
```

These get checked in the weekly digest. No hand-wavy "we'll get to it."

---

## 14. Open questions (neutrally framed)

1. **Embedding privacy.** Default is OpenAI for every KU — including personal emails, Gong transcripts, deal data. Two options: (a) Accept OpenAI default; (b) Start with `nomic-embed-text-v1.5` locally at lower quality. I recommend (a) for quality, with an audit in month 2 to decide if any source types need local-only. Your call.
2. **Brain DB location.** `store/brain.db` alongside existing `store/messages.db`. Or do you want `brain/brain.db` for cleaner separation?
3. **Telegram recall UX.** Free-form `/recall <question>` or structured `/who`, `/what`, `/when`? Free-form is LLM-backed, takes longer, costs more per query. Structured is instant. I'd default to free-form; add shortcuts if digest shows repeat patterns.
4. **Golden set origin.** I can seed 25 queries from your existing `knowledge_facts` data, or you can write them. Yours are more valuable but take your time. Mine are ready tomorrow.
5. **LLM extraction model.** Haiku 4.5 (~$0.05/day). Alternative: skip LLM extraction in v2, rely on cheap rules only. Saves $1-2/month, loses structured claims. I'd keep LLM; it's the main value-add over the existing system.
6. **Green light P0?** If yes, I'll start with the schema + migration module first so we have a reversible checkpoint before any cutover.

---

## 15. What this deliberately does not do

To avoid scope creep, explicitly out of v2:

- No graph traversal beyond depth 1 (defer to Neo4j or recursive CTEs when needed).
- No attachment OCR or PDF extraction (attachments stored as raw bytes in `raw_events.payload` for now).
- No consolidation / supersession logic — just write `topic_key` so future supersession can find groups.
- No HubSpot/Gong/browser ingestion — SSE email only for v2. Others added after the pipeline proves itself.
- No learning loop for extraction quality (month 2+).

---

_Full evidence: [.omc/research/brain-architecture-battle-tested.md](../../.omc/research/brain-architecture-battle-tested.md)_
_Superseded: [.omc/design/brain-architecture-v1.md](brain-architecture-v1.md)_
_Review that drove this revision: critic findings — migration gap, retrieval contradiction, WAL/serializer unspecified, ATTACH risks, observability missing, indexes missing._
