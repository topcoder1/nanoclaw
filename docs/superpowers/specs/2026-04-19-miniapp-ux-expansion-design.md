# Mini-App UX Expansion Design Spec

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Scope:** Expand the email mini-app surface with canned replies, triage actions (Snooze, Unsubscribe, Mute thread), and manual agent-drafted replies (Quick / With prompt).

## Goal

Make the mini-app the single surface where email triage happens on mobile — no Gmail jumping for routine actions. The agent already drafts replies when it decides one is warranted; this spec adds the *other* cases: short human replies that don't need AI, triage decisions (snooze, silence, unsubscribe), and user-initiated AI drafting.

## Non-goals

- Raw from-scratch composition in the mini-app (still routes to Gmail via "Edit in Gmail")
- Agent browser-automation to find unsubscribe links in email bodies when headers are missing (v2)
- Dedicated "Muted threads" / "Snoozed items" list views (v1 shows in-session banners only)
- Cross-device state sync (single-user system)
- Folder/label management beyond Archive

## Clarifying-question answers (recap)

| # | Question | Answer |
|---|---|---|
| Q1 | Canned reply model | Option 3 — chips for trivial replies AND a `Draft with AI` path for substantive ones |
| Q2 | Triage actions in scope | Archive (existing), Snooze, Unsubscribe, Mute thread |
| Q3 | Draft-with-AI trigger | Option 4 — two buttons: `Quick draft` (no prompt) and `Draft with prompt` (intent input) |
| Q4 | Button layout | Option C (classification-driven primary row) + Option A fallback (`⋯ More` always reveals full set) |

## UX rule — classification → button set

Primary button row is driven by `tracked_items.classification` + a new `subtype` column. Mapping:

| Classification | Subtype | Primary row | Canned chips above |
|---|---|---|---|
| `push` | sender-is-human | `Quick draft` · `Draft with prompt` · `Archive` | ✅ `[Thanks] [Got it] [Will do]` |
| `push` | sender-is-bot | `Archive` · `Snooze` · `Open in Gmail` | — |
| `digest` | header has `List-Unsubscribe` | `Unsubscribe` · `Archive` · `Snooze` · `Mute` | — |
| `digest` | no `List-Unsubscribe` | `Archive` · `Snooze` · `Mute` · `Open in Gmail` | — |
| `transactional` | (any) | `Archive` · `Open in Gmail` | — |
| `ignore` / missing | (any) | `Archive` · `Open in Gmail` · `⋯ More` | — |

`⋯ More` is always rendered, always reveals the superset: every action available in any row plus `Open in Gmail`. This is the classifier-wrong escape hatch. One row is compact; two rows when expanded.

### Sender-is-human detection

Cheap heuristics, computed at tracking time, cached in `tracked_items.sender_kind` (new enum: `human`/`bot`/`unknown`, default `unknown`):

- **bot** if ANY: `Precedence: bulk` or `List-Id` or `List-Unsubscribe` header present; `From` local-part matches `^(no[-.]?reply|do[-.]?not[-.]?reply|bounce|notification[s]?|info|support|alert[s]?|team)$`; domain matches common ESP (`*.mailchimp.com`, `*.sendgrid.net`, `amazonses.com`, etc.)
- **human** otherwise — defaults to human when inconclusive; showing canned chips on a bot email is harmless (tap doesn't send until 10s undo elapses anyway).

### Transactional subtype

Derived at tracking time from Gmail category + sender + body keywords:

- Gmail `CATEGORY_UPDATES` or `CATEGORY_PROMOTIONS` → candidate
- Sender domain matches (Stripe, Square, Apple, Amazon, Shopify, Google Pay, banks, major SaaS)
- Body contains one of: `verification code`, `one-time code`, `2FA`, `your receipt`, `order confirmation`, `payment received`, `transaction`, `invoice`
- Any two of the three → `subtype='transactional'`

Stored as `tracked_items.subtype TEXT NULL`. Query branch in the server renders the right row without a second classifier call.

## Feature specs

### Snooze

**Table:**

```sql
CREATE TABLE snoozed_items (
  item_id TEXT PRIMARY KEY,
  snoozed_at INTEGER NOT NULL,
  wake_at INTEGER NOT NULL,
  original_state TEXT NOT NULL,
  original_queue TEXT,
  FOREIGN KEY (item_id) REFERENCES tracked_items(id) ON DELETE CASCADE
);
CREATE INDEX idx_snoozed_wake ON snoozed_items(wake_at) WHERE wake_at IS NOT NULL;
```

Schema change: add `'snoozed'` to the `tracked_items.state` CHECK constraint allowlist.

**Action flow:**

1. Tap `Snooze` → inline dropdown (not modal): `1 hour` · `Tomorrow 8am` · `Next Monday 8am` · `Next week` · `Custom…`
2. User picks → POST `/api/email/:id/snooze` with `{ duration: 'tomorrow-8am' | 'custom', wake_at?: ISOString }`
3. Server: validates (cap at 90 days), computes `wake_at` in `America/Los_Angeles`, UPSERTs `snoozed_items`, UPDATEs tracked_items `state='snoozed'`
4. Returns `{ ok: true, wake_at }`
5. UI swaps button row for banner: `💤 Snoozed until *Monday 8:00 AM* · [Unsnooze]`

**Wake-up mechanism — `src/triage/snooze-scheduler.ts` (new):**

`setInterval` tick every 60s:
1. `SELECT item_id, original_state, original_queue FROM snoozed_items WHERE wake_at <= ?`
2. For each: UPDATE tracked_items SET state=original_state, queue=original_queue; DELETE from snoozed_items
3. Emit `email.snooze.waked` → push-manager posts Telegram alert: `⏰ Reminder: <subject>`

Survives process restart (DB-backed state, not in-memory timers). 1-minute granularity is fine.

**Unsnooze (in-session only):**

Banner button → DELETE `/api/email/:id/snooze` → revert state immediately. No UI for snoozed items outside the originating session in v1.

**Edge cases:**
- Archive during snooze → `ON DELETE CASCADE` removes the snooze row; wake tick no-ops
- Re-snooze already snoozed → INSERT OR REPLACE; effectively extends
- Invalid duration → 400 `INVALID_DURATION`
- TZ: server uses process env (`TZ=America/Los_Angeles` per CLAUDE.md)

### Unsubscribe

**Route:** `POST /api/email/:id/unsubscribe`

**Method picker (in order of preference):**

1. **HTTPS one-click (RFC 8058):** `List-Unsubscribe: <https://...>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` → POST empty body to the URL with 5s timeout
2. **mailto:** `List-Unsubscribe: <mailto:...>` → `gmail.users.messages.send` with empty body, `To` = the mailto address, `Subject` = `unsubscribe`
3. **Legacy HTTPS GET:** URL present, no `One-Click` header → GET the URL with 5s timeout
4. **Fallback:** no header → UI shows `No unsubscribe link — [Open in Gmail]`, returns `{ ok: false, code: 'NO_UNSUBSCRIBE_HEADER' }`

**Safety rules:**
- Only `https://` and `mailto:` schemes; reject anything else
- Don't follow redirects to non-HTTPS
- Don't include the user's email in any POST body (some sites echo in responses)
- 5s timeout on network calls; beyond that, log + continue to archive

**Side effect:** regardless of remote status (unless 4xx/5xx with explicit non-retry guidance), archive the thread. Matches "I'm done with this sender" intent.

**Storage:** new table `unsubscribe_log`:

```sql
CREATE TABLE unsubscribe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT,
  status INTEGER,
  error TEXT,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX idx_unsub_item ON unsubscribe_log(item_id);
```

**UI:**
- Optimistic banner on tap: `📭 Unsubscribing…`
- Success → `✅ Unsubscribed and archived`
- Remote 4xx/5xx → amber banner: `⚠️ Unsubscribe may have failed — [Open in Gmail]`. Thread still archived (doesn't resurface).

### Mute thread

**Table:**

```sql
CREATE TABLE muted_threads (
  thread_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  reason TEXT
);
```

**Action flow (`POST /api/email/:id/mute`):**

1. Resolve `thread_id` + `account` from `tracked_items`
2. INSERT OR REPLACE into `muted_threads`
3. Cascade-resolve: UPDATE all `tracked_items WHERE thread_id = ? AND state != 'resolved'` to `state='resolved', resolution_method='mute:retroactive'`
4. Archive in Gmail via existing `gmailOps.archiveThread`
5. Return `{ ok: true }`
6. UI: `🔇 Muted · [Unmute]` banner (in-session)

**Intake filter — `src/triage/mute-filter.ts` (new):**

Hook into the SSE-to-tracked_items insert path in `src/email-sse.ts`. Before writing a new tracked_item:

```ts
const muted = db.prepare('SELECT 1 FROM muted_threads WHERE thread_id = ?').get(threadId);
if (muted) {
  logger.info({ thread_id: threadId, component: 'triage', event: 'muted_skip' }, 'Muted thread skipped');
  await gmailOps.archiveThread(account, threadId);
  return;  // don't insert, don't notify
}
```

One indexed SELECT per incoming email — negligible cost.

**Auto-unmute on user reply (v2, skip in v1):** if the Gmail reconciler sees a Sent-folder message in the thread, delete the `muted_threads` row.

**Unmute:** v1 only via in-session banner. Power-user path: direct DB edit or the future "Muted threads" view (v2).

**Invariant** (`scripts/qa/invariants.ts`): a `tracked_items` row with `thread_id` in `muted_threads` must be `state='resolved'`. Add as `muted-threads-never-visible`.

### Canned replies (chips)

**Rendered only when:** view mode + `classification='push'` + `sender_kind='human'`.

**Chip text:**

| Chip | Sent body |
|---|---|
| Thanks | `Thanks!\n\n{firstName}` |
| Got it | `Got it — thanks.\n\n{firstName}` |
| Will do | `Will do. Thanks,\n\n{firstName}` |

`{firstName}` resolved from `gmail.users.settings.sendAs.list().primarySendAs.displayName` split on space [0], cached per account in-memory at startup.

**Action flow (`POST /api/email/:id/canned-reply`):**

1. Body: `{ kind: 'thanks' | 'got_it' | 'will_do' }`
2. Server:
   a. `gmail.users.drafts.create` with the canonical body as a reply to the thread (preserves `In-Reply-To`, `References`)
   b. Record in existing `draft_originals` table for diff view consistency
   c. Schedule send via existing `PendingSendRegistry` (10s window)
   d. Return `{ ok: true, sendAt, draftId }`
3. UI: identical undo banner to the existing reply-send flow — "Sending in 10s · [Undo]"

Reuses the full reply-send machinery already landed in commit `0829804`. No new send infrastructure.

### Draft with AI (Quick + Prompt)

**Two entry points, one route:**

- `Quick draft` → POST `/api/email/:id/draft-with-ai` with `{}`
- `Draft with prompt` → inline textarea expands on tap (3 lines); submit → same route with `{ intent: string }`

**Server flow:**

1. Validate: `tracked_items` row exists; no concurrent draft task already running for this item
2. Resolve `account`, `thread_id`, incoming headers/body
3. Spawn a container task via existing `spawnAgentContainer` (from `src/container-runner.ts`) with a scoped prompt:

   ```
   You are drafting a Gmail reply for Jonathan.
   Thread context: <subject, from, latest body, last 3 messages>
   User intent: <intent string OR "No specific intent — use best judgment">

   Draft a reply using gmail.users.drafts.create on account <account> for thread <threadId>.
   Keep it concise, natural, and matching Jonathan's prior tone from the thread if he sent earlier messages.
   Return only the draft_id when done.
   ```

4. Immediately return `{ ok: true, taskId }` (don't block the HTTP request on the container)
5. UI polls `GET /api/draft-status/:taskId` every 1.5s
6. When container emits `email.draft.ready` event with `{ taskId, draftId }`, the poll returns `{ status: 'ready', draftId }`
7. UI client-side navigates to `/reply/<draftId>` (existing reply mode route — unchanged)

**Task timeout:** 45s. If no draft ready → poll returns `{ status: 'failed', error }` and UI shows "Agent couldn't draft — [Try again] [Open in Gmail]".

**Concurrency guard:** `active_draft_tasks` in-memory map keyed by `tracked_item_id`. Second Quick-draft tap while one is in flight is a no-op (UI disables button). If process restarts mid-task, the stale entry is just dropped; user can retap.

**Intent length cap:** 500 chars. Beyond that → 413 `INTENT_TOO_LONG`.

## Architecture summary

```
┌──────────────────────────────────────────────────────────────┐
│ Mini-app view                                                │
│  email-full.ts: context-aware primary row (by classification) │
│  ChipRow (human push only) · PrimaryRow · ⋯MoreRow            │
│  Banner slots: snooze, mute, unsubscribe-status               │
└────────────────────────┬─────────────────────────────────────┘
                         ↓ HTTP
┌──────────────────────────────────────────────────────────────┐
│ Mini-app server (src/mini-app/server.ts + actions.ts)         │
│  Existing:  /email/:id, /reply/:id, /api/draft/:id/save|send  │
│  NEW:                                                         │
│   POST /api/email/:id/snooze           {duration} → {wake_at} │
│   DELETE /api/email/:id/snooze         → restore              │
│   POST /api/email/:id/unsubscribe      → {method, archived}   │
│   POST /api/email/:id/mute             → {muted}              │
│   DELETE /api/email/:id/mute           → unmuted              │
│   POST /api/email/:id/canned-reply     {kind} → {draftId}     │
│   POST /api/email/:id/draft-with-ai    {intent?} → {taskId}   │
│   GET  /api/draft-status/:taskId       → {status, draftId?}   │
└────────────────────────┬─────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────────────┐
│ Backend services                                              │
│  snooze-scheduler (new, 60s tick)                             │
│  mute-filter (new, intake hook)                               │
│  unsubscribe-executor (new, list-unsub RFCs)                  │
│  Existing: GmailOps, PendingSendRegistry, draft-enrichment    │
│  Existing: spawnAgentContainer, event-bus                     │
└──────────────────────────────────────────────────────────────┘
```

### New files

| File | Purpose |
|---|---|
| `src/triage/mute-filter.ts` | SSE intake filter + cascade-resolve helper |
| `src/triage/snooze-scheduler.ts` | 60s ticker, wake-up, event emission |
| `src/triage/unsubscribe-executor.ts` | Header parse + method picker + HTTP/mailto exec |
| `src/triage/sender-kind.ts` | Human/bot heuristics + transactional detection |
| `src/mini-app/actions.ts` | All new route handlers (mount in server.ts) |
| `src/mini-app/templates/action-row.ts` | Context-aware primary-row + More-row renderer |
| `migrations/2026-04-19-ux-expansion.sql` | New tables + columns + CHECK updates |
| `src/__tests__/mini-app-actions.test.ts` | Route handler tests |
| `src/triage/__tests__/snooze-scheduler.test.ts` | Wake-tick tests |
| `src/triage/__tests__/mute-filter.test.ts` | Intake filter tests |
| `src/triage/__tests__/unsubscribe-executor.test.ts` | Method picker + exec tests |

### Modified files

| File | Change |
|---|---|
| `src/mini-app/server.ts` | Wire actions.ts routes; pass dependencies |
| `src/mini-app/templates/email-full.ts` | Replace static button row with `renderActionRow(classification, subtype, sender_kind)` |
| `src/email-sse.ts` | Call `muteFilter()` before tracked_items insert; also populate `sender_kind` + `subtype` |
| `src/tracked-items.ts` | Add `sender_kind` + `subtype` columns |
| `src/index.ts` | Start `snooze-scheduler` alongside existing reconcilers |
| `src/gmail-ops.ts` | Add `sendEmail(account, to, subject, body)` for mailto unsubscribe |
| `src/channels/gmail.ts` | Implement `sendEmail` via `gmail.users.messages.send` |
| `scripts/qa/invariants.ts` | Add `muted-threads-never-visible` predicate |

## Data flow — annotated examples

### 1. User taps `Snooze` on an attention email

```
Telegram webview → click Snooze button
  → inline dropdown renders
  → user picks "Tomorrow 8am"
    → POST /api/email/sse-xxx/snooze {duration: 'tomorrow-8am'}
      → server computes wake_at = tomorrow 8:00 local
      → UPSERT snoozed_items, UPDATE tracked_items.state = 'snoozed'
      → return {ok:true, wake_at: 1776749400000}
    ← UI: button row → "💤 Snoozed until Mon 8:00 AM · Unsnooze"

[14 hours pass]

snooze-scheduler tick
  → SELECT ... WHERE wake_at <= now()
  → UPDATE tracked_items.state = 'pushed'; DELETE snoozed_items row
  → eventBus.emit('email.snooze.waked', {itemId, subject, account})
  → push-manager → Telegram: "⏰ Reminder: Time to run payroll for Attaxion LLC"
```

### 2. User taps `Unsubscribe` on a digest email with modern header

```
email headers include:
  List-Unsubscribe: <https://news.example.com/unsub/abc123>
  List-Unsubscribe-Post: List-Unsubscribe=One-Click

POST /api/email/.../unsubscribe
  → unsubscribe-executor parses headers
  → picks RFC 8058 one-click path
  → fetch('https://...', {method: 'POST', body: '', timeout: 5000})
  → 200 OK
  → INSERT unsubscribe_log (method='one-click', status=200)
  → gmailOps.archiveThread(account, thread_id)
  → UPDATE tracked_items.state = 'resolved', resolution_method='mute:unsubscribe'
  → return {ok:true, method: 'one-click'}
← UI: banner "✅ Unsubscribed and archived"
```

### 3. User taps `Draft with prompt` + types "thanks but decline"

```
POST /api/email/.../draft-with-ai {intent: "thanks but decline politely"}
  → resolve account, thread_id, context
  → spawnAgentContainer(prompt with intent)
  → active_draft_tasks.set(itemId, taskId)
  → return {ok:true, taskId: 'task-abc'}

UI polls GET /api/draft-status/task-abc every 1500ms
  (status = 'running', 'running', 'running'...)

container agent:
  - reads thread via gmail.users.threads.get
  - crafts reply: "Thanks for the invite — I'll have to pass on this one..."
  - gmail.users.drafts.create({threadId, body})
  - INSERT draft_originals row (for existing diff view)
  - eventBus.emit('email.draft.ready', {taskId, draftId: 'r-456'})

next poll → {status: 'ready', draftId: 'r-456'}
UI navigates to /reply/r-456 (existing reply mode)
User reviews in textarea, taps Send, 10s undo, sent.
```

## Error handling

### Response shape — uniform

All new routes follow ISSUE-010's shape:

```ts
// success
{ ok: true, ...payload }
// error
{ ok: false, error: string, code: string }
```

### Codes

| Code | HTTP | Meaning |
|---|---|---|
| `ITEM_NOT_FOUND` | 404 | tracked_items row missing |
| `INVALID_DURATION` | 400 | Snooze duration parse failed or > 90 days |
| `INVALID_INTENT` | 400 | Draft-with-AI intent exceeded char cap |
| `NO_UNSUBSCRIBE_HEADER` | 422 | No List-Unsubscribe present |
| `UNSUBSCRIBE_REMOTE_FAILED` | 502 | Remote returned 5xx or timeout |
| `TASK_ALREADY_RUNNING` | 409 | Concurrent Draft-with-AI for same item |
| `TASK_TIMEOUT` | 504 | Draft-with-AI exceeded 45s |
| `GMAIL_API_ERROR` | 500 | Gmail API call failed |
| `ACCOUNT_NOT_REGISTERED` | 404 | account not in GmailOpsRouter |
| `INTERNAL` | 500 | Unknown server error |

### Optimistic vs pessimistic UI

| Action | Pattern | Reason |
|---|---|---|
| Snooze | Optimistic (banner immediately) | Reversible, fast |
| Mute | Optimistic | Reversible via Unmute |
| Archive | Optimistic (existing) | Reversible in Gmail |
| Unsubscribe | Pessimistic (show "sending" spinner) | External side effects |
| Canned reply | Pessimistic (10s undo banner) | Reuses reply-send UX |
| Draft-with-AI | Pessimistic (task spinner) | Long-running, observable |

### Out-of-UI failures

All actions that might fail asynchronously (unsubscribe remote, snooze wake, draft-with-AI task) emit events on the event bus; push-manager subscribes and posts a Telegram fallback notification when the user isn't watching the mini-app.

## Testing strategy

### Unit tests

**`src/triage/__tests__/snooze-scheduler.test.ts`:**
- Tick with no ready rows → no-op
- Tick with one ready row → restores state, deletes snooze row, emits event
- `wake_at` in future → skipped
- Multiple ready rows → all restored in one tick
- Restart mid-tick simulated via `scheduler.stop()` → state consistent

**`src/triage/__tests__/mute-filter.test.ts`:**
- `thread_id` in `muted_threads` → returns `true`, archives thread, skips insert
- Not muted → returns `false`, allows insert to proceed
- DB error on filter check → fail-open (log error, allow insert) so muting never breaks intake

**`src/triage/__tests__/unsubscribe-executor.test.ts`:**
- Headers with `One-Click` → picks RFC 8058 path, POSTs empty body
- Headers with mailto only → picks mailto path, calls `sendEmail`
- Headers with legacy HTTPS URL → GETs
- No headers → returns `NO_UNSUBSCRIBE_HEADER`
- Non-https/mailto scheme → rejected
- Network timeout → `UNSUBSCRIBE_REMOTE_FAILED` but still archives

**`src/triage/__tests__/sender-kind.test.ts`:**
- Bot heuristics: each header + regex triggers bot classification
- Ambiguous → `human` (default)
- Transactional subtype: each signal combination tested

### Route tests (`src/__tests__/mini-app-actions.test.ts`)

One happy path + one primary failure path per route. Covers:
- `POST /api/email/:id/snooze` + dropdown durations
- `DELETE /api/email/:id/snooze` unsnooze
- `POST /api/email/:id/unsubscribe` each method
- `POST /api/email/:id/mute` + cascade resolve
- `DELETE /api/email/:id/mute`
- `POST /api/email/:id/canned-reply` each kind
- `POST /api/email/:id/draft-with-ai` with and without intent
- `GET /api/draft-status/:taskId` states

### Integration test (`src/__tests__/miniapp-ux-expansion-integration.test.ts`)

End-to-end: fake Gmail + in-memory DB + mock container runner. Exercise:
- Snooze → 60s later wake fires → Telegram notification path
- Mute → next SSE intake for same thread is skipped
- Unsubscribe → remote endpoint hit once + archive landed
- Canned chip → draft created + send scheduled + undo works

### Invariant test

New predicate `muted-threads-never-visible` in `scripts/qa/invariants.ts`: asserts `∀ tracked_items t : t.thread_id IN (SELECT thread_id FROM muted_threads) ⟹ t.state = 'resolved'`.

### Coverage target

90%+ on all new files. Deliberately not tested: Gmail API itself (mocked), remote unsubscribe endpoints (mocked), container agent internals (integration test mocks spawn).

## Deliberately not done (v1 scope)

- Agent-browser-scraping for missing unsubscribe links (v2)
- Muted-threads / Snoozed-items list views (v2 — power-user queries DB for now)
- Auto-unmute on user reply (v2 — requires reconciler reply-detection)
- Snooze notification channel choice (always Telegram in v1)
- Multi-duration undo window on snooze/mute (10s hardcoded)
- Per-account default snooze preferences

## Implementation ordering

Recommended sequence for the writing-plans pass. Each step commits atomically.

1. **Migrations** — new tables (`muted_threads`, `snoozed_items`, `unsubscribe_log`), new columns (`tracked_items.sender_kind`, `tracked_items.subtype`), CHECK constraint update for `state='snoozed'`. No code yet.
2. **sender-kind + subtype detection** — pure function, unit tests, backfill script for existing rows.
3. **Mute thread** — smallest action, foundational (affects intake pipeline). Table is live from step 1; just ship the mute-filter + mute routes.
4. **Snooze** — scheduler + routes + UI dropdown. Wake-up tick tests.
5. **Unsubscribe** — executor + routes + UI banner states. Third-party mock tests.
6. **Context-aware action row template** — replaces static button row, uses all detection logic from step 2. Feature gate behind `UX_EXPANSION_ENABLED=1` until step 8 lands.
7. **Canned reply chips** — reuses existing draft-send machinery. Small addition.
8. **Draft with AI (Quick + Prompt)** — largest chunk; new container task type, polling endpoint, prompt UI. Ships last.
9. **Invariant test** — lands with step 3 (mute) but called out separately.
10. **Feature flag removal** — delete `UX_EXPANSION_ENABLED` gate after smoke testing in prod for 48h.

## Security / safety notes

- All new routes run behind CF Access — no change to auth posture
- Unsubscribe executor: scheme allowlist prevents `javascript:` / `data:` / `file:` URLs in malicious `List-Unsubscribe` headers
- Mute filter: fail-open so a DB blip can't silently break all incoming email; logs the error loudly
- Draft-with-AI: intent is injected into agent prompt — not escaped because the agent reads it as data, but we cap at 500 chars to prevent massive prompt bloat
- Snooze wake-up: attacker who compromises the DB could set `wake_at=0` and force immediate re-notification; same threat as writing to `tracked_items` directly, no new surface

## Rollout plan

1. Land steps 1-3 (migrations, detection, mute) — measurable improvement even alone
2. Ship steps 4-5 (snooze, unsubscribe) — the "new triage actions"
3. Ship step 6 (button template) with feature flag → observe
4. Ship steps 7-8 (canned replies, draft-with-AI) → full v1
5. Remove flag after 48h prod soak

Each step is independently useful; failure to land a later step doesn't regress earlier ones.
