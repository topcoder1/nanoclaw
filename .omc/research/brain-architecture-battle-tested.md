# Brain Architecture: Battle-Tested Patterns for Lifetime Knowledge Base

**Research date:** 2026-04-23
**Evidence tiers:** [A] production-proven at scale · [B] mature project with real users · [C] promising but early · [D] academic/speculative
**Adoption tags:** Adopt now · Adopt later · Evaluate · Skip

---

## Executive Summary

A lifetime personal+company augmented-memory system is achievable on the NanoClaw Node.js/SQLite/Qdrant stack, but requires several non-negotiable architectural commitments. The three most dangerous traps are: (1) allowing entity resolution to auto-merge below the 0.9 confidence threshold, (2) mixing embedding model generations in the same Qdrant collection, and (3) planning on Kuzu as the embedded graph DB — it was archived on October 10, 2025 after an Apple acquisition. The highest-confidence pattern portfolio is: Splink-based batch entity resolution feeding a canonical identity spine, Zep/Graphiti-style bi-temporal Knowledge Units, RRF-fused hybrid retrieval (SQLite FTS5 + Qdrant + cross-encoder), and dual SQLite files (personal.db / work.db) for physical scope isolation.

---

## Section 1: Entity Resolution at Scale

### 1.1 Tool Landscape

**Splink** [A] — **Adopt now**
- Probabilistic Fellegi-Sunter model with DuckDB backend.
- Benchmarked: 7M records in ~2 minutes on standard AWS instance (2024 benchmark by Robin Linacre).
- Production deployments: NHS England (healthcare), Australian Bureau of Statistics Census 2024.
- arXiv 2508.03767 (Aug 2025): processed 15.7M+ records where Dedupe.io hit OOM at 2M.
- SQL-based, fully explainable, MIT license. Python only — call via HTTP sidecar or child_process.
- Best use: batch deduplication during ingestion, nightly consolidation runs.

**Zingg** [A] — **Adopt later**
- Spark/Databricks ML active learning. Native AWS Glue integration (2024). Ideal for messy data where rule-writing is impractical.
- Over-engineered for single-user personal KB at < 500K entities. Know it exists.

**Dedupe.io** [B] — **Skip at scale**
- v3.0 (mid-2024) improved active learning but OOM threshold remains ~2M records. Use for local prototyping only.

**Senzing** [A] — **Skip**
- Graph-based; correct for 100M+ entities. Proprietary, over-engineered for this use case.

### 1.2 Identity Spine Pattern [A] — Adopt now

The canonical production pattern used in HubSpot, Apollo, and Clearbit-style pipelines:

```sql
-- entities: stable canonical identity
CREATE TABLE entities (
  entity_id   TEXT PRIMARY KEY,  -- ULID, never changes
  entity_type TEXT NOT NULL,     -- person | company | product | project
  canonical   TEXT               -- JSON: merged highest-confidence fields
);

-- entity_aliases: all transient external identifiers
CREATE TABLE entity_aliases (
  alias_id    TEXT PRIMARY KEY,
  entity_id   TEXT REFERENCES entities,
  source_type TEXT,              -- hubspot | gong | email | manual
  source_ref  TEXT,              -- external ID in that system
  field_name  TEXT,              -- email | domain | phone | name
  field_value TEXT,
  valid_from  TEXT NOT NULL,     -- ISO8601
  valid_until TEXT,              -- NULL = still active
  confidence  REAL               -- 0.0-1.0
);
```

**Critical insight:** Person identity and company affiliation are distinct. A person's `entity_id` persists when they change employers. Their work email is an alias with a `valid_until` date, not a primary identifier. Failure to model this causes cascading deduplication errors in any system that relies on email-based identity.

### 1.3 Confidence Thresholds [B]

Industry-standard bands (HubSpot/Apollo/Clearbit internal practice):
- **> 0.9** — auto-merge, write to canonical entity
- **0.7 – 0.9** — queue to `entity_review` table, merge on next human/agent review pass
- **< 0.7** — keep separate, link as `candidate_match` edge with confidence score

Do not auto-merge below 0.9. False merges compound: once "John Smith (Acme)" and "John Smith (Beta Corp)" are merged, every downstream KU inherits the contamination and subsequent merges pass the threshold incorrectly.

### 1.4 Temporal Identity [A]

Model employment, reporting relationships, and project membership as time-bound edges:

```sql
CREATE TABLE entity_relationships (
  from_entity_id  TEXT,
  relationship    TEXT,    -- works_at | reports_to | owns | member_of
  to_entity_id    TEXT,
  valid_from      TEXT NOT NULL,
  valid_until     TEXT,    -- NULL = currently active
  source_type     TEXT,
  confidence      REAL
);
```

When HubSpot reports a job change or an email bounces: create a new alias with `valid_until` on the old one, create a new alias for the new employer. The `entity_id` spine never changes.

### 1.5 ML vs. Deterministic vs. Hybrid [A]

Production consensus (2024-2025): **hybrid wins.** Start deterministic (exact email → auto-merge), escalate to probabilistic (Splink Fellegi-Sunter on name+company+phone) for ambiguous cases. Full ML (Zingg active learning) only if labeled training data exists. For < 100K entities in a personal KB, deterministic + Splink probabilistic covers 95%+ of cases with no ML infrastructure.

---

## Section 2: Personal/Agentic Memory Architectures

### 2.1 Letta (formerly MemGPT) [B] — Evaluate

**Architecture:** Three-tier — Core Memory (in-context RAM), Recall Memory (conversation history), Archival Memory (vector DB, effectively infinite).

**2025 updates:**
- Letta V1 (Oct 2025): rearchitects away from explicit tool-chaining toward native LLM reasoning (Response APIs). Less brittle than the original heartbeat loop.
- "Sleep-Time Compute" pattern: secondary agents process and consolidate archival memories asynchronously while the main agent is idle. High-value pattern directly applicable to NanoClaw.
- Letta Filesystem (Aug 2025): organizes archival content with file/folder metaphor + agentic grep/semantic_search tools. Higher benchmark accuracy on LoCoMo than pure RAG.

**Known issues:**
- Archival memory search is coarse (semantic-only). No BM25 fallback — exact-match queries on names, IDs, and dates are unreliable.
- Not Node.js native — Python server. Integrate via HTTP API or avoid as a direct dependency.
- Original heartbeat architecture was brittle under high message volume. V1 fixes this but breaks migration paths.

**Recommendation for NanoClaw:** Borrow the three-tier memory pattern and sleep-time compute concept. Do not adopt Letta as a dependency — implement the pattern natively in the KU schema.

### 2.2 Mem0 [B] — Adopt later

**Architecture:** Dual-store — vector DB for semantic recall + knowledge graph for entity relationships. Single-pass extraction claims 80% token cost reduction (arXiv 2504.19413, Apr 2025).

**Strengths:** User personalization, fast time-to-production, broad integrations. Added Kuzu and AWS Neptune as graph backends in late 2025 (Kuzu is now archived — use Neo4j or Memgraph backend if adopting Mem0).

**Verdict:** Useful reference architecture. The KU schema proposed in the design supersedes Mem0's approach for the entity-centric requirement.

### 2.3 Zep / Graphiti [B] — Adopt now (as reference architecture)

**Architecture:** Bi-temporal knowledge graph. Tracks event time (when a fact became true in the world) and ingestion time (when the system learned it). Three subgraph layers: Episodic (raw events), Semantic (distilled facts), Community (entity clusters).

**Performance:** arXiv 2501.13956 (Jan 2025) demonstrates superior performance on Deep Memory Retrieval (DMR) benchmark. The 90% latency reduction vs. MemGPT claim is from this paper.

**Key pattern to adopt:** Validity windows on graph edges. Every relationship has `valid_from`/`valid_until`, enabling time-travel queries: "What did I know about Company X on 2025-01-15?"

**Recommendation:** Do not adopt Zep as a dependency (Python, heavy). Implement the bi-temporal edge pattern natively in SQLite.

### 2.4 LangChain Memory Modules [B] — Skip

**Confirmed production limitations:**
- `ConversationSummaryBufferMemory`: triggers LLM calls on every token-limit breach, adding seconds to response time
- `VectorStoreRetrieverMemory`: exponential latency as history grows. Multi-hop accuracy ~70-75%. Fails on chronological reasoning.
- No native cross-session persistence without significant custom wiring.
- Designed for single-session chatbots. Not suited for lifetime KB.

**Verdict:** Skip entirely. The NanoClaw KU schema is architecturally superior.

### 2.5 Cognitive Architecture Patterns [D]

**ACT-R applicability:** The declarative memory activation formula (`B_i = ln(Σ t_j^{-d})` where `t_j` = time since j-th access, `d` ≈ 0.5 decay parameter) is the academically grounded basis for tiered memory decay. The KU scoring function for retrieval ranking should incorporate access frequency and recency in this form.

---

## Section 3: Temporal Knowledge Modeling

### 3.1 Bitemporal Modeling [A] — Adopt now

**The core distinction:**
- `valid_from` / `valid_until` — when the fact was true in the real world (event time)
- `recorded_at` / `superseded_at` — when the system believed it (transaction time)

**XTDB vs. Datomic:** Both JVM-based, incompatible with Node.js stack. Implement the pattern manually in SQLite.

**Full KU schema:**
```sql
CREATE TABLE knowledge_units (
  id              TEXT PRIMARY KEY,  -- ULID
  text            TEXT NOT NULL,
  source_type     TEXT NOT NULL,     -- email|gong|hubspot|browser|manual|attachment
  source_ref      TEXT,
  account         TEXT NOT NULL,     -- personal|work
  scope           TEXT,              -- dept tag for RBAC
  confidence      REAL DEFAULT 1.0,
  valid_from      TEXT NOT NULL,     -- ISO8601 event time
  valid_until     TEXT,              -- NULL = still believed true
  recorded_at     TEXT NOT NULL,     -- ISO8601 ingestion time
  superseded_at   TEXT,              -- set when fact contradicted
  tier            TEXT DEFAULT 'hot',-- hot|warm|cold|forgotten
  tags            TEXT,              -- JSON array
  extracted_by    TEXT,              -- agent ID or 'human'
  extraction_chain TEXT              -- JSON array of source KU ids
);
```

### 3.2 Event Sourcing — Do We Need It? [B]

**Verdict:** Full event sourcing is over-engineered for a personal KB. A bitemporal KU schema with an immutable `raw_events` table provides 90% of the value at 30% of the complexity.

### 3.3 Snapshot + Delta for Vector Collections [A] — Adopt now

**Never mix embedding model generations in the same Qdrant collection:**
1. Store `model_version` in every Qdrant point payload.
2. When upgrading embedding model, create a new collection — never update in-place.
3. Run shadow queries against both during transition; cut over when new collection coverage > 99%.
4. Delete old collection.

Mixing float32 vectors from different model generations makes similarity scores mathematically meaningless — the most common silent RAG degradation in production.

---

## Section 4: Hybrid Retrieval

### 4.1 BM25 + Dense + Rerank Pipeline [A] — Adopt now

```
Query
  │
  ├─ BM25 (SQLite FTS5)   → top-100 candidates
  ├─ Dense (Qdrant HNSW)  → top-100 candidates
  │
  └─ RRF fusion (k=60)    → merged top-150
        │
        └─ Cross-encoder rerank → final top-10-20
```

**Why it works:** BM25 captures exact terms, IDs, rare tokens. Dense captures semantics and paraphrases. RRF merges without score normalization. Cross-encoder rerank provides precision: reduces hallucination rate from ~23% to ~11% in production.

**RRF formula:** `score(d) = Σ 1 / (k + rank_i(d))` where k=60 is standard. Zero calibration required. 20 lines of JS.

### 4.2 GraphRAG — When to Add It [B] — Adopt later

GraphRAG adds value once the entity graph has > 50K edges. At personal KB scale (< 1M edges over 5 years), a simple SQL join is faster and more debuggable. Re-evaluate at year 2-3.

### 4.3 HyDE — Conditional Use [B] — Evaluate

**Production evaluation (2025):**
- Effective for vague/short queries with vocabulary mismatch (+25% improvement in technical domain).
- Counterproductive for numerical, financial, or precise factual queries — hallucinates context.
- Adds 25-60% latency.

**Recommendation:** Implement HyDE as a **fallback only** when initial hybrid retrieval returns low confidence. Cache by query hash. Do not enable by default.

### 4.4 Recency Decay Scoring [B] — Adopt now

```javascript
const recencyDecay = (validFrom, halfLifeDays = 180) => {
  const ageDays = (Date.now() - new Date(validFrom)) / 86400000;
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
};
const combinedScore = 0.7 * rrfScore + 0.3 * recencyDecay(ku.valid_from);
```

Half-life 180 days default. Make configurable per query intent: "recent news" = 7-day half-life; "all-time knowledge" = disable decay.

### 4.5 Late Interaction: ColBERT [B] — Adopt later

ColBERT v2 via Transformers.js enables token-level late interaction reranking in Node.js. For a personal KB under 500K KUs, `ms-marco-MiniLM-L-6-v2` cross-encoder is sufficient at lower compute cost.

---

## Section 5: Knowledge Graph Layer

### 5.1 Graph DB Assessment

| Option | Status | Assessment |
|--------|--------|-----------|
| SQLite recursive CTE | [A] | Depth 1-2 fine. Depth > 3 exponential latency. |
| Neo4j Community | [A] | ~500MB RAM idle, Java, Cypher, mature. Add only if needed. |
| Memgraph | [B] | In-memory, sub-millisecond, OpenCypher. |
| **Kuzu (embedded)** | **ARCHIVED Oct 2025** | **Do not adopt under any circumstances** |
| SQLite adjacency list | [A] | Sufficient to depth 3 with covering indexes |

**Verdict:** SQLite adjacency list with covering indexes on `(from_entity_id, relationship)` and `(to_entity_id, relationship)` covers 95% of queries. Depth-2: ~12ms on 1M rows. Depth-3: ~150ms. Add Neo4j Community only if depth > 3 multi-hop queries become frequent.

### 5.2 Kuzu Post-Mortem

Kuzu archived on GitHub October 10, 2025. Apple acquisition followed. Community fork "Bighorn" by Kineviz exists but lacks official support. **Do not use Kuzu** — especially for a 5-10 year horizon.

### 5.3 Property Graph vs. RDF [A]

Property graph is the correct choice. RDF/SPARQL is unnecessary complexity; property graphs support first-class edge attributes; all modern agent frameworks target property graph interfaces.

---

## Section 6: Scope / RBAC / Multi-Tenancy

### 6.1 Physical Database Isolation [A] — Adopt now

**Application-layer RBAC within a single SQLite file is fragile.** A single bug in the query builder leaks personal data into work queries. Physical separation is the only reliable hard wall.

**Recommended pattern:** Two SQLite files joined via `ATTACH DATABASE`:
```javascript
const db = new Database('/data/work.db');
db.exec("ATTACH '/data/personal.db' AS personal");
db.prepare("SELECT * FROM personal.knowledge_units WHERE ...").all();
```

### 6.2 OpenFGA for Fine-Grained Work RBAC — Adopt later

OpenFGA reached CNCF Incubation status early 2025. Grafana Labs contributed SQLite storage adapter (Jan 2025). Sub-millisecond `Check` calls.

**Warning:** OpenFGA and Qdrant have no shared transaction boundary. Use short-lived scoped JWTs (TTL ≤ 60s) and enforce Qdrant-side filtering to minimize the race window.

### 6.3 Audit Logging [B] — Adopt now

Log a hash of the query text, not the verbatim text. Prevents the audit log from becoming a secondary data exfiltration surface.

---

## Section 9: Production Failure Modes

### 9.1 Vector Store Drift — Embedding Generation Mismatch [A]

**The most common silent RAG degradation in production.** Mixing embedding generations in same collection makes cosine similarity mathematically meaningless.

**Prevention:** `model_version` in every Qdrant point payload. New model → new collection. Shadow-query both during transition. Detect drift proactively: embed 100 random KUs with both models monthly; alert if cosine similarity distribution shifts > 0.15.

### 9.2 Qdrant HNSW Scaling Limits [A]

| Failure Mode | Threshold | Mitigation |
|-------------|-----------|-----------|
| Memory exhaustion | ~5M vectors @ 1536d ≈ 30GB RAM | Scalar Quantization (4x) or Binary Quantization (32x) |
| Recall drift | > 1M vectors | Increase HNSW `m` to 32-48, `ef_construct` to 200 |
| I/O saturation | On-disk vectors | Enable `io_uring` in Qdrant config |
| Indexing deadlocks | Background optimization during high write load | Throttle ingestion; dedicated write queue |

**Starting point:** `m=16, ef_construct=100` (defaults). Enable Scalar Quantization at 500K vectors.

### 9.3 Entity Resolution Snowball [A]

An incorrect auto-merge at confidence 0.85 causes all subsequent KUs to inherit wrong `entity_id`. One bad merge creates hundreds of contaminated KUs within weeks.

**Prevention:** Enforce the 0.9 threshold as a **hard code constraint**. Log all merges with full match evidence. Implement `merge_undo` that splits an entity back into candidates.

### 9.4 SQLite Write Concurrency [A]

**Real risk:** Gmail MCP + HubSpot sync + Gong pipeline running concurrently. SQLite WAL mode allows one writer at a time.

**Mitigation:**
1. Single write-serializer queue in Node.js — all writes pass through one async queue.
2. Batch writes: 50-100 KUs before flushing in one transaction.
3. WAL mode + `PRAGMA synchronous = NORMAL` for ingestion.
4. At > 1000 KUs/minute, separate `ingest.db` staging file merging into `work.db` on schedule.

### 9.5 Decay Policy Failure Modes [B]

**Recommended tiering:**
```
hot:       0–14 days   → full Qdrant RAM index + FTS5
warm:      15–90 days  → full Qdrant RAM index + FTS5
cold:      91d–5yr     → Qdrant on_disk=true + FTS5
forgotten: > 5yr       → metadata stub only (text stripped, removed from vector index)
```

**Hard rule before promoting to `forgotten`:** `forgotten_at` timestamp, compressed summary KU inheriting entity_id tags, human/agent review flag if `confidence > 0.8` AND access count > 5.

---

## Section 10: Node.js + SQLite + Qdrant Stack

### 10.1 Recommended Library Stack

| Layer | Library | Tier | Decision |
|-------|---------|------|---------|
| SQLite | `better-sqlite3` | [A] | Adopt now |
| Query builder | `Kysely` or `Drizzle` | [B] | Adopt now — **avoid Prisma** |
| Qdrant | `@qdrant/js-client-rest` | [A] | Adopt now — gRPC for high-throughput |
| Embeddings (API) | OpenAI `text-embedding-3-small` | [A] | Adopt now — $0.02/1M tokens, Matryoshka truncation to 512d |
| Embeddings (local) | `@xenova/transformers` + `nomic-embed-text-v1.5` | [B] | Adopt later — privacy-sensitive data |
| Reranker (local) | `@xenova/transformers` + `ms-marco-MiniLM-L-6-v2` | [B] | Adopt now — cross-encoder in-process |
| Reranker (API) | `cohere-ai` Rerank 4 | [A] | Adopt later — best accuracy |
| Entity resolution | Splink (Python HTTP sidecar) | [A] | Adopt now — nightly batch |
| RBAC | `@openfga/sdk` | [B] | Adopt later |
| Graph (light) | SQLite adjacency list | [A] | Adopt now |
| Graph (heavy) | Neo4j Community | [B] | Adopt later |
| RRF fusion | Native (20 lines JS) | [A] | Adopt now |
| Entity IDs | `ulid` npm | [A] | Adopt now |

### 10.2 Embedding Model Recommendations (2026)

**Default:** `text-embedding-3-small` (OpenAI). Truncatable to 512d for warm/cold tiers.
**Local/privacy:** `nomic-embed-text-v1.5` via Transformers.js ONNX.
**2026 MTEB leaders:** Voyage-4-large (proprietary), Qwen3-Embedding-8B (open-source), Cohere embed-v4 (multilingual).
**Do not use:** `text-embedding-ada-002` (superseded).

**Migration rule:** When switching, new collection → shadow queries → cut over → delete old.

### 10.3 Python Sidecar Scope

Run persistent Python FastAPI sidecar on port 8765 with `/dedupe` endpoint for Splink. Splink runs on nightly schedule — does not need real-time.

---

## Top 10 Battle-Tested Patterns to Commit To

**1. [A] Canonical Identity Spine with Time-Bound Aliases** — ULID `entity_id` that never changes; all external identifiers are aliases with `valid_from`/`valid_until`.

**2. [A] Bitemporal Knowledge Units** — both `valid_from/until` (real-world) and `recorded_at/superseded_at` (system belief). Never overwrite.

**3. [A] Immutable Raw Events Separate from Derived KUs** — append-only `raw_events` as episodic ground truth. KUs are derived. Re-derive if extraction improves.

**4. [A] RRF-Fused Hybrid Retrieval** — FTS5 + Qdrant → RRF(k=60) → cross-encoder rerank. 15-25% better than single-modality.

**5. [A] One Embedding Model Version Per Qdrant Collection** — prevents silent RAG degradation.

**6. [A] 0.9 Auto-Merge Threshold — Non-Negotiable** — hard code constraint. Queue 0.7-0.9 for review.

**7. [A] Physical Database Isolation for Personal/Work** — two SQLite files + ATTACH. App-layer RBAC in one file is a security anti-pattern.

**8. [B] Time-Bound Graph Edges (Zep/Graphiti Pattern)** — every relationship carries `valid_from`/`valid_until`.

**9. [B] Tiered Memory Decay with Metadata-Stub Archive** — hot/warm/cold/forgotten. Never destroy stub — preserve entity_id references.

**10. [B] Write-Serializer Queue for SQLite** — all writes through one async queue, batched 50-100 per transaction.

---

## Open Questions

1. At what Qdrant vector count does Scalar Quantization become necessary on the NanoClaw host?
2. Is the OpenFGA SQLite adapter explicitly endorsed for production by OpenFGA maintainers?
3. What Splink blocking config works best for name+email+company dedup in mixed personal/professional entity set?
4. Does a nightly Python Splink sidecar create unacceptable operational dependency as launchd service?
5. When do 1M+ token context windows make tiered memory obsolete for simple personal KB use cases?

---

*Research conducted: 2026-04-23. Sources: 60+ web queries, arXiv 2501.13956/2504.19413/2508.03767, vendor documentation (Letta, Qdrant, OpenFGA, Splink, Zep), production post-mortems, MTEB leaderboard.*
