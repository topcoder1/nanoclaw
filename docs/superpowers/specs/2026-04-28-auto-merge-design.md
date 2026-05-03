# Auto-Merge for Duplicate Entities — Design

**Date**: 2026-04-28
**Status**: Approved (brainstorm phase complete; awaiting writing-plans)
**Predecessor**: [2026-04-27-discord-signal-brain-ingest-design.md](2026-04-27-discord-signal-brain-ingest-design.md) — PR series that landed `mergeEntities`, `unmergeEntities`, `entity_merge_log`, and `setIdentityMergeReply`.

## Problem

The brain accumulates duplicate person entities as new channels (Signal, Discord) and message sources surface the same humans under different aliases. A concrete example currently in the production brain:

```
01KQ8X5WSYDVRM28ZA3PZCVTGH  {"name":"Jonathan","signal_phone":"+16263483472"}
01KQ9HHRDY5RYADT03SBQG07D6  {"name":"Jonathan","signal_profile_name":"Jonathan"}
```

Manual `claw merge` works but doesn't scale. Many duplicates are unambiguous (same email, same Signal UUID, same Discord snowflake) and should auto-merge silently. Others (same first name, no other identifiers) need an operator decision.

## Goals

1. Auto-merge high-confidence duplicates without operator action.
2. Surface medium-confidence candidates as chat suggestions the operator can confirm or reject.
3. Drop low-confidence candidates rather than create noise.
4. Be safe: every auto-merge must be reversible via `claw unmerge`, and rejected suggestions must never be re-suggested.
5. Be observable: dry-run mode and metrics for first deployment.

## Non-goals (v1)

- Real-time merge on `entity.created` (deferred to v2 once classifier is trusted; `entity.created` event does not yet exist in `src/events.ts`).
- Probabilistic / Splink-style matching (deferred to v3).
- Multi-way merges of 3+ entities in one pass — repeated 2-way passes converge.
- `claw suggestions` listing command (defer to v2).
- Cross-tenant merging (single-user system).

## Architecture

```
nightly cron (task-scheduler, default 02:00 local)
  └─> runAutoMergeSweep(db, opts)
       ├─> findHighConfidenceCandidates(db) → mergeEntities() per pair, merged_by='auto:high'
       ├─> findMediumConfidenceCandidates(db) → persist to entity_merge_suggestions
       │                                          + emit entity.merge.suggested event
       └─> emit metrics: counts by tier, sweep duration

identity-merge-handler.ts (existing module, extended)
  └─> on entity.merge.suggested → format chat message, send via setIdentityMergeReply
       └─> operator replies:
              "claw merge <a> <b>"        → existing path (PR 45)
              "claw merge-reject <a> <b>" → new path: marks suggestion rejected,
                                            writes permanent suppression row

claw unmerge handler (existing, PR 53)
  └─> if unmerged merge had merged_by='auto:high', auto-write permanent suppression
      so the same pair is not re-suggested next sweep
```

The sweep is idempotent: high-confidence merges leave a single canonical entity per group, so subsequent sweeps over the same data find nothing new. Medium-confidence pairs are deduped by `(entity_id_a, entity_id_b)` UNIQUE constraint on `entity_merge_suggestions`, so re-running the sweep does not produce duplicate chat messages.

## Confidence tiers (deterministic v1)

| Tier   | Rule                                                                                                                                                                                                                         | Action                                                                                                        | Confidence |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| HIGH   | Two entities share an exact `entity_aliases.field_value` for any of: `email` (lowercased), `phone` (E.164-normalized), `signal_uuid`, `discord_snowflake`, `whatsapp_jid`. These identifiers are unique-by-design per human. | Silent auto-merge. Write `entity_merge_log` row with `merged_by='auto:high'`, `confidence=1.0`.               | 1.0        |
| MEDIUM | `canonical->>'name'` exact match (case-insensitive, whitespace-trimmed) AND same `entity_type` AND no conflicting hard identifier (defined below).                                                                           | Persist to `entity_merge_suggestions`. Emit `entity.merge.suggested` event. Send chat suggestion to operator. | 0.5–0.8    |
| LOW    | Name fuzzy match, edit-distance ≤ 2, same email-domain only.                                                                                                                                                                 | Drop. Increment `auto_merge_low_conf_dropped` metric. No row written.                                         | <0.5       |

**Conflicting hard identifier** — entity A has email `alice@x.com` AND entity B has email `bob@y.com` (or different `signal_uuid`, etc.). If both entities have the same hard-identifier field with different values, they cannot be the same person and the medium-tier rule short-circuits to no match.

The classifier is implemented as pure SQL (`GROUP BY field_value HAVING COUNT(*) > 1`) plus a JSON-canonical name comparison. No ML, no probabilistic scoring in v1. The confidence number is reported but not currently used for ranking — it is recorded for future tuning and to satisfy the existing `entity_merge_log.confidence` column.

## Schema additions

```sql
CREATE TABLE entity_merge_suggestions (
  suggestion_id   TEXT PRIMARY KEY,           -- ULID
  entity_id_a     TEXT NOT NULL,              -- lex-smaller of the two ids
  entity_id_b     TEXT NOT NULL,              -- lex-larger
  confidence      REAL NOT NULL,
  reason_code     TEXT NOT NULL,              -- 'name_exact', 'phone_normalized', etc.
  evidence_json   TEXT NOT NULL,              -- {fieldsMatched, canonicalA, canonicalB}
  suggested_at    INTEGER NOT NULL,           -- unix ms
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  status_at       INTEGER,
  UNIQUE(entity_id_a, entity_id_b)
);

CREATE INDEX idx_entity_merge_suggestions_status
  ON entity_merge_suggestions(status, suggested_at);

CREATE TABLE entity_merge_suppressions (
  entity_id_a       TEXT NOT NULL,            -- lex-smaller
  entity_id_b       TEXT NOT NULL,            -- lex-larger
  suppressed_until  INTEGER,                  -- unix ms; NULL = permanent
  reason            TEXT,                     -- 'operator_rejected' | 'unmerged_by_operator'
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (entity_id_a, entity_id_b)
);
```

The classifier consults `entity_merge_suppressions` and skips any pair listed there (where `suppressed_until` is NULL or in the future). Permanent suppressions are auto-written when:

1. Operator runs `claw merge-reject <a> <b>` on a chat suggestion.
2. Operator runs `claw unmerge <id>` on a merge whose `merged_by='auto:high'` — we learned that auto-decision was wrong.

Time-bounded suppressions (e.g. `--days=30`) are reserved as a future flag; v1 only writes permanent ones.

`entity_id_a` and `entity_id_b` are always stored lex-ordered (smaller first) so that `(A, B)` and `(B, A)` collapse to the same row. This applies to both new tables.

## Events

One new event type added to `src/events.ts`:

```typescript
export interface EntityMergeSuggestedEvent {
  type: 'entity.merge.suggested';
  suggestionId: string;
  entityIdA: string; // lex-smaller
  entityIdB: string; // lex-larger
  confidence: number;
  reasonCode: 'name_exact' | 'phone_normalized' | 'email_exact' | string;
  evidence: {
    fieldsMatched: string[];
    canonicalA: Record<string, unknown>;
    canonicalB: Record<string, unknown>;
  };
  occurredAt: number;
  group: 'main';
}
```

Added to the `EventTypes` map. The handler in `identity-merge-handler.ts` subscribes and formats:

```
🔗 Possible duplicate (medium confidence)

A: Jonathan (01KQ8X5W...) — signal_phone:+16263483472
B: Jonathan (01KQ9HHR...) — signal_profile_name:Jonathan

Reply:
  claw merge 01KQ8X 01KQ9H        — confirm merge
  claw merge-reject 01KQ8X 01KQ9H — never suggest again
```

The handler reuses `setIdentityMergeReply` (PR 47) for channel-aware delivery.

## New `claw merge-reject` command

Added to `src/brain/identity-merge.ts` as a sibling of `claw merge` and `claw unmerge`. Trigger pattern matches `^claw\s+merge-reject\s+(\S+)\s+(\S+)\s*$`.

Behavior:

1. Resolve both prefixes to entity ids (reuse existing prefix-resolver).
2. UPDATE `entity_merge_suggestions` SET `status='rejected'`, `status_at=now` WHERE the pair matches.
3. INSERT INTO `entity_merge_suppressions` with `reason='operator_rejected'` and `suppressed_until=NULL`.
4. Reply via `setIdentityMergeReply`: `Suppressed ${id_a} ↔ ${id_b}. Will not suggest again.`

If no pending suggestion exists for the pair, still write the suppression row (operator may want to pre-empt a future match).

## Suggestion lifecycle hook in `mergeEntities()`

To keep `entity_merge_suggestions.status` honest regardless of which code path performs the merge, `mergeEntities()` (existing function from PR 45) gains a single post-success step: UPDATE any `entity_merge_suggestions` row where `(entity_id_a, entity_id_b)` matches the merged pair, setting `status='accepted'` and `status_at=now`. This means:

- Auto-merge sweep merging high-conf pair → no suggestion existed, UPDATE affects 0 rows. No-op.
- Operator running `claw merge` after seeing a chat suggestion → suggestion flips to `accepted`.
- Operator running `claw merge` on a pair that was never suggested → UPDATE affects 0 rows. No-op.

The lex-ordering of `(entity_id_a, entity_id_b)` in the suggestions table means `mergeEntities()` must lex-sort the input pair before the UPDATE.

## Operator escape hatches (env vars)

| Var                                    | Default | Purpose                                                    |
| -------------------------------------- | ------- | ---------------------------------------------------------- |
| `BRAIN_MERGE_AUTO_ENABLED`             | `false` | Master switch. When false, sweep is a no-op.               |
| `BRAIN_MERGE_AUTO_HIGH_CONF_THRESHOLD` | `1.0`   | Minimum confidence for silent auto-merge.                  |
| `BRAIN_MERGE_AUTO_SUGGEST_THRESHOLD`   | `0.5`   | Minimum confidence for chat suggestion.                    |
| `BRAIN_MERGE_AUTO_DRY_RUN`             | `false` | Log would-merges and would-suggestions; perform no writes. |
| `BRAIN_MERGE_AUTO_NOTIFY_CHAT`         | `true`  | Set false to record suggestions silently (no chat reply).  |

Dry-run mode writes a JSON-line log to `~/.nanoclaw/logs/auto-merge-dry-run.log` for inspection. The existing `BRAIN_MERGE_AUTO_LOW_CONF_REJECT` placeholder in `.env.example` is removed — low-conf is unconditionally rejected in v1, so the gate has no behavior to control.

## Rollout / backfill

No dedicated backfill mode. The nightly sweep is the backfill on first run. Recommended sequence:

1. Deploy with `BRAIN_MERGE_AUTO_ENABLED=true` and `BRAIN_MERGE_AUTO_DRY_RUN=true`.
2. Wait for first nightly run (or manually invoke via `npm run brain:auto-merge`).
3. Inspect `~/.nanoclaw/logs/auto-merge-dry-run.log` for the would-merge list. Verify it looks sane.
4. Set `BRAIN_MERGE_AUTO_DRY_RUN=false`. Daily sweep takes over.

To avoid pathological lock time on the first real run, the sweep processes in chunks of 500 candidate pairs, releasing the SQLite write lock between chunks. The current production brain has on the order of a few thousand entities; a full pass is expected to complete in well under 5 seconds.

## Metrics

Emitted via the existing metrics module after each sweep:

- `auto_merge_high_conf_merged` (counter)
- `auto_merge_medium_conf_suggested` (counter)
- `auto_merge_low_conf_dropped` (counter)
- `auto_merge_suppressed_skipped` (counter — pairs skipped due to suppression rows)
- `auto_merge_sweep_duration_ms` (histogram)
- `auto_merge_dry_run_would_merge` (counter, dry-run only)

## Testing

Three layers, mirroring the chat-ingest test pattern from PR series:

1. **Classifier unit tests** (`src/brain/__tests__/auto-merge.test.ts`):
   - Phone normalization edge cases (`+1 (626) 348-3472` vs `16263483472` vs `+16263483472`).
   - Case-insensitive email match (`Alice@X.com` ≡ `alice@x.com`).
   - Whitespace-trimmed name match.
   - Conflicting-identifier short-circuit (same name, different signal_uuid → no match).
   - Empty `canonical->>'name'` produces no medium match.
   - Suppression row blocks both high and medium tiers.
2. **Sweep integration test** (same file or sibling): seed an in-memory DB with the fixture set, run `runAutoMergeSweep`, assert `entity_merge_log` has the high-conf rows, `entity_merge_suggestions` has the medium-conf rows, no rows written for low-conf, and metrics counters increment correctly.
3. **Handler test**: emit `entity.merge.suggested`, assert chat reply formatted correctly via mocked `setIdentityMergeReply`. Cover the case where `BRAIN_MERGE_AUTO_NOTIFY_CHAT=false` produces no reply.

The pre-existing concrete fixture (`Jonathan` × 2 in production) is preserved as a regression test — it must surface as a medium-conf suggestion, not a high-conf merge.

## Files touched

| File                                                     | Type | Approx LOC                                                 |
| -------------------------------------------------------- | ---- | ---------------------------------------------------------- |
| `src/brain/auto-merge.ts`                                | new  | ~250                                                       |
| `src/brain/__tests__/auto-merge.test.ts`                 | new  | ~200                                                       |
| `src/brain/schema.sql`                                   | edit | +30                                                        |
| `src/events.ts`                                          | edit | +25                                                        |
| `src/brain/identity-merge-handler.ts`                    | edit | +40                                                        |
| `src/brain/identity-merge.ts`                            | edit | +60 (`claw merge-reject` + `mergeEntities` lifecycle hook) |
| `src/task-scheduler.ts`                                  | edit | +15                                                        |
| `.env.example`                                           | edit | +5 / -1                                                    |
| `docs/superpowers/specs/2026-04-28-auto-merge-design.md` | new  | this file                                                  |

Total: ~615 LOC of new code + ~150 LOC of edits.

## Open questions

None. Anything not covered here is intentionally deferred to v2/v3 (see Non-goals).

## Future work (post-v1)

- **v2**: Real-time `entity.created` subscription for high-confidence tier. Requires emitting `entity.created` from the four INSERT sites in `src/brain/entities.ts`. Adds one DB lookup to the entity-creation hot path; latency budget is a few ms.
- **v2**: `claw suggestions` listing command — show all pending suggestions in chat, with abbreviated ids.
- **v2**: Time-bounded suppressions (`claw merge-reject <a> <b> --days=30`).
- **v3**: Splink / probabilistic fuzzy matching for low-tier name collisions if name-only duplicates become a problem in practice.
