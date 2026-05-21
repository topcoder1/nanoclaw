# Sprint Kickoff — How to start an autonomous sprint

This is the operator's manual. Read this when you (the human) want to fire a sprint.

For the team contract, see [`AGENTS.md`](../../AGENTS.md). For role-specific behavior, see `.claude/agents/{planner,implementer,integrator}.md`.

## ⚠️ Tier 3 gate — read before Step 1

nanoclaw is the highest-velocity repo in the fleet (~574 commits/mo). Before ANY sprint:

```bash
# Gate 1: concurrent worktrees
git worktree list | grep locked

# Gate 2: open agent PRs
gh pr list --state open --author @me --limit 20

# Gate 3: CI health
gh pr list --state open --json number,statusCheckRollup --jq '.[] | "\(.number) \(.statusCheckRollup[].state)"' | grep -c FAILURE
```

**Go/no-go:** fewer than 3 locked worktrees AND fewer than 3 open PRs on the candidate subsystem AND zero CI failures on open PRs.

**Best windows:** weekend mornings PT, or weekday evenings PT (after 7 PM). Avoid sprinting during active development sessions.

---

## The five-step recipe

### Step 1 — Write the sprint goal (5 min)

One paragraph. Concrete. Constraint-laden. Examples that decompose well for nanoclaw:

> "Add a `formatDuration(ms: number): string` utility to `src/utils/` that returns human-readable strings (e.g., `"2h 15m"`, `"45s"`). Used for logging and digest messages. Add table-driven tests covering zero, sub-second, minutes-only, hours+minutes, and very large values."

> "Improve test coverage in `src/brain/` for the embedding cache: add tests for cache miss, cache hit, TTL expiry, and concurrent writes. The cache implementation is in `src/brain/embedding-cache.ts`. Target: cover the four public methods."

> "Add a `truncateMiddle(s: string, maxLen: number): string` helper to `src/utils/` for display-truncating long filenames and URLs in log output. Add tests covering: already-short, exact-max, longer-than-max, odd/even maxLen."

Examples that do NOT decompose well (don't use):

- "Refactor the message routing loop" — too cross-cutting, touches `src/index.ts`
- "Fix the WhatsApp reconnection bug" — debugging mode, not sprint mode; investigate first
- "Add a new Telegram command" — touches `src/channels/telegram.ts` (Planner refusal path)
- "Update dependencies" — Dependabot owns this
- "Add OAuth to..." — auth surface (Planner refusal path)

### Step 2 — Run the Planner (15 min, mostly Opus thinking time)

From the repo root (NOT in a worktree — Planner reads top-level docs):

```bash
# In Claude Code: invoke the .claude/agents/planner.md agent with the goal paragraph.
# The Planner runs the Tier 3 gate check itself before decomposing.
```

Planner writes `.claude/sprints/<YYYY-MM-DD>-<slug>/SPEC.md`. Read it.

**Your review checklist:**

- [ ] `owns:` lists are file-disjoint across all tasks
- [ ] Every task has a runnable acceptance command (`npx vitest run ...`)
- [ ] Every task introduces or modifies at least one test
- [ ] Tasks are small (~50-200 LOC each)
- [ ] No task touches a refusal-list path (Planner should have refused; double-check)
- [ ] The DAG is correct — leaf tasks can actually run in parallel
- [ ] SPEC includes `Tier 3 check: passed`

If anything is wrong: edit SPEC.md yourself, or re-prompt the Planner with the issue.

### Step 3 — Dispatch implementers (parallel; mostly walk-away time)

For each task with no unmet dependencies, in parallel:

```bash
# Per task Tn:
cd ~/dev/nanoclaw
git fetch origin main
git worktree add .claude/worktrees/agent-impl-<N>-<slug> -b agent/impl-<N>/<slug> origin/main
# Then dispatch the implementer agent with:
#   - worktree path: .claude/worktrees/agent-impl-<N>-<slug>
#   - SPEC.md path: .claude/sprints/<YYYY-MM-DD>-<slug>/SPEC.md
#   - task_id: T<N>
```

**Recommended Tier 3 cadence:**

- First sprint (calibration): dispatch ONE implementer. Watch the first 5 turns. Then walk away.
- Once one full implementer loop succeeds end-to-end: two parallel implementers are safe.
- Cap at 2 parallel implementers per sprint until the pattern is battle-tested on this repo.
- Never dispatch during an active human coding session on the same subsystem.

### Step 4 — Monitor the inbox (passive)

You see nothing for clean PRs that auto-merge. You see:

- **Notifications** when a PR's CI is red and the implementer's local guard didn't catch it.
- **Notifications** when `claude-author-automerge.yml` flags a high-risk path.
- **AGENT_NOTES.md files** in the worktree dirs when an agent exited blocked.

Daily digest:

```bash
gh pr list --repo topcoder1/nanoclaw \
  --search "head:agent/ created:>$(date -v -1d +%Y-%m-%d)" \
  --json number,title,state,headRefName,mergedAt \
  --jq '.[] | "\(.state) #\(.number) \(.title) [\(.headRefName)]"'
```

### Step 5 — Sprint close (10 min)

After all implementer PRs reach a terminal state (merged or blocked):

1. Dispatch the Integrator (optional for single-task sprints; recommended for sprints ≥2 tasks).
2. The Integrator writes `docs/agents/sprints/<sprint-id>.md` and opens a doc PR.
3. You review the sprint summary, merge the doc PR.
4. Clean up worktrees:
   ```bash
   git worktree list
   git worktree remove .claude/worktrees/agent-impl-<N>-<slug> --force
   git branch -d agent/impl-<N>/<slug>
   ```

---

## Calibration sprint (run this first)

The very first sprint should be tiny and safe — a single implementer, a single task, one PR. The goal isn't to ship features; it's to prove the loop works on this repo.

**Suggested calibration goal for nanoclaw:**

> "Add a `truncateMiddle(s: string, maxLen: number): string` utility function to
> `src/utils/string-utils.ts` (create the file if it doesn't exist). The function
> truncates a string to `maxLen` characters, replacing the middle with `...` when
> needed. Add `src/__tests__/string-utils.test.ts` with table-driven tests covering:
> already-short string (no truncation), exact-maxLen (no truncation), one-char-over
> (truncation fires), very long string, maxLen=5 (minimum viable), even and odd maxLen."

This is:

- One small utility file + one test file
- Additive only — no existing code touched
- Zero blast radius
- Clear acceptance command: `npx vitest run src/__tests__/string-utils.test.ts`

**Before dispatching:** verify `src/utils/string-utils.ts` doesn't already exist:

```bash
ls src/utils/ 2>/dev/null | grep string
```

Watch the single loop end-to-end. Note what surprises you. Update AGENTS.md "Lessons logged here" accordingly. Then consider a two-task sprint.

---

## Failure recovery

| Symptom                                                     | First diagnosis                                       | Action                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| Implementer pushed red PR                                   | Local guard didn't catch it OR CI stricter than local | Read CI logs; re-dispatch with refined prompt if turn-budget exceeded |
| Two PRs touched same file                                   | Planner produced overlapping `owns:`                  | Fix SPEC.md; abandon both worktrees; re-dispatch                      |
| Implementer wrote AGENT_NOTES with `scope-expansion-needed` | Task under-specified                                  | Extend the `owns:` list and re-dispatch, or split into two tasks      |
| Implementer exited at turn 25 blocked                       | Task too large OR test wrong                          | Read AGENT_NOTES — usually faster to fix the last 10% yourself        |
| Integration test fails on main after merges                 | Cross-task regression CI missed                       | Investigate; may indicate planner missed runtime coupling             |
| Worktree has stale uncommitted files                        | Previous agent exited mid-run                         | `git worktree remove --force` and re-dispatch from clean              |
| Tier 3 gate fails (too many locked worktrees)               | Active concurrent sessions                            | Wait for cooldown, then re-attempt                                    |

---

## Missing: coverage gate

`coverage-floor.yml` is **not installed** on this repo. Until it is:

- Implementers must run `npx vitest run --coverage` and paste the summary in the PR body manually.
- Integrator must run the same and include the before/after in the sprint summary.
- When coverage-floor.yml is installed, update this doc and `AGENTS.md` with the floor value.

To install: `ci-install-coverage-floor topcoder1/nanoclaw` (see `~/.claude/templates/ci-workflows/`).

---

## Cost expectations (nanoclaw baseline — unverified until first sprint)

| Metric                          | Expected (based on mcp-whoisxmlapi calibration) |
| ------------------------------- | ----------------------------------------------- |
| Planner turns per sprint        | 4-8 (Opus, ~$0.50-2.00)                         |
| Implementer turns per task      | 12-25 (Sonnet, ~$0.20-1.00)                     |
| Integrator turns per sprint     | 6-12 (Sonnet, ~$0.30-0.80)                      |
| Total cost per 2-task sprint    | ~$2-5                                           |
| PRs reaching auto-merge cleanly | 50-70%                                          |
| Time-to-first-PR                | ~30 min for trivial, ~90 min for medium         |

Costs drop ~30% after week 1 due to prompt cache effects on the agent definition reads.
