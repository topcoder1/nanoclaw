# ⚠️ TIER 3 INSTALL — SPRINT DISPATCH RESTRICTED ⚠️

This repo is the highest-velocity repo in the fleet (~574 commits/mo).
Multiple concurrent Claude Code sessions typically running. Bootstrap is installed,
but SPRINT DISPATCH IS HIGH-COLLISION-RISK.

Before firing any sprint:

1. **Concurrent-session check:** Run `git worktree list | grep locked` AND `gh pr list --state open --author @me`. If >2 locked worktrees OR >3 open PRs touching the candidate subsystem → WAIT for cooldown.
2. **Calibration only allowed in weekend or off-hours windows** when human session count is naturally lower.
3. **Multi-task sprints DEFERRED** until pattern has run on at least one less-hot repo first.

Planner refusal rule: refuses if `gh pr list --state open --author @me --limit 20` returns >2 PRs touching the proposed `owns:` files.

---

# Autonomous Agent Team — `nanoclaw`

This repo hosts an autonomous Claude Code agent team that ships PRs with minimal human supervision. This document is the **team contract**: the rules every agent (and every human dispatching agents) must follow.

If you are a human reading this: see `docs/agents/sprint-kickoff.md` for how to start a sprint.

If you are an agent reading this: this document is loaded into your context. Follow it.

## Why an agent team for this repo

`nanoclaw` is a TypeScript/Node.js personal Claude assistant orchestrator (~100+ source files). It manages channels (WhatsApp, Telegram, Slack, Discord, Gmail, iMessage), routes messages to Claude Agent SDK containers, and handles scheduling. Agent PRs can be validated with `npm run typecheck && npm test` before merging.

**IMPORTANT — Coverage gate not installed.** nanoclaw is missing `.github/workflows/coverage-floor.yml`. Future work: install `coverage-floor.yml` caller (see topcoder1/ci-workflows). Until then, agent team has no automated coverage signal — implementer must include test coverage data in each PR body manually using `npx vitest run --coverage`.

## The three roles

| Role                      | Model  | Definition file                 | Authority                                        |
| ------------------------- | ------ | ------------------------------- | ------------------------------------------------ |
| **Planner**               | Opus   | `.claude/agents/planner.md`     | Read-only; writes SPEC.md                        |
| **Implementer**           | Sonnet | `.claude/agents/implementer.md` | Edits within `owns:`; opens PR; **never merges** |
| **Integrator** (optional) | Sonnet | `.claude/agents/integrator.md`  | Read-only across worktrees; opens rollup PR      |

Reviewer is **not** an agent — it is the existing CI gate stack (`review / Claude Review` on PRs). The pre-existing `claude-author-automerge.yml` decides auto-merge vs. human inbox.

## Hard rules — non-negotiable

1. **Author/reviewer separation.** Implementers may not run `gh pr merge` or `gh pr review --approve`. The CI gate is the only merge path.
2. **Owns lists are file-disjoint.** No two concurrent agent tasks may share any path in their `owns:` lists.
3. **Worktree per agent.** Every implementer runs in a fresh worktree at `.claude/worktrees/agent-impl-<N>-<slug>/` on branch `agent/impl-<N>/<slug>` off `origin/main`.
4. **Pre-flight branch check.** Every implementer's first action is `git rev-parse --abbrev-ref HEAD`; if not on `agent/impl-*`, STOP. (See `~/.claude/CLAUDE.md` 2026-05-15 lesson.)
5. **Tier 3 rate limit.** Before dispatching any implementer, run the concurrent-session check in the Tier 3 warning at the top of this file.
6. **Scope discipline.** If an implementer needs to touch a file outside `owns:`, it writes `AGENT_NOTES.md` in the worktree with `status: needs-clarification` and STOPS. No silent scope expansion.
7. **maxTurns enforced.** Planner: 10 turns. Implementer: 25 turns. Integrator: 15 turns. On exhaustion: write `AGENT_NOTES.md` with `status: blocked` and exit.
8. **Plain-English summary required.** Every implementer PR body includes `HUMAN_READABLE_SUMMARY:` with 2-3 sentences explaining the change for future-you.

## Planner refusal list — high-risk paths

The Planner **refuses to decompose** any task touching these paths. It outputs a structured "needs human" report instead.

- `src/channels/` — channel integrations (WhatsApp, Telegram, Discord, Gmail, iMessage)
- `src/index.ts` — main orchestrator entry point and message loop
- `src/container-runner.ts`, `src/container-runtime.ts` — container spawning and lifecycle
- `src/config.ts` — trigger patterns, paths, system configuration
- `container/` — agent container filesystem and build scripts
- `.github/workflows/` — CI/release configuration
- `package.json`, `package-lock.json` — dependency surface (Dependabot owns this)
- `.env*`, `*.keys.json`, `repo-tokens/` — secrets and credentials
- `setup/`, `setup.sh` — installation scripts
- `launchd/`, `docker-compose*.yml` — service management / infra

## Implementer Bash restrictions

The implementer may invoke only:

**Allowed:** `git status|log|diff|add|commit|branch|checkout|worktree`, `npm run test|lint|typecheck|build`, `npx vitest|tsc|eslint|prettier`, `grep`, `find`, `cat`, `head`, `tail`, `ls`, `wc`, `gh pr create`, `gh pr view`, `gh pr diff`

**Denied:** `gh pr merge`, `gh pr review --approve`, `git push --force`, `git reset --hard`, `git checkout main`, `rm -rf`, `curl`, `wget`, `npm install -g`, `npm install` / `npm add` (new deps), `npx -y`, `npm publish`, `sudo`, `docker`, `pkill`

The deny list is enforced by self-restriction in the agent's system prompt. CI is the secondary enforcement: PRs that violate (e.g., modify `package.json` deps) fail review.

## Validation contract per task

Every Implementer task includes a single acceptance command in its SPEC.md block. The implementer does NOT open a PR until this command exits 0 AND the broader checks pass:

```bash
# 1. The task-specific acceptance (defined in SPEC.md per task)
npx vitest run --reporter=verbose src/__tests__/<TestFile>.test.ts

# 2. The repo-wide guard (always run before PR)
npm run typecheck          # npx tsc --noEmit — zero errors
npm run lint               # eslint src/ — zero errors
npm test                   # vitest run — no regressions
npx vitest run --coverage  # capture coverage (manual — no floor enforced yet)
```

If any of the repo-wide guards fail, the agent fixes them before opening a PR. If it cannot fix within turn budget: `AGENT_NOTES.md` + STOP.

## PR description template (implementer must populate)

```markdown
## Task

<task_id from SPEC.md> — <one-line description>

## Owned files

- path/to/file1
- path/to/file2

## Acceptance command + output

\`\`\`
npx vitest run --reporter=verbose src/**tests**/foo.test.ts
✓ foo test passes
\`\`\`

## Coverage (manual — no floor installed)

Before: <X statements covered> After: <Y statements covered>
Note: coverage-floor.yml not yet installed; run `npx vitest run --coverage` and paste summary.

## Auto-merge rationale

<one line: why this is safe to auto-merge, OR why it requires manual click>

## Codex pre-review

<PASS/FAIL + 1-2 sentence reasoning> (skipped for sub-50-LOC trivial changes)

## HUMAN_READABLE_SUMMARY

<2-3 plain English sentences: what changed and why, written so future-you can grep
for it without re-reading the diff>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Sprint kickoff flow

See `docs/agents/sprint-kickoff.md` for the step-by-step recipe.

## Lessons logged here

Agents must read this section before each sprint. New lessons are appended after each sprint.

_(No lessons yet — Tier 3 bootstrap installed 2026-05-20. First calibration sprint not yet run.)_
