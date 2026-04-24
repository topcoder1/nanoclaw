# Brain (`src/brain/`)

Augmented brain subsystem — see `.omc/design/brain-architecture-v2.md` for the signed-off design. Research notes live in `.omc/research/brain-architecture-battle-tested.md`.

## Module map

| File | Purpose |
|------|---------|
| `db.ts` | `brain.db` singleton — WAL, applies `schema.sql`, opens lazily. |
| `schema.sql` | Full SQLite schema (entities, knowledge_units, raw_events, FTS5, system_state, cost_log). Idempotent. |
| `queue.ts` | `AsyncWriteQueue<T>` — write-serializer with retry / backpressure / dead-letter. |
| `ulid.ts` | ULID wrapper. |
| `ingest.ts` | `email.received` → `raw_events` → KU pipeline. Entry point: `startBrainIngest`. |
| `entities.ts` | Deterministic entity resolution (person / company) — exact email + domain match. |
| `extract.ts` | Cheap-rules + LLM-tier claim extraction with daily budget cap. |
| `embed.ts` | Local Nomic 768-d embeddings via `@huggingface/transformers`. |
| `rerank.ts` | `ms-marco-MiniLM-L-6-v2` cross-encoder reranker. |
| `qdrant.ts` | Brain Qdrant client — `ku_nomic-embed-text-v1.5_768` collection, UUIDv5 point IDs. |
| `retrieve.ts` | Hybrid retrieval (FTS5 + Qdrant + RRF + rerank + scoring). |
| `recall-command.ts` | Telegram `/recall` handler. |
| `eval.ts` | Golden-set evaluation harness (P1). |
| `backfill-qdrant.ts` | P0 migration — stamp `model_version` on legacy points. |
| `migrate-knowledge-facts.ts` | P2 migration — legacy `knowledge_facts` → `knowledge_units`. |
| `drop-legacy-tombstone.ts` | 30-day cutover tombstone (one-time `system_state` write on brain init). |
| `metrics.ts` | Cost log, `system_state` kv, retrieval-latency ring buffer, brain counts. |
| `reconcile.ts` | Qdrant ↔ SQLite drift detection + scheduler. |
| `alerts.ts` | Threshold-based alert dispatch with per-category hourly throttle. |
| `health.ts` | `/brainhealth` command + structured health report. |
| `weekly-digest.ts` | Sunday 09:00 Markdown digest. |
| `backup.ts` | Nightly `brain.db` backup (02:00) + Qdrant snapshot (02:15). |
| `RECOVERY.md` | Recovery run-book (Qdrant lost / brain.db lost / catastrophic). |

## Data flow (happy path)

```
email.received (SSE)
   │
   ├─ startBrainIngest()
   │    ├─ raw_events INSERT OR IGNORE (idempotent on source_ref)
   │    ├─ extractPipeline (cheap rules, LLM if signal-positive + budget)
   │    ├─ entity resolution (email → person, domain → company)
   │    ├─ knowledge_units INSERT + ku_entities link (single txn)
   │    ├─ embedText → upsertKu into Qdrant
   │    └─ raw_events.processed_at = now
   │
   └─ /recall <q>
        └─ handleRecallCommand → recall()
             ├─ FTS5 top 100 + Qdrant top 100 (model_version filter)
             ├─ RRF merge
             ├─ cross-encoder rerank
             ├─ final = 0.7·rank + 0.2·recency + 0.1·access
             └─ access_count bump via AsyncWriteQueue
```

## Ops runbook

### Routine
- `/brainhealth` — one-shot status check. Shows counts, cost, latency p50/p95/p99, reconcile drift, legacy-cutover status, re-eval triggers.
- `npx tsx scripts/brain-weekly-digest.ts` — ad-hoc digest. Automatic at Sunday 09:00 local.
- `ls store/backups/` — confirm recent `brain.db` backup exists.
- `ls store/qdrant-snapshots/` — confirm recent Qdrant snapshot exists.

### Migration (one-time)
```bash
# Preview
npx tsx scripts/migrate-brain.ts --dry-run
# Apply
npx tsx scripts/migrate-brain.ts
```

### Legacy cutover (≥30 days post-migration)
```bash
# Dry run — confirms tombstone + elapsed window
npx tsx scripts/drop-legacy.ts
# Execute
npx tsx scripts/drop-legacy.ts --confirm
```

### Recovery
See `src/brain/RECOVERY.md` for the full run-book. Quick reference:
- **Qdrant lost** → `npx tsx scripts/reembed-all.ts`
- **brain.db lost** → restore from `store/backups/brain-YYYY-MM-DD.db`, replay legacy via `migrate-brain.ts`, then `reembed-all.ts`.

### Smoke tests
```bash
npx tsx scripts/brain-p1-smoke.ts   # FTS5 + scoring end-to-end
npx tsx scripts/brain-p2-smoke.ts   # P2 — migration + reconcile + health + digest
```

### Re-evaluation triggers (design §13)
Surfaced in `/brainhealth` and weekly digest. Each trigger has a concrete threshold; deferred features light up only when data says so:
- Splink rebuild: `entities > 10_000` or dedup precision < 0.95
- Tier demotion: `kuLive > 100_000` or Qdrant RAM > 8GB
- Rerank already on — re-eval if precision@10 < 0.6
- HyDE fallback: retrieval confidence < 0.4 on > 10% of queries
- OpenFGA: second user in work scope
- DB split: colleague access or audit requirement
- Consolidation: topic redundancy > 3/week

### Alerts (design §9 thresholds)
Throttled 1/category/hour via `system_state` row `alert:<category>`:
- `provider_down` — embedding provider unreachable > 15 min (critical)
- `cost_spike` — today > 2× rolling 7-day avg (warn)
- `qdrant_drift` — `driftRatio > 1%` on last reconcile (warn)
- `monthly_budget` — MTD > $10 (warn)

## Design authority
- `.omc/design/brain-architecture-v2.md` — signed-off 2026-04-23
- `.omc/research/brain-architecture-battle-tested.md` — evidence + research
- `.omc/design/brain-architecture-v1.md` — superseded; kept for history

Do not modify the design docs from within this subsystem — they are the contract.
