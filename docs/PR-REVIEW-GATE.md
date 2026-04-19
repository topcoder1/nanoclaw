# PR Review Gate for source-of-truth paths

## Motivation

Most nanoclaw changes land on `main` directly: miniapp tweaks, UX
copy, prompt tuning, logging. Velocity > ceremony for that surface.

But a narrow set of files is **source of truth** for state that is not
trivially reversible:

- **`src/channels/gmail.ts`** — the only code that mutates Gmail
  (archive, drafts) or reads INBOX status. A bug here doesn't just
  flicker a UI — it archives the wrong thread, or fails to archive and
  leaves the reconciler chasing ghosts.
- **`src/triage/gmail-reconciler.ts`** — the loop that local-resolves
  items when Gmail says they've moved. A regression here flaps every
  tracked item forever, or silently stops resolving anything.
- **`src/triage/queue-actions.ts`** — the Telegram button dispatch
  that now calls Gmail before local resolve. Breaking the Gmail-first
  invariant here puts us back in the split-brain world we just fixed.

For these paths, main-direct commits are risky: a single bad push has
no second pair of eyes, and prod sees it within seconds of `git push`.

## Proposed flow

Branch → PR → `code-reviewer` agent → merge.

Concretely:

1. Create a topic branch (`fix/gmail-…`, `feat/reconciler-…`).
2. Push and open a PR against `main`.
3. Invoke the `code-reviewer` agent on the diff with focus on:
   - Does this preserve "Gmail is source of truth"? Every new archive
     code path must call `gmailOps.archiveThread` before any local
     state mutation, and must not local-resolve on Gmail failure.
   - Does the reconciler still only resolve after the race guard and
     (for 'missing' status) the transient-404 guard?
   - Are new DB writes guarded by `state IN ('queued','pushed','pending','held')`
     so already-resolved rows stay resolved?
4. Address any blockers, squash, merge.
5. Verify in prod: `curl /api/health/reconciler` is `ok` within 2
   min, and spot-check one archive from Telegram still hits Gmail.

## Out of scope

- Miniapp HTML/CSS, copy, logging
- Channels other than Gmail
- Tests under `src/__tests__/` (tests-only PRs can still land direct)
- Docs, skill metadata, configuration

The goal is narrow: the ~3 files above. Everything else keeps its
current cadence.

## Notes

- `code-reviewer` is an OMC agent. Run via Claude Code:
  "use code-reviewer to review this PR's diff against the Gmail
  source-of-truth invariants in docs/PR-REVIEW-GATE.md".
- For urgent hotfixes (prod is down), direct commit is still
  acceptable — but follow up with a retro-PR so a review happens
  asynchronously.
