# Archive / "Already handled" UX — Plan

**Date:** 2026-04-17
**Context:** [topcoder1/nanoclaw#12](https://github.com/topcoder1/nanoclaw/pull/12) shipped the first piece — a `✓ Already handled` button on agent Yes/No and financial-confirm cards. This plan covers the three remaining follow-ups identified during that review.

**Goal:** Let the user clear any pending item or notification with a single button click, regardless of card type, and have the triage system learn from those dismissals.

## Scope

| #   | Task                                                                   | Why                                                                       | Size |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| 1   | `✓ Already handled` on action-detector cards (RSVP, forward-to-person) | Consistency with question-detector cards shipped in PR #12                | S    |
| 2   | Archive / Handled on pure FYI notifications and digest items           | Biggest UX win — today FYI cards have no buttons at all                   | M    |
| 3   | Wire Handled clicks into the triage learning loop                      | Classifier learns which senders don't need surfacing; compounds over time | S    |

Deliberately out of scope:

- Changing Gmail archive behavior (user rule: no auto-archiving).
- Adding snooze/defer to FYI cards (covered by existing `handleSnooze`).
- Redesigning the digest format.

## Task 1 — Action-detector cards

### Design

Two cards currently lack a Handled option:

- **RSVP** — `src/action-detector.ts:111`: `✅ RSVP Yes` / `❌ Decline`
- **Forward-to-person** — `src/action-detector.ts:88`: `📨 Forward to {name}` / `❌ No`

Add a second-row `✓ Already handled` button to each, emitting `answer:{aid}:handled` so the existing callback-router branch handles it. No new callback kind.

### Implementation

1. [src/action-detector.ts](src/action-detector.ts) — append `{ label: '✓ Already handled', callbackData: \`answer:${aid}:handled\`, style: 'secondary', row: 1 }` to the RSVP and forward-person action arrays.

### Tests

1. [src/**tests**/action-detector.test.ts](src/__tests__/action-detector.test.ts) — extend existing RSVP and forward tests to assert `actions[last].label === '✓ Already handled'` and `row === 1`.
2. [src/**tests**/callback-router.test.ts](src/__tests__/callback-router.test.ts) — the `answer:q_abc:handled` test already covers the callback path; no new test needed.

**Acceptance:** `npx vitest run src/__tests__/action-detector.test.ts` passes; Telegram smoke — trigger an RSVP-style agent message, verify 3 buttons render with Handled on row 2.

---

## Task 2 — Handled on FYI cards and digest items

### Design

FYI items are surfaced in two places, neither with buttons today:

- **Digest blocks** — `src/digest-engine.ts:206` — text-only list of `📬 Source: Title` lines.
- **Real-time FYI pushes** — `container/skills/email-poll/SKILL.md` + SSE pipeline. The container agent currently sends plain text "Email · FYI" messages.

**Decision: start with real-time FYI only.** Digest items are already grouped and displayed compactly; adding per-item buttons would explode message length and hit Telegram's inline-keyboard limits. Real-time FYI is where clutter builds up.

**Key question: how does a Handled click find the `tracked_items.id` to resolve?**

Today's FYI cards are sent by the container agent as plain text — the host has no `tracked_item_id` associated with the Telegram message. Two paths:

- **Option A (heavier):** container tool returns a tracked_item_id; host stores a `telegram_message_id → tracked_item_id` mapping; Handled callback looks it up.
- **Option B (lighter, recommended):** container agent includes the tracked_item_id directly in the `callback_data` when it asks the host to attach buttons to a message. No new table.

Go with **Option B**. Requires:

1. A new host IPC handler `ipc.sendFyiWithButtons({ text, trackedItemId })` that sends the message and attaches a keyboard with `triage:archive:{id}` + `triage:dismiss:{id}` callbacks (both already handled in `callback-router.ts`).
2. A small helper the container-side email-poll skill calls when it classifies something as FYI. Today it emits a plain IPC message; upgrade to the new handler when a `trackedItemId` is available.

### Implementation

1. **Host side** — [src/ipc.ts](src/ipc.ts): add a new IPC task kind `send_fyi_card` that accepts `{ jid, text, trackedItemId }`, calls `telegramChannel.sendMessageWithButtons` with a two-button keyboard (`✓ Archive` / `✕ Dismiss`) on row 0. Thread it through `sendMessageWithButtons` exactly as action cards do.
2. **Callback router** — no changes. `triage:archive:<id>` and `triage:dismiss:<id>` are already wired in [src/callback-router.ts:598-603](src/callback-router.ts:598). Confirm the message keyboard clears on click (post-action UX).
3. **Container skill** — [container/skills/email-poll/SKILL.md](container/skills/email-poll/SKILL.md): document the new IPC shape so the agent prefers `send_fyi_card` when it has a tracked_item_id. No code change if the skill already exposes IPC generically.
4. **Button styling** — match existing triage card style (`primary` for archive, `secondary` for dismiss).

### Edge cases

- **No `trackedItemId` available** (e.g., pure informational push like "Gmail sync paused") → fall back to plain text, no buttons. Don't block the push on missing ID.
- **Item already resolved** before the user clicks → `handleTriageArchive` is idempotent; callback router just clears the keyboard and logs.
- **Stale message, tracked_item deleted** → `handleTriageArchive` looks up by id, no-ops if missing. Add a one-line log.

### Tests

1. [src/**tests**/ipc.test.ts](src/__tests__/ipc.test.ts) or a new `ipc-fyi-card.test.ts` — assert `send_fyi_card` task invokes `sendMessageWithButtons` with the correct keyboard shape.
2. [src/**tests**/callback-router.test.ts](src/__tests__/callback-router.test.ts) — `triage:archive:<id>` path already covered; add one test that verifies the keyboard is cleared after click (edit with `[]`).
3. [src/**tests**/telegram-callback-matrix.test.ts](src/__tests__/telegram-callback-matrix.test.ts) — extend coverage matrix with the new `send_fyi_card` → click archive flow.

**Acceptance:** New FYI push arrives with `[✓ Archive] [✕ Dismiss]` row; click Archive → item transitions to `resolved`, keyboard clears, digest no longer re-surfaces it.

---

## Task 3 — Wire Handled into the learning loop

### Design

Today's `answer:{qid}:handled` callback injects a reply to the agent but records nothing. The triage classifier never learns "user repeatedly dismisses Thumbtack FYIs → stop showing them." Close the loop by recording a negative example when Handled fires on an item whose classification path the triage engine owns.

The challenge: `answer:` callbacks currently don't know which `tracked_items.id` (if any) they correspond to. The question-detector fires on outbound agent text, not on a tracked_item.

**Decision:** Only record a learning example when the Handled click is for a `triage:` or `archive:` callback (Task 2 path) — not for `answer:*:handled`. The latter is a conversational signal; the former is a classification signal. Keep them separate to avoid polluting the example store with conversational dismissals.

This means Task 3 is actually wiring in the `triage:archive` and `triage:dismiss` callback branches, not the `answer:` branch.

Check [src/callback-router.ts:598](src/callback-router.ts:598) — the `triage:archive` branch already calls `handleTriageArchive` which already records a positive example (line `recordExample({ kind: 'positive', ..., userQueue: 'archive_candidate' })` in `queue-actions.ts:56`). **So Task 3 is already done for triage items.**

The actual remaining wiring: make sure the Task 2 FYI card uses the `triage:archive:<id>` callback (not a new `handled:<id>`) so it flows through the existing `handleTriageArchive` path and gets the learning example for free. That's already the plan in Task 2.

**Conclusion:** Task 3 collapses into Task 2. No separate work.

Optional stretch (out of scope this round): add a periodic report — "you archived 14 items from sender X this month; want to auto-skip?" — using `recordSkip` in `triage/prefilter.ts`. Not planned here.

---

## Execution order

1. Task 1 (15 min) — low risk, tight feedback loop, proves the pattern end-to-end.
2. Task 2 (1–2 hours) — bulk of the work, largely new IPC wiring.
3. Task 3 — verify learning examples get recorded on click of Task 2 buttons; one assertion in the integration test.

Each task lands as its own commit; PR bundles all three so reviewers see the full UX change together.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` full suite passes (currently ~700 tests)
- [ ] Manual Telegram smoke: RSVP card shows Handled on row 2; FYI push shows Archive/Dismiss; clicking Archive clears keyboard and item doesn't re-appear in next digest.
- [ ] DB check: after clicking Archive on FYI card, `SELECT state FROM tracked_items WHERE id = ?` returns `resolved`; `SELECT * FROM triage_examples WHERE tracked_item_id = ?` returns a `positive`/`archive_candidate` row.

## Risks

| Risk                                                                               | Mitigation                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram inline keyboard limit (100 buttons total, row width constrained)          | FYI cards only get 2 buttons; no scaling risk.                                                                                          |
| Container agent doesn't always have `tracked_item_id` at FYI emit time             | Fallback to text-only push; no degraded path for existing behavior.                                                                     |
| `triage:archive` callback already records positive example — double-recording risk | `handleTriageArchive` is idempotent; `recordExample` keys by `trackedItemId` so duplicate inserts are handled. Verify with a unit test. |
| Button-only push on FYI conflicts with existing plain-text FYI pipeline            | Keep both paths; agent picks `send_fyi_card` when `trackedItemId` is set, else plain text.                                              |

## Deferred / Not this round

- Per-item buttons in the digest block (explosion risk, low incremental value).
- "Never show me X sender again" button (nice UX but requires a skip-list confirmation flow; do separately).
- Undo after Archive (5-second undo toast). Worth considering if users report mis-clicks.
