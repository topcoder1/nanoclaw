# Brain recovery procedure

> Design authority: `.omc/design/brain-architecture-v2.md` §9.
> Run-book last verified: 2026-04-23 (P2 landing). Re-verify quarterly.

The augmented brain has two persistence surfaces and two recovery paths.

| Surface | Source of truth | Loss recovery path |
|---------|-----------------|--------------------|
| `store/brain.db` (SQLite) | primary store for KUs, entities, raw_events, cost, system_state | restore from `store/backups/brain-YYYY-MM-DD.db`, or — if no backup survives — re-derive via raw_events + legacy `store/messages.db` |
| Qdrant collection `ku_nomic-embed-text-v1.5_768` | embedded vectors only | re-embed from `brain.db` via `scripts/reembed-all.ts`, or restore from `store/qdrant-snapshots/` |

Backups run nightly (see `src/brain/backup.ts`):

- **02:00 local** — `brain.db` → `store/backups/brain-YYYY-MM-DD.db` (30-day retention).
- **02:15 local** — Qdrant snapshot → `store/qdrant-snapshots/<collection>-YYYY-MM-DD.snapshot` (14-day retention).

---

## Scenario 1: Qdrant lost (collection dropped, container wiped, etc.)

This is the *benign* scenario — the SQLite side retains every KU's text, so re-embedding is always possible.

```bash
# Start-of-task smoke
cd /path/to/nanoclaw
ls store/qdrant-snapshots/    # optional: restore a recent snapshot first

# Re-embed everything from brain.db into the active collection.
npx tsx scripts/reembed-all.ts
```

`scripts/reembed-all.ts` walks every live row in `knowledge_units` (superseded_at IS NULL), regenerates the Nomic 768-d vector, and upserts back to the active Qdrant collection. Output is idempotent — re-running is safe.

**Expected wall-time:** ~1 min per 1,000 KUs (CPU-bound by the embedding model).

**After restore:** run `reconcileQdrant()` (or the next scheduled tick) and confirm `driftRatio === 0`.

---

## Scenario 2: `brain.db` lost

This is the *severe* scenario — SQLite is the source of truth. Recovery uses whatever backup + raw_events are available.

### Step 1 — restore the most recent backup

```bash
ls -la store/backups/
cp store/backups/brain-YYYY-MM-DD.db store/brain.db
```

Verify schema compatibility:

```bash
npx tsx -e "import('better-sqlite3').then(m => { const d=new m.default('store/brain.db'); console.log(d.prepare('SELECT name FROM sqlite_master WHERE type=\\'table\\'').all()); })"
```

### Step 2 — replay any raw_events that arrived after the backup

If the brain has been running since the backup, new raw_events may be lost. Replay is partial only — the `knowledge_units` rows produced from them are gone, but the `raw_events` table itself was covered by the last `.backup()`. For gaps after the backup, there is nothing to replay.

### Step 3 — fall back to `store/messages.db`

The legacy `knowledge_facts` table (inside `store/messages.db`) is NOT deleted until `scripts/drop-legacy.ts --confirm` has been run. If recovery is needed while the legacy table still exists, re-run the migration:

```bash
npx tsx scripts/migrate-brain.ts
```

This is idempotent — it will re-insert only legacy rows that are missing.

### Step 4 — re-embed Qdrant

Once `brain.db` is whole, regenerate the vector store:

```bash
npx tsx scripts/reembed-all.ts
```

---

## Scenario 3: both lost (catastrophic)

Restore the most recent backup of each (they are taken within 15 minutes of each other), then run the reconcile loop once so any residual drift is surfaced and alerted via the weekly digest.

If no `brain.db` backup survives at all:

1. Create a new empty `brain.db` (happens automatically on next brain init).
2. Run `npx tsx scripts/migrate-brain.ts` to replay legacy `knowledge_facts` (if the legacy cutover has not yet happened).
3. Accept the gap for any data that existed only in the post-cutover brain.
4. Run `npx tsx scripts/reembed-all.ts` to re-populate Qdrant.

---

## Verifying a recovery

After any restore:

```bash
# Counts
npx tsx -e "import('./src/brain/metrics.js').then(m=>console.log(m.getBrainCounts()))"
# Reconcile
npx tsx -e "import('./src/brain/reconcile.js').then(m=>m.reconcileQdrant().then(console.log))"
# Weekly digest — makes any gap legible at a glance
npx tsx scripts/brain-weekly-digest.ts
```

Exit criteria: `getBrainCounts().kuLive` matches expectation, `reconcileQdrant().driftRatio === 0`, and the weekly digest shows no unexpected missing/orphan numbers.

---

## Tested quarterly

This procedure is walked through once a quarter on a copy of production data. Record the run in `system_state` under key `recovery_drill_at`. If the drill surfaces gaps, update this document the same day.
