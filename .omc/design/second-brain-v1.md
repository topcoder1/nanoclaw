# Second Brain v1 — design

**Status:** draft (2026-04-24)
**Author:** Jon + Claude
**Superseded by:** —
**Builds on:** [brain-architecture-v2.md](./brain-architecture-v2.md), [brain-miniapp-v1.md](./brain-miniapp-v1.md)

## Goal

Make every meaningful thing I learn retrievable from wherever I work, without me having to remember where I put it. The brain (v2) gave me *email archival + extraction*. This doc extends that into a personal second brain: multi-input capture, per-repo surfacing, and a single "what do I know about X" entry point.

## Non-goals

- Replacing the brain.db / Qdrant substrate — v2 stays the storage layer.
- Replacing SuperPilot KB — it remains the agent's curated working memory for email drafting.
- Indexing other people's code or shared repos. This is personal.
- Real-time co-authoring of the brain from multiple devices. Single-machine for v1.
- Perfect freshness. "Eventually consistent within 24h" is the bar.

## Current state (what we have, what's missing)

| Layer | What exists | Gap |
|---|---|---|
| Capture — email | brain.db ingests every email's subject + snippet + sender; extracted into claims | Body is truncated at Gmail's ~200 char snippet; no other channels |
| Capture — code/docs | **none** | 20+ repos' READMEs, docs, architecture notes are invisible to the brain |
| Capture — user-initiated | **none** | No "save this thought" inbox for Jon's own notes / meeting takeaways |
| Storage | brain.db (SQLite + FTS5) + Qdrant `ku_nomic-embed-text-v1.5_768` | Fine. Reused for v1. |
| Curation | SuperPilot KB (MCP `upload_to_kb`), kb-housekeeping skill | Email-only scope |
| Retrieval | miniapp (`/brain/*`), `/recall` chat cmd, `/brainstream`, new `/brain/queries` | No CLI from arbitrary cwd; not consulted inside normal agent turns |
| Expression | `generate_reply` grounds email drafts in SP KB | Agent doesn't auto-consult brain.db during conversation; editor / cwd context has no surfacing |

**Sharpest gaps**: no repo indexing, no CLI entry point, no cwd-aware surfacing.

## Target architecture

```
 ┌─── capture ──────────────────────────────────────────┐
 │                                                      │
 │  email (SSE)  ─►  brain ingest  ─►  knowledge_units  │
 │                                                      │
 │  repo fs-watch ─►  code indexer ─►  knowledge_units  │  ← v1 new
 │                                     source_type=repo │
 │                                                      │
 │  user: claw save "…" ─► inbox capture ─► KUs         │  ← v2
 │                                     source_type=note │
 │                                                      │
 │  (future) Slack / voice / PDF / web reads            │  ← v3+
 │                                                      │
 └──────────────────────────────────────────────────────┘
                         │
                         ▼
            ┌──── storage (reused) ────┐
            │ brain.db + Qdrant        │
            └──────────┬───────────────┘
                       │
 ┌───────────── retrieval ────────────────────┐
 │                                            │
 │  claw know X   ── unified CLI              │  ← v1 new
 │      │                                     │
 │      ├─► brain.db recall()                 │
 │      └─► SuperPilot search_kb (MCP proxy)  │
 │                                            │
 │  miniapp (existing /brain/*)               │
 │  /recall chat command (existing)           │
 │  docs/journal.md per repo (cached view)    │  ← v2
 │  agent turn prelude auto-recall            │  ← v3
 │                                            │
 └────────────────────────────────────────────┘
```

## Staged delivery

### v0 — prove the CLI UX (≈200 lines, no infra)

Ship a `claw know <query>` subcommand that performs an on-demand walk:
- Calls `recall()` against the live brain.db (today's email KUs)
- Calls SuperPilot's `search_kb` over HTTP (needs endpoint confirmed)
- Interleaves by normalized score, labels each hit by source

**Success criteria**: from any `~/dev/<project>` directory, `claw know "stellar cyber pricing"` returns a useful ranked list in under a second and the result feels like *the right answer shape*.

**Explicitly out of scope at v0**: repo content, journals, daemon, agent-grounding changes, writes of any kind.

**Why this first**: it proves whether the merged-output format works before we commit infra. If the merge is noisy or confusing, we fix it in CLI only. No wasted daemon work.

### v1.0 — on-demand repo indexer (shipped 2026-04-24)

`claw sync [--repo NAME | --all]` subcommand in the existing `claw` CLI.

- Uses `git ls-files` per repo so `.gitignore` is honored for free; falls back to a filesystem walk with a hardcoded skip-list for non-git dirs
- Indexes `.md`, `.mdx`, and root-level README/CHANGELOG/CONTRIBUTING/LICENSE files only (code files deferred to v1.1)
- Skips binaries (null-byte sniff) and files larger than 64 KB
- Deterministic KU id (`repo-<sha256(source_ref)[:24]>`) so re-syncing the same file upserts in place instead of churning FTS
- `source_ref` format: `<repo_name>:<relative_path>`
- `source_type='repo'`; `account` pulled from `~/.claw/repos.yaml` per-repo (default `work`); `tags` array copied through
- Writes directly to brain.db via Python `sqlite3` — no Node subprocess, no embeddings (FTS-only retrieval for now)
- FTS5 picks up new rows via the existing `ku_fts_ai` trigger; no extra plumbing

Shipped with **1,136 files indexed across 32 repos in ~5s** (initial full sync).

Deliberate v1.0 non-features:
- No `fswatch` daemon. Sync is on-demand (`claw sync`) or via cron (user-configured).
- No code file indexing.
- No embeddings (semantic search stays email-only until v1.1).
- No `git_sha` provenance (metadata stores mtime + file_size; that's enough to start).

### v1.1a — Nomic embeddings for repo KUs (shipped 2026-04-24)

`scripts/brain-embed-repos.ts` — Node subprocess that finds repo KUs without a Qdrant point and embeds them with the same Nomic 768-d model email ingest uses. Idempotent (Qdrant `retrieve` pass dedupes), runnable standalone or auto-chained off `claw sync` (disable with `--no-embed`).

- Embedding throughput in practice: ~1 doc/s steady state (dominated by Nomic inference on CPU). Initial 1,136-file full run ≈ 15–20 min.
- Writes into the same `ku_nomic-embed-text-v1.5_768` collection as email KUs — unified semantic index.
- **Miniapp `/brain/search` and future `recall()` callers automatically pick up repo content via hybrid FTS+semantic+rerank** without any retrieval-side changes.

Deliberately NOT in v1.1a: CLI-side semantic (the `claw know` command remains FTS-only for now — v1.1b adds a localhost `/api/brain/recall` endpoint to close that loop).

### v1.1b — semantic in `claw know` (shipped 2026-04-24)

`GET /api/brain/recall?q=&limit=&account=` added to `createBrainApiRoutes`. Accepts the `x-service-token` header for authn (extended `createTelegramAuthMiddleware` to bypass initData verification when a valid service token is present). `claw know` now tries the miniapp's HTTP endpoint first and falls back to direct SQLite FTS5 if the miniapp is down (or `--no-http-recall` is passed).

Effect: `claw know "orphan vpn"` used to return 1 false-positive from an email; it now returns the actual `wxa_vpn:docs/superpowers/runs/...` files at the top. `claw know "where is authentication handled in the frontend"` surfaces `inbox_superpilot:docs/designs/authenticated-crawl-ux.md` — a semantic match FTS5 would miss.

### v1.1c — truncate oversize files before embedding (shipped 2026-04-24)

The initial v1.1a embedding run dropped 103/1131 files on Nomic's 8192-token context limit. Fix: cap input at a 28KB soft limit before `embedText()`; on fail, retry once at 12KB. Truncation is recorded in the Qdrant payload (`truncated_to_bytes`) so we can audit later. v1.2's code indexer will replace this with symbol-boundary chunking.

### v1.2 — code file indexing (planned)

Opt-in per repo (`scope: docs+code` in repos.yaml). Chunk by symbol boundaries for `.ts` / `.py` / `.go`; fall back to 4KB rolling windows. Adds potentially 5–50× more KUs — worth it only if v1.0 + v1.1's doc-only coverage proves too narrow.

### v1.3 — fswatch daemon (planned)

Central launchctl agent (`com.claw.code-indexer`), separate from nanoclaw, watching paths from `~/.claw/repos.yaml` via `fswatch`. Debounces changes, re-indexes modified files only. Deferred until (a) v1.0 + v1.1 retrieval is felt-to-be-useful and (b) manual `claw sync` + nightly cron becomes annoying. Likely trigger: team grows beyond one person, or you want "saved a file → searchable within 30s" latency.

### v2 — journals + user capture inbox

Two additions, both writes:

1. **`docs/journal.md` per tracked repo** — agent or CLI can append curated summaries; journal is a *cached view* regenerated from brain.db on `claw sync <repo>`, not the source of truth. Append-only + supersession pattern (mirror brain.db's `superseded_at`). Consolidation via an extended `kb-housekeeping` skill pass.
2. **`claw save "…"` inbox** — one-liner capture of a thought, meeting takeaway, or "save this URL". Writes as `source_type='note'`. The missing bidirectional surface.

### v3+ — expression layer

- Agent turn prelude: auto-`recall()` relevant KUs before responding, so the agent answers from memory without `/recall`.
- `generate_reply` grounding extended to brain.db, not just SP KB.
- More inputs: Slack, voice memos, PDFs, web reads (Readwise-style?), meeting transcripts.
- Editor integration (VS Code command palette: "brain: what do I know about this symbol?").

## Open questions

1. ~~**Which 20+ repos?**~~ **RESOLVED 2026-04-24** — enumerated in `~/.claw/repos.yaml`. 31 tracked + 7 untracked-pending-review + `wxa-secrets` hardcoded-skipped. Reviewable/editable by hand.
2. ~~**SuperPilot HTTP KB endpoint**~~ **RESOLVED 2026-04-24** — `GET /api/nanoclaw/kb/search?q=&tags=&limit=` already exists at `inbox_superpilot/backend/app/api/nanoclaw_bridge.py:134`. Auth: `x-service-token` header using `NANOCLAW_SERVICE_TOKEN` (same token nanoclaw already holds for SSE). Backend: ChromaDB hybrid search with `min_score=0.3`. Zero SP-side work required.
3. **File-level vs claim-level KU granularity** — v1 picks file-level. Do we need claim-level on day 1 for `README.md`, `ARCHITECTURE.md`, design docs? Bias: no, defer until v0 retrieval shows the gap.
4. ~~**Same brain.db or separate `code-brain.db`?**~~ **RESOLVED 2026-04-24 (provisional)** — same brain.db, new `source_type='repo'`. Pros (unified queries, shared entity resolution, zero new infra) outweigh cons (theoretical write contention at personal scale) by the tradeoff table. Revisit only if we hit real ops pain.
5. **Daemon process location** — new launchctl plist (`com.claw.code-indexer`) or fold into nanoclaw? Bias: separate. Nanoclaw restarts on every code change; indexer must be stable.
6. **v0 retrieval strategy inside the CLI** — deferred. Initial `claw know` uses FTS5-only against brain.db (no semantic, no rerank) to avoid needing a Node subprocess for `recall()`. If BM25-only proves too noisy, v0.1 adds a localhost HTTP endpoint on the nanoclaw miniapp (`GET /api/brain/recall`) that wraps the full hybrid pipeline. Skipping this endpoint in v0 keeps the commit small and validates UX first.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Indexing secrets-bearing files (`.env`, `*.key`) | `.gitignore` honored by default; add `.clawignore` as additional filter; hardcode skip list for common secrets filenames |
| Journal drift vs code (agent writes a fact, code changes, fact goes stale) | `git_sha` provenance + weekly consolidation marks stale + time-decay in retrieval ranking |
| Brain.db growth at 20+ repos | File-level granularity + content-hash dedup keeps ≈5-15MB storage total; acceptable |
| CLI noise from poorly-ranked SP KB hits crowding out brain.db hits | Per-source caps in `claw know` output (e.g. top 5 brain + top 3 SP). Tunable. |
| 20+ fswatch handles on macOS hitting FD limits | `fswatch` uses kqueue, one handle per root dir, not per file — 20 roots is fine |
| SuperPilot HTTP endpoint doesn't exist yet | v0 ships brain-only if needed; add endpoint as parallel track in the SP repo |

## Decision log (to fill as we go)

- **2026-04-24**: chose staged v0 → v1 → v2 over building daemon first. Rationale: validate search UX before committing infra.
- **2026-04-24**: same brain.db for email + code + notes — confirmed after tradeoff table review.
- **2026-04-24**: daemon runs as separate launchctl agent, not inside nanoclaw.
- **2026-04-24**: confirmed SP exposes `GET /api/nanoclaw/kb/search` with `x-service-token` auth; CLI reuses the existing `NANOCLAW_SERVICE_TOKEN`.
- **2026-04-24**: SP KB backend is **ChromaDB** (not Qdrant as in the brain). Relevant only if we ever want to unify vector infra; for v1 it's opaque behind the HTTP boundary.
- **2026-04-24**: v0 CLI uses FTS5-only against brain.db. No Node subprocess, no new HTTP endpoint. Upgrade path: add `/api/brain/recall` HTTP wrapper when BM25 ranking proves insufficient.
- **2026-04-24**: `~/.claw/repos.yaml` is the canonical repo inventory for the indexer. 31 tracked to start.
- **2026-04-24**: v1.0 repo indexer shipped — 1,136 markdown/README files across 32 repos, ~5s initial sync, upserts by deterministic id, FTS-only retrieval for now.
- **2026-04-24**: `claw sync` is Python (not Node) so it has zero subprocess startup cost and can write to brain.db directly. Schema compatibility risk: if nanoclaw adds a NOT NULL column to `knowledge_units`, the sync will fail loudly until the column gets a DEFAULT or we add it to the Python INSERT.
- **2026-04-24**: v1.1a embeddings shipped — `scripts/brain-embed-repos.ts` auto-chains off `claw sync` (skippable with `--no-embed`). Repo KUs now feed the same Qdrant collection as email KUs, so miniapp search + future `recall()` callers get hybrid retrieval over the whole corpus. CLI stays FTS-only pending v1.1b HTTP wrapper.

## What this doc is NOT yet

- An implementation plan — that comes after v0's open questions are answered.
- A contract. Until one version ships, this doc is revisable in place.
- A promise of v3+. Those are directional; they may be scoped out or reshaped once v0/v1 land.
