# Discord & Signal → Brain Ingest — Design

**Date:** 2026-04-27
**Status:** Draft, awaiting approval

## Problem

NanoClaw's brain currently ingests knowledge from two sources: email (via `EmailReceivedEvent` → `src/brain/ingest.ts`) and notes (via `claw save`). Discord and Signal exist as IO channels (`src/channels/discord.ts`, `src/channels/signal.ts`) but their messages are not surfaced to the brain at all.

Two distinct gaps need closing:

1. **Connectivity** — Discord (`DISCORD_BOT_TOKEN`) and Signal (`SIGNAL_API_URL`, `SIGNAL_PHONE_NUMBER`) are not configured in the running deployment.
2. **Brain pathway** — there is no event flowing from a chat message into `raw_events` / extraction / KU.

## Goals

1. Connect Discord and Signal so messages reach NanoClaw end-to-end.
2. Add two ingest triggers from chat → brain:
   - **Manual**: 🧠 emoji-react on any message (works in any chat).
   - **Auto (window)**: opt-in per chat — accumulate a conversation burst, flush on idle/cap/daily, run extraction over the whole window.
3. Reuse the existing extraction pipeline (`extractPipeline` in `src/brain/extract.ts`) so chat-sourced knowledge ends up as ordinary `knowledge_units` with the same schema and retrieval path as email-sourced KUs.
4. Capture attachments alongside text — PDFs (text-extracted), images (referenced + optionally vision-tagged), voice notes (transcribed if `/add-voice-transcription` is enabled).
5. Cross-platform identity merge — same person on Discord, Signal, and email resolves to one entity.
6. Edits-after-flush sync — when a saved message or windowed message is edited within a sync window, supersede the original KU(s) cleanly using the existing `superseded_at` mechanism.

## Non-goals (v1)

- Voice channel real-time transcripts (Discord voice-channel audio). Voice-note attachments (Signal/Discord) are in scope when the existing voice-transcription skill is enabled.
- Auto-discovering identity merges. v1 is operator-asserted via config + admin command.
- Edit sync beyond `EDIT_SYNC_TTL_HOURS` (default 24h) after the original save.
- Slash-command auto-completion UX polish.
- A management UI for window or identity settings (config lives in YAML files).

## Research basis

A `mcp__video-research__research_deep` pass on chat→RAG patterns produced these load-bearing findings (full transcript in conversation history):

- Passive auto-ingest of full chat firehoses is fragile (Discord Message Content Intent gating, Signal automation hostility, vector-index noise dilution).
- Explicit triggers (slash command, emoji-react) plus per-chat opt-in auto-ingest is the pattern that survives in production.
- Embedding isolated chat messages destroys context; capture surrounding window or a window summary.
- Treat saves as immutable snapshots — don't try to keep the brain in sync with mutable chat state.

## Trigger UX

| Platform | Public group/channel | Private 1:1 with bot |
|---|---|---|
| Discord | 🧠 react (default); `/save` available with ephemeral response | `/save <text>`, or just send content |
| Signal  | 🧠 react (default) | reply `claw save`, or just send content |

Notes:
- The 🧠 emoji is the canonical trigger; configurable via `BRAIN_SAVE_EMOJI` env (default `🧠`).
- Discord `/save` invocations are visible in-channel; the bot's reply is ephemeral. Discord-DMs and 🧠-react are the discreet paths.
- Signal has no slash commands; the literal text `claw save` is visible to the chat. Discreet path on Signal is 🧠-react.

## Architecture

```
Discord ──┐                   ┌─ MessageReact 🧠 ──▶ ChatMessageSavedEvent ─┐
          ├─ src/channels/    │                                              │
Signal ───┘                   ├─ recent-msg cache (24h) ──── window flusher ─┼─▶ src/brain/ingest.ts
                              │                              (idle/cap/day)  │
                              └─ slash/text fallback         ──▶ ChatWindowFlushedEvent ─┘
```

### Components

#### 1. Recent-message cache (`src/chat-message-cache.ts`)

Small SQLite table — `chat_messages(platform, chat_id, message_id, sent_at, sender, text, attachments_json, reply_to_id, edited_at)` — feeding both triggers. TTL = `max(CHAT_CACHE_TTL_HOURS, EDIT_SYNC_TTL_HOURS)` (default 24h), pruned on a daily timer. Lives in the existing nanoclaw DB, not the brain DB.

The cache is necessary because:
- Signal reaction events deliver only `targetSentTimestamp`, not message body.
- Window flushers need to read N messages of context at flush time.
- Discord reaction events also benefit from a local lookup vs. fetching message-by-message.
- Edit-sync needs the *previous* version of a message to detect the change and locate the affected KU(s).

#### 2. Channel-side hooks

In `src/channels/discord.ts`:
- Subscribe to `Events.MessageCreate` (already present) → also write to `chat-message-cache` with attachments persisted to disk.
- Subscribe to `Events.MessageUpdate` (new) → update cache, set `edited_at`, emit `ChatMessageEditedEvent` (see §Edit sync).
- Subscribe to `Events.MessageReactionAdd` (new) → if emoji matches `BRAIN_SAVE_EMOJI`, look up the target in the cache and emit `ChatMessageSavedEvent`.
- Register a `/save` slash command (new) → emit `ChatMessageSavedEvent` with the provided text + an ephemeral reply.
- Required intents: `GuildMessageReactions`, `DirectMessageReactions` (non-privileged). `MessageContent` is already enabled today for the `@nano` trigger.

In `src/channels/signal.ts`:
- Existing message poller → also write to `chat-message-cache` and download attachments via `/v1/attachments/<id>`.
- Detect `dataMessage.reaction` events → if emoji matches, look up via `targetSentTimestamp` and emit `ChatMessageSavedEvent`.
- Detect text body matching `^claw save\b` (case-insensitive) → emit `ChatMessageSavedEvent` with the quoted message body if any, else the trailing text.
- Detect `dataMessage.editMessage` payloads (signal-cli surfaces these) → update cache, emit `ChatMessageEditedEvent`.
- Detect `dataMessage.remoteDelete` → emit `ChatMessageDeletedEvent`.

#### 2b. Attachment ingestion (`src/chat-attachments.ts`)

Stored under `data/chat-attachments/<platform>/<chat_id>/<message_id>/<filename>`. The `chat_messages.attachments` column holds a JSON array of `{ filename, mime, sha256, local_path, size_bytes }`.

Per-type handling at brain-ingest time (in the `ChatMessageSavedEvent` / `ChatWindowFlushedEvent` handlers):

| Type | Handling |
|---|---|
| `application/pdf` | Run `pdftotext` (already used by `/add-pdf-reader`); concatenate first 50 pages of text into the extraction input prefixed by `[Attachment: <filename>]`. |
| `image/*` | Default (`BRAIN_IMAGE_VISION=true`): single Claude Haiku vision call produces a one-sentence caption appended as `[Attachment image: <filename> — <caption>]`, plus EXIF date if present. If disabled, placeholder-only `[Attachment image: <filename>]`. |
| `audio/*` (voice notes) | If `/add-voice-transcription` skill is installed and `OPENAI_API_KEY` available, transcribe via Whisper; transcript is appended. Otherwise placeholder only. |
| Other (zip, docx, etc.) | Placeholder `[Attachment: <filename>, <size>]`; not extracted in v1. |

Attachments are kept on disk indefinitely (they are evidence). Cache eviction touches only the `chat_messages` index row; the attachment files survive and remain referenced from `knowledge_units.source_ref`.

Storage cost ceiling: a `BRAIN_ATTACHMENT_MAX_BYTES` env (default 25 MB per file) skips downloads above the threshold.

#### 3. Window flusher (`src/brain/window-flusher.ts`)

Per-`(platform, chat_id)` state machine living host-side, driven by a single `setInterval` tick. State is in-memory (not persisted across restarts — windows are short-lived; a restart simply forfeits the current open window).

Flush triggers (whichever fires first):
- **Idle** — no new message in the chat for `WINDOW_IDLE_MS` (default 15 min).
- **Cap** — message count in the open window reaches `WINDOW_CAP` (default 50).
- **Daily** — at `WINDOW_DAILY_FLUSH_HOUR` (default 23, local time), all open windows flush.

On flush:
1. Collect cached messages for the window range.
2. Concatenate into a single transcript with sender + timestamp.
3. Emit `ChatWindowFlushedEvent` with the transcript and metadata.

Opt-in is per-chat. Read from `groups/<name>/CLAUDE.md` frontmatter:

```yaml
---
brain_ingest: window     # one of: off (default), window
window_idle_min: 15      # optional override
window_cap: 50           # optional override
---
```

If a chat has no group (e.g., a Discord channel not registered as a group), default is `off`. We will not auto-create groups for arbitrary chats in v1.

#### 4. Event types (`src/events.ts`)

Four new events on the bus:

```ts
export interface ChatMessageSavedEvent extends NanoClawEvent {
  type: 'chat.message.saved';
  platform: 'discord' | 'signal';
  chat_id: string;
  chat_name?: string;
  message_id: string;            // platform-specific (snowflake or ts)
  sender: string;
  sender_display?: string;
  sent_at: string;               // ISO
  text: string;
  attachments?: ChatAttachment[];
  context_before?: { sender: string; text: string; sent_at: string }[];
  reply_to?: { sender: string; text: string; sent_at: string };
  trigger: 'emoji' | 'slash' | 'text';
}

export interface ChatWindowFlushedEvent extends NanoClawEvent {
  type: 'chat.window.flushed';
  platform: 'discord' | 'signal';
  chat_id: string;
  chat_name?: string;
  window_started_at: string;
  window_ended_at: string;
  message_count: number;
  transcript: string;            // formatted "[ts] sender: text\n..."
  message_ids: string[];         // for edit-sync lookups
  attachments?: ChatAttachment[];
  flush_reason: 'idle' | 'cap' | 'daily';
}

export interface ChatMessageEditedEvent extends NanoClawEvent {
  type: 'chat.message.edited';
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  edited_at: string;
  new_text: string;
}

export interface ChatMessageDeletedEvent extends NanoClawEvent {
  type: 'chat.message.deleted';
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  deleted_at: string;
}

export interface ChatAttachment {
  filename: string;
  mime: string;
  sha256: string;
  local_path: string;
  size_bytes: number;
}
```

All four are added to the union map in `EventTypes` so subscribers are typed.

#### 5. Brain ingest extension (`src/brain/ingest.ts`)

Today `ingest.ts` registers a single `eventBus.on('email.received', ...)` handler at startup. Add four more handlers in the same `start()` function:

- `eventBus.on('chat.message.saved', handleChatMessageSaved)` — single-message snapshot path.
- `eventBus.on('chat.window.flushed', handleChatWindowFlushed)` — window-summary path.
- `eventBus.on('chat.message.edited', handleChatMessageEdited)` — delegates to edit-sync (§7).
- `eventBus.on('chat.message.deleted', handleChatMessageDeleted)` — delegates to edit-sync (§7).

Both handlers:
1. Insert into `raw_events` with new `source_type` values: `'discord_message' | 'signal_message' | 'discord_window' | 'signal_window'`. Use `${chat_id}:${message_id}` (or `${chat_id}:${window_started_at}`) as `source_ref` so the existing UNIQUE constraint deduplicates retries.
2. Run `extractPipeline` on the text (single message) or the transcript (window). Window path uses a slightly different prompt that asks the LLM for distinct factual claims/decisions across the whole transcript rather than treating it as a single statement.
3. Map sender → entity using existing `createPersonFromEmail` / new `createPersonFromHandle` helper. Discord sender = `username#discriminator` or display name; Signal sender = phone number or profile name. These get their own alias namespace (`source_type='discord'` / `'signal'` in `entity_aliases`).
4. Insert `knowledge_units` + `ku_entities` + Qdrant upsert via the same code path as email today.

Account bucket: chat-sourced KUs default to `'personal'`. (Future: per-chat config could set `'work'`.)

`shouldSkipBrainExtraction` is currently email-specific; add a parallel `shouldSkipChatExtraction` that drops obvious noise (single emoji, message <8 chars without an attachment).

**Extraction pipeline adapter** — `extractPipeline` today (`extract.ts:452`) takes `ExtractInput { text, subject?, sender? }` and gates LLM extraction on a "signal score" cheap-rules tier calibrated for email patterns (money, deal IDs, Gong call IDs). Chat content will score near-zero and never reach the LLM tier. Two changes:

1. Extend `ExtractInput` with `mode?: 'email' | 'chat_single' | 'chat_window'` (default `'email'`, preserves current behavior).
2. When `mode` is a `chat_*` value: bypass the email-tuned signal-score gate (a 🧠-react is itself the signal that this is worth extracting; for windows, the operator opted-in the chat). Use a chat-specific extraction prompt that asks for distinct claims/decisions across the transcript and uses participant identifiers as candidate `who` mentions.

`window` mode also receives `participants: string[]` so the prompt can pre-list known speakers.

**Race resolution: 🧠-react inside an open window.** When a `ChatMessageSavedEvent` arrives for a chat that has `brain_ingest: window` and an open window covering the message:

1. The single-message save runs immediately (operator intent is explicit — they want this *now*).
2. The window flusher records the message_id in a per-window `excluded_message_ids: Set<string>`.
3. At flush time, transcript generation skips excluded ids. The window KU still summarizes everything else.

This avoids duplicate KUs while preserving both signals: the deliberate save and the surrounding context summary.

**`chat_id` → group lookup.** Discord channel ids and Signal group ids both already map to NanoClaw `groups/<name>/CLAUDE.md` files via the existing channel-registration logic (`dc:<channelId>` and `sig:group:<groupId>` JID conventions in `src/db.ts`'s `groups` table). The window flusher reads `groups.jid` → group name → reads YAML frontmatter from `groups/<name>/CLAUDE.md`. Chats with no registered group default to `brain_ingest: off`.

#### 6. Identity merge (`src/brain/identity-merge.ts`)

**Scope note**: the `entity_merge_log` table exists in `schema.sql:49` but no merge engine is implemented today (`grep -rn "mergeEntit\|entity_merge"` confirms zero call sites). Phase 7 includes writing this from scratch: alias re-pointing, KU re-linking on the canonical entity, conflict logging, and the audit row. Size accordingly.

**Entity-alias namespace** (resolves the `entity_aliases.field_name` ambiguity):

| Platform | field_name | field_value | Normalization |
|---|---|---|---|
| Discord | `discord_username` | lowercase canonical username (`alice`, post-pomelo) | strip `#discriminator` if present |
| Discord | `discord_snowflake` | numeric snowflake string | as-is |
| Signal | `signal_phone` | E.164 (`+15551234567`) | strip whitespace, ensure leading `+` |
| Signal | `signal_uuid` | UUID string | lowercase |
| Signal | `signal_profile_name` | display name | trim, NFC-normalize |

Both forms are written when available so YAML can reference either.

A new `createPersonFromHandle(platform, handle)` helper mirrors `createPersonFromEmail` (entities.ts:124): create a new `entities` row with `kind='person'`, insert one `entity_aliases` row with the appropriate `(field_name, field_value)`, return the entity id. Resolution at ingest time goes through `findEntityIdByAlias(field_name, field_value)`.

Same human shows up as different entities — `discord:alice#1234`, `signal:+15551234567`, `email:alice@example.com`. v1 makes this operator-driven, not auto-detected (research said auto is unreliable):

**A. YAML config — `groups/global/identity-merges.yaml`** (file-watched, hot-reloaded):

```yaml
people:
  - canonical: alice@example.com
    aliases:
      - discord:alice#1234
      - discord:123456789012345678         # snowflake form also supported
      - signal:+15551234567
      - signal:profile:Alice K.
  - canonical: bob@example.com
    aliases:
      - discord:bob_b
      - signal:+15559876543
```

On startup and on file change:
1. For each block, ensure the canonical entity exists; create it if missing.
2. For each alias, resolve or create the alias entity, then merge into the canonical via the existing entity-merge code path. Every merge writes a row to `entity_merge_log` (table already in `schema.sql:49`).
3. Subsequent ingest of `discord:alice#1234` resolves through `entity_aliases` to the canonical entity automatically — no per-handler logic needed.

**B. Admin command — `claw merge <alias> -> <canonical>`** (parsed by the existing main-group command path): one-shot merge that also appends a line to the YAML so the change persists.

**C. Conflict handling**: a merge that would unify two entities each holding distinct `entity_relationships` records is logged but executed (the merge log preserves the prior state for audit). No interactive resolution UI in v1.

**D. YAML validation at load**: reject the entire file (keep prior state) if any of the following fail, log a single structured error:
- Cycles (alias chain returns to a canonical).
- Same alias listed under two different canonicals (would silently steal entities on reload).
- Type mismatch — `aliases` not a list, `canonical` not a string, missing required keys.
- Canonical resolves to a non-`person` entity kind (e.g., a company alias being merged into a person).
Successful merges from prior loads are not rolled back; a bad reload simply doesn't add new ones.

#### 7. Edit & delete sync (`src/brain/edit-sync.ts`)

Subscribe to `chat.message.edited` and `chat.message.deleted`. The handler:

1. Look up `raw_events` rows whose `source_ref` references the affected message:
   - For single-message saves: `source_ref` exact match `${chat_id}:${message_id}`.
   - For windows: `source_ref` is `${chat_id}:${window_started_at}`, but `raw_events.payload` stores `message_ids[]` (added to the payload schema). Match by membership.
2. If the original `raw_events.received_at` is older than `EDIT_SYNC_TTL_HOURS` (default 24h), do nothing — it's outside the sync window. Log info.
3. Otherwise, for each affected `knowledge_unit` (joined via `(source_type, source_ref)`):
   - **On single-message edit**: re-run `extractPipeline(mode='chat_single')` on the new text, insert new KU rows, set `superseded_at = NOW()` and `superseded_by = <new_ku_id>` on the old rows. Qdrant points for old KUs are deleted; new ones upserted.
   - **On windowed-message edit**: rebuild the transcript with the edited message substituted (omitting any `excluded_message_ids`), re-run `extractPipeline(mode='chat_window')`, then supersede the entire prior window's KUs with the new set. This is the "wholesale window re-extract" path; cheaper than per-claim diffing and matches the snapshot model.
   - **On single-message delete**: set `superseded_at = NOW()` and `superseded_by = NULL` on affected KUs. Qdrant points deleted.
   - **On windowed-message delete**: rebuild the window transcript without the deleted message, re-run extraction, supersede the prior window's KUs. If the window had only one message and it's deleted, simply tombstone (set `superseded_at` with no replacement).
4. Existing retrieval already filters by `superseded_at IS NULL` per `idx_ku_superseded`, so superseded rows fall out of search automatically.
5. Append a row to a small `edit_sync_log` table for traceability (id generated via existing `newId()` from `src/brain/ulid.ts`):

```sql
CREATE TABLE IF NOT EXISTS edit_sync_log (
  id           TEXT PRIMARY KEY,         -- ULID via newId()
  occurred_at  TEXT NOT NULL,
  platform     TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  action       TEXT NOT NULL,            -- 'edit' | 'delete'
  affected_kus INTEGER NOT NULL,
  raw_event_id TEXT
);
```

Edits arriving after the TTL are deliberately ignored — keeps the brain stable and matches the immutability principle for old knowledge.

## Data flow examples

**Example 1: 🧠-react in a Discord channel**

```
12:01  Alice: should we move the launch to next Wednesday?
12:02  Bob:   yeah, that gives Marketing time to prep
12:03  Alice: ok let's call it — launch = next Wed
12:05  [you 🧠-react Alice's last message]
       ─▶ ChatMessageSavedEvent {
            text: "ok let's call it — launch = next Wed",
            context_before: [Alice@12:01, Bob@12:02],
            ... }
       ─▶ raw_events row (discord_message, "channel123:msg789")
       ─▶ extractPipeline → "Launch date moved to next Wednesday"
       ─▶ knowledge_unit + ku_entities(Alice, Bob)
       ─▶ Qdrant upsert
```

**Example 2: window flush on a Signal group with `brain_ingest: window`**

```
14:00–14:32  burst of 18 messages debating vendor selection
15:47        idle 15 min reached
             ─▶ ChatWindowFlushedEvent { transcript: "[14:00] ...\n...", reason: 'idle' }
             ─▶ raw_events row (signal_window, "group-xyz:2026-04-27T14:00")
             ─▶ extractPipeline (window prompt) → 2 claims:
                  "Decided to go with Vendor A for Q3"
                  "Vendor B rejected — pricing model incompatible"
             ─▶ 2 knowledge_units, both linked to participants
```

## Schema changes

`src/brain/schema.sql` — additions:

- **New column**: `ALTER TABLE knowledge_units ADD COLUMN superseded_by TEXT` (idempotent guarded migration in `db.ts`, mirroring the existing `important` column pattern). The current schema has only `superseded_at` (line 75). Forward-link from old → new KU is needed so retrieve-time we can show the replacement.
- **New table**: `edit_sync_log` (definition in §7).
- Reuse: `raw_events` (new `source_type` values), `knowledge_units.superseded_at` (already indexed at `idx_ku_superseded`), `entity_merge_log` (line 49 — table only; the merge engine itself is new code, see §6 scope note), `entity_aliases` (line 20).
- The `raw_events.payload` shape for window saves includes a `message_ids: string[]` field so edit-sync can locate windowed messages by membership.

One migration to the nanoclaw DB (not the brain DB) for the message cache:

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  platform     TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  sent_at      TEXT NOT NULL,
  sender       TEXT NOT NULL,
  sender_name  TEXT,
  text         TEXT,
  reply_to_id  TEXT,
  attachments  TEXT,                   -- JSON array of ChatAttachment
  edited_at    TEXT,                   -- last observed edit ts, NULL if untouched
  deleted_at   TEXT,                   -- soft-delete; row kept for edit-sync trace
  attachment_download_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_msg_chat_time
  ON chat_messages (platform, chat_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_chat_msg_prune
  ON chat_messages (sent_at);
```

## Configuration

New env vars (added to `.env.example`):

```
DISCORD_BOT_TOKEN=
SIGNAL_API_URL=http://localhost:18080
SIGNAL_PHONE_NUMBER=
BRAIN_SAVE_EMOJI=🧠
WINDOW_IDLE_MS=900000               # 15 min
WINDOW_CAP=50
WINDOW_DAILY_FLUSH_HOUR=23
CHAT_CACHE_TTL_HOURS=24
EDIT_SYNC_TTL_HOURS=24              # how long after save edits/deletes propagate
BRAIN_ATTACHMENT_MAX_BYTES=26214400 # 25 MB per file
BRAIN_IMAGE_VISION=true             # Haiku vision captions for image attachments
BRAIN_LLM_BUDGET_CHAT_PCT=30        # share of daily LLM budget reserved for chat
```

Per-chat opt-in lives in `groups/<name>/CLAUDE.md` YAML frontmatter (parsed at startup and on file-watch reload).

## Failure modes & handling

| Failure | Handling |
|---|---|
| Reaction fires but message not in cache (older than 24h) | Log warn, no save. Document as a known limit. |
| Signal poller drops connection | Existing reconnect logic; cached messages survive. Open window resumes on reconnect. |
| Discord rate limit on slash command response | Already handled by discord.js; ephemeral reply may be delayed but save still emits. |
| Extraction returns 0 claims for a window | Insert raw_events row with `processed_at` set so we don't retry; skip KU insert. Same as today's email-with-no-claims path. |
| Process restart with open window | Window flusher's `stop()` is wired into the existing `stopBrainIngest()` shutdown path. On SIGTERM it iterates open windows and emits `ChatWindowFlushedEvent` with `flush_reason='shutdown'` so in-flight context isn't lost. Hard crash still forfeits the buffer (acceptable v1). |
| Chat extraction starves email LLM budget | The shared daily LLM budget (`extract.ts:239`, default $0.05) is partitioned: `BRAIN_LLM_BUDGET_USD` (overall) plus `BRAIN_LLM_BUDGET_CHAT_PCT` (default 30%). Chat extraction calls check the chat slice; email retains its existing path. Both share the overall ceiling. |
| Attachment download fails | Cache row written without `local_path`; `attachment_download_attempts` counter incremented. A periodic retry sweep (every 30 min, capped at 3 attempts in the 24h window) re-tries pending downloads. After 3 failures, ingest proceeds with a `[Attachment unavailable: <filename>]` placeholder. |
| Two attachments with same content (sha256 collision) | `local_path` keyed by `sha256` so dedup is automatic; cache row references the shared path. |
| Edit/delete within `EDIT_SYNC_TTL_HOURS` | edit-sync pipeline supersedes the affected KU(s). |
| Edit/delete after `EDIT_SYNC_TTL_HOURS` | Ignored. Snapshot is immutable. Documented. |
| Attachment download fails | Cache row written without `local_path`; placeholder used in extraction; warn logged. Retry loop on next ingest cycle. |
| Attachment over `BRAIN_ATTACHMENT_MAX_BYTES` | Skip download; `[Attachment too large: <filename>, <size>]` placeholder in extraction. |
| Identity-merge YAML references unknown alias | Created on the fly during merge resolution; first-sighting metadata copied from canonical's bucket. |
| Identity-merge cycle in YAML (A→B, B→A) | Detected at load time; logged and the entire YAML is rejected (previous merges remain in place). |
| Bot reacts to its own 🧠 (loop risk) | Ignore reactions where `user_id == bot_user_id`. |
| Same message saved twice (react then `/save`) | `raw_events` UNIQUE on `(source_type, source_ref)` dedupes; second insert is a no-op. |

## Testing strategy

Unit:
- `chat-message-cache` insert/read/prune.
- Window flusher state machine — feed synthetic message timeline, assert flush on idle/cap/daily.
- Reaction handler — emoji match, bot-self ignore, cache miss.
- Slash/text fallback — payload extraction.

Integration (with mocked discord.js client and signal-cli HTTP):
- Discord: simulate `MessageReactionAdd` → assert `ChatMessageSavedEvent` emitted with correct context.
- Signal: simulate poller payload with reaction → same assertion.
- End-to-end: emit `ChatMessageSavedEvent` → assert `raw_events` row, KU created, Qdrant point upserted. Mirror the existing email-pipeline test.

No live-platform tests in CI — manual verification with the user's own Discord server / Signal account during rollout.

## Implementation phases

The work is large; each PR below is independently shippable and reviewable. Phases inside a PR are expected to land together.

**PR 1 — Cache, attachments, channel wiring, single-message ingest** (the minimum viable knowledge-from-chat path):

1. Foundation — `chat_messages` table, `chat-message-cache.ts` module.
2. Attachment store — `chat-attachments.ts`, per-type extraction adapters (PDF, image placeholder/vision, audio via voice-transcription if installed), retry sweep.
3. Discord wiring — `MessageCreate`, `MessageUpdate`, `MessageReactionAdd`, `/save` slash command, cache + attachment write.
4. Signal wiring — message poller persistence, `dataMessage.reaction`, `^claw save` text trigger, `editMessage`, `remoteDelete`, attachment fetch.
5. Brain ingest extension for `chat.message.saved` — `extractPipeline` `chat_single` mode, entity-alias namespace, `createPersonFromHandle`, KU + Qdrant via existing path. Includes the `superseded_by` migration.
6. Manual verification of the react / slash / `claw save` paths end-to-end.

**PR 2 — Window flusher + auto-ingest opt-in**:

7. Window flusher state machine, idle/cap/daily/shutdown flush.
8. `extractPipeline` `chat_window` mode + race resolution (`excluded_message_ids`).
9. `chat_id` → group lookup; YAML frontmatter parsing in `groups/<name>/CLAUDE.md`.
10. LLM budget partitioning (`BRAIN_LLM_BUDGET_CHAT_PCT`).
11. Verification on one opt-in chat.

**PR 3 — Identity merge engine**:

12. Merge engine (alias re-pointing, KU re-linking on canonical, conflict logging, audit row to `entity_merge_log`). The table exists; the engine is new.
13. `groups/global/identity-merges.yaml` loader with full validation (cycle / dup / type / kind checks).
14. Hot-reload watcher; rejects bad YAML without rolling back prior merges.
15. `claw merge <alias> -> <canonical>` admin command.

**PR 4 — Edit & delete sync**:

16. `edit_sync_log` table.
17. Handlers for `chat.message.edited` / `chat.message.deleted` (single + windowed paths).
18. Wholesale window re-extract on windowed edits/deletes.
19. Verification of edit / delete propagation within TTL.

## Open questions

None blocking. Documented for future work:
- Auto-suggesting identity merges from co-occurrence patterns (e.g., same display name across platforms with high overlap of conversation partners). Currently fully manual.
- Whether to surface a `/brainwindow flush <chat>` admin command for manual flush.
- Voice channel real-time transcription (Discord) — separate workstream.
- Image OCR (vs. vision captioning) when `BRAIN_IMAGE_VISION=true`.
- Re-ingesting historical chat from before this lands (backfill script analogous to `scripts/brain-backfill-skipped-emails.ts`).
