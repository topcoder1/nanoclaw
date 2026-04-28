# Discord/Signal Brain Ingest — PR 4: Edit/Delete Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Signal/Discord chat message is edited or remote-deleted, locate the KU(s) derived from it and supersede them (edit) or tombstone them (delete), so the brain's view of conversations stays consistent with the source.

**Architecture:** Two new events on the bus: `chat.message.edited` and `chat.message.deleted`. The Signal channel grows handlers for `editMessage` / `remoteDelete` envelope fields; the Discord channel emits the same events from its `MessageUpdate` / `MessageDelete` listeners (which already update the cache but currently don't notify the brain). A new `chat-edit-sync.ts` subscribes to both events and walks `raw_events` looking for entries whose source_ref or `payload.message_ids[]` includes the edited/deleted `message_id`. For each match: re-extract from the new content (edit) or mark `superseded_at` + write a tombstone (delete). The `superseded_by` column already exists from PR 1.

**Tech Stack:** TypeScript, better-sqlite3, vitest, existing Pino logger, existing event bus.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/events.ts` | Add `ChatMessageEditedEvent` and `ChatMessageDeletedEvent` types + bus map entries |
| `src/channels/signal.ts` | Detect `editMessage` / `remoteDelete` in inbound envelopes; update cache; emit new events |
| `src/channels/discord.ts` | In existing `MessageUpdate` / `MessageDelete` listeners, after cache write, emit new events |
| `src/brain/chat-edit-sync.ts` | NEW — subscribe to edit/delete events, locate matching KUs via raw_events, supersede or tombstone |
| `src/brain/chat-ingest.ts` | Wire `startChatEditSync` / `stopChatEditSync` into existing start/stop |
| `src/brain/__tests__/chat-edit-sync.test.ts` | NEW — unit + integration tests for both edit and delete paths |
| `src/channels/__tests__/signal.test.ts` | Append tests for editMessage/remoteDelete envelope handling |
| `src/channels/__tests__/discord.test.ts` | Append tests for MessageUpdate/MessageDelete event emission |

---

## Task 1: `ChatMessageEditedEvent` + `ChatMessageDeletedEvent` types

**Files:**
- Modify: `src/events.ts`

- [ ] **Step 1: Append failing test** to `src/__tests__/events.test.ts` (create if missing — model on the existing `ChatWindowFlushedEvent` test):

```ts
import { describe, it, expect } from 'vitest';
import type { ChatMessageEditedEvent, ChatMessageDeletedEvent, NanoClawEventMap } from '../events.js';

describe('chat edit/delete event types', () => {
  it('ChatMessageEditedEvent has all required fields', () => {
    const evt: ChatMessageEditedEvent = {
      type: 'chat.message.edited',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'c1',
      message_id: 'm1',
      old_text: 'before',
      new_text: 'after',
      edited_at: '2026-04-28T00:00:00.000Z',
      sender: '+15551234567',
    };
    expect(evt.type).toBe('chat.message.edited');
  });

  it('ChatMessageDeletedEvent has all required fields', () => {
    const evt: ChatMessageDeletedEvent = {
      type: 'chat.message.deleted',
      source: 'discord',
      timestamp: Date.now(),
      payload: {},
      platform: 'discord',
      chat_id: 'c1',
      message_id: 'm1',
      deleted_at: '2026-04-28T00:00:00.000Z',
    };
    expect(evt.type).toBe('chat.message.deleted');
  });

  it('event map includes both new event types', () => {
    type _checkEdited = NanoClawEventMap['chat.message.edited'];
    type _checkDeleted = NanoClawEventMap['chat.message.deleted'];
    expect(true).toBe(true); // type-only check
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/events.test.ts -t "edit/delete"` — expect FAIL ("ChatMessageEditedEvent does not exist").

- [ ] **Step 3: Add types** to `src/events.ts`. Find the `ChatWindowFlushedEvent` interface (around line 756) and append immediately after it:

```ts
/**
 * Emitted when a previously-cached chat message is edited remotely.
 * Carries enough context for chat-edit-sync to locate KUs derived from
 * this message_id (single-message and windowed) and supersede them with
 * a re-extraction from `new_text`.
 */
export interface ChatMessageEditedEvent extends NanoClawEvent {
  type: 'chat.message.edited';
  source: 'discord' | 'signal';
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  old_text: string | null; // pre-edit text from cache (null if cache was evicted)
  new_text: string;
  edited_at: string; // ISO timestamp from the platform
  sender: string;
}

/**
 * Emitted when a chat message is remote-deleted. The chat-edit-sync
 * handler looks up matching KUs and tombstones them (sets superseded_at,
 * inserts a marker KU referencing the deletion).
 */
export interface ChatMessageDeletedEvent extends NanoClawEvent {
  type: 'chat.message.deleted';
  source: 'discord' | 'signal';
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  deleted_at: string;
}
```

Then find the `NanoClawEventMap` (around line 844) and add two entries:

```ts
  'chat.message.edited': ChatMessageEditedEvent;
  'chat.message.deleted': ChatMessageDeletedEvent;
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/events.test.ts -t "edit/delete"` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/__tests__/events.test.ts
git commit -m "feat(events): ChatMessageEditedEvent + ChatMessageDeletedEvent types"
```

---

## Task 2: Signal channel — detect editMessage and emit `chat.message.edited`

**Files:**
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/__tests__/signal.test.ts`

The `DataMessage.editMessage` type is already declared (line 38–41). What's missing: a handler that reads `targetSentTimestamp`, looks up the original message in cache, updates the cache row, and emits a `ChatMessageEditedEvent`.

- [ ] **Step 1: Append failing test** at the end of `src/channels/__tests__/signal.test.ts` (inside the existing `describe('Signal', ...)` block, before the closing `});`):

```ts
  it('inbound editMessage emits chat.message.edited and updates cache', async () => {
    const events: ChatMessageEditedEvent[] = [];
    eventBus.on('chat.message.edited', (e) => events.push(e));
    // Pre-cache an "original" message so the edit can find it.
    mockGetChatMessage.mockReturnValueOnce({
      platform: 'signal',
      chat_id: 'group-X',
      message_id: '9999',
      sent_at: '2026-04-27T00:00:00.000Z',
      sender: 'alice',
      text: 'original text',
    });
    const env = {
      source: 'alice',
      sourceNumber: '+15551234567',
      sourceName: 'Alice',
      timestamp: Date.now(),
      dataMessage: {
        timestamp: Date.now(),
        editMessage: {
          targetSentTimestamp: 9999,
          dataMessage: { message: 'edited text' },
        },
        groupInfo: { groupId: 'group-X', type: 'DELIVER' },
      },
    };
    await channel.handleEnvelope(env as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat.message.edited',
      platform: 'signal',
      chat_id: 'sig:group:group-X',
      message_id: '9999',
      old_text: 'original text',
      new_text: 'edited text',
    });
    expect(mockPutChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: '9999',
        text: 'edited text',
        edited_at: expect.any(String),
      }),
    );
  });
```

(If `mockGetChatMessage` isn't set up in the test file, follow the same pattern already used for `mockPutChatMessage` in the existing tests.)

- [ ] **Step 2: Run** `npx vitest run src/channels/__tests__/signal.test.ts -t "editMessage"` — expect FAIL.

- [ ] **Step 3: Add handler** in `src/channels/signal.ts`. Find the inbound message branch (where `putChatMessage` is called around line 234). After that block but before the agent-routing block, insert:

```ts
    if (dataMsg.editMessage) {
      const targetTs = dataMsg.editMessage.targetSentTimestamp;
      const originalId = String(targetTs);
      const newText = dataMsg.editMessage.dataMessage.message ?? '';
      const cached = getChatMessage('signal', chatId, originalId);
      const editedAtIso = new Date(envelope.timestamp).toISOString();
      // Update cache (idempotent UPSERT).
      putChatMessage({
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        sent_at: cached?.sent_at ?? editedAtIso,
        sender: sourceJid,
        sender_name: envelope.sourceName,
        text: newText,
        edited_at: editedAtIso,
      });
      // Emit so chat-edit-sync can supersede derived KUs.
      eventBus.emit('chat.message.edited', {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: envelope.timestamp,
        payload: {},
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        old_text: cached?.text ?? null,
        new_text: newText,
        edited_at: editedAtIso,
        sender: sourceJid,
      } satisfies ChatMessageEditedEvent);
      return;
    }
```

(Add `import { eventBus } from '../event-bus.js';` if not already imported, and `import type { ChatMessageEditedEvent } from '../events.js';`.)

- [ ] **Step 4: Run** the test — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/__tests__/signal.test.ts
git commit -m "feat(signal): emit chat.message.edited on editMessage envelopes"
```

---

## Task 3: Signal channel — detect remoteDelete and emit `chat.message.deleted`

**Files:**
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/__tests__/signal.test.ts`

`DataMessage.remoteDelete = { timestamp: number }` — the timestamp identifies the original message.

- [ ] **Step 1: Append failing test**:

```ts
  it('inbound remoteDelete emits chat.message.deleted and tombstones cache', async () => {
    const events: ChatMessageDeletedEvent[] = [];
    eventBus.on('chat.message.deleted', (e) => events.push(e));
    const env = {
      source: 'alice',
      sourceNumber: '+15551234567',
      timestamp: Date.now(),
      dataMessage: {
        timestamp: Date.now(),
        remoteDelete: { timestamp: 9999 },
        groupInfo: { groupId: 'group-X', type: 'DELIVER' },
      },
    };
    await channel.handleEnvelope(env as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat.message.deleted',
      platform: 'signal',
      message_id: '9999',
    });
    expect(mockPutChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: '9999',
        deleted_at: expect.any(String),
      }),
    );
  });
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add handler** in `src/channels/signal.ts` immediately after the editMessage block from Task 2:

```ts
    if (dataMsg.remoteDelete) {
      const targetTs = dataMsg.remoteDelete.timestamp;
      const originalId = String(targetTs);
      const deletedAtIso = new Date(envelope.timestamp).toISOString();
      const cached = getChatMessage('signal', chatId, originalId);
      // Tombstone the cache row.
      putChatMessage({
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        sent_at: cached?.sent_at ?? deletedAtIso,
        sender: cached?.sender ?? sourceJid,
        sender_name: cached?.sender_name ?? envelope.sourceName,
        text: cached?.text ?? null,
        deleted_at: deletedAtIso,
      });
      eventBus.emit('chat.message.deleted', {
        type: 'chat.message.deleted',
        source: 'signal',
        timestamp: envelope.timestamp,
        payload: {},
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        deleted_at: deletedAtIso,
      } satisfies ChatMessageDeletedEvent);
      return;
    }
```

(Add `import type { ChatMessageDeletedEvent } from '../events.js';`.)

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/__tests__/signal.test.ts
git commit -m "feat(signal): emit chat.message.deleted on remoteDelete envelopes"
```

---

## Task 4: Discord channel — emit `chat.message.edited` from MessageUpdate

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/__tests__/discord.test.ts`

The Discord channel already updates the cache on `MessageUpdate` (around line 195). We just need to also emit the event.

- [ ] **Step 1: Append failing test** to `src/channels/__tests__/discord.test.ts`:

```ts
  it('MessageUpdate emits chat.message.edited with old_text from cache', async () => {
    const events: ChatMessageEditedEvent[] = [];
    eventBus.on('chat.message.edited', (e) => events.push(e));
    mockGetChatMessage.mockReturnValueOnce({
      platform: 'discord',
      chat_id: 'channel-1',
      message_id: 'msg-1',
      sent_at: '2026-04-27T00:00:00.000Z',
      sender: 'user-1',
      text: 'before',
    });
    const oldMessage = { id: 'msg-1', channelId: 'channel-1' };
    const newMessage = {
      id: 'msg-1',
      channelId: 'channel-1',
      author: { id: 'user-1', username: 'alice', bot: false },
      content: 'after',
      createdAt: new Date('2026-04-27'),
      editedAt: new Date('2026-04-28'),
      member: null,
    };
    await client.emit('messageUpdate', oldMessage, newMessage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat.message.edited',
      platform: 'discord',
      chat_id: 'channel-1',
      message_id: 'msg-1',
      old_text: 'before',
      new_text: 'after',
    });
  });
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Modify** the `MessageUpdate` listener in `src/channels/discord.ts` (around line 195). After the existing `putChatMessage({...})` call, insert:

```ts
      const cachedBefore = getChatMessage(
        'discord',
        message.channelId,
        message.id,
      );
      // (cachedBefore was the OLD row; we just overwrote it via putChatMessage.
      // For old_text, fetch BEFORE putChatMessage instead.)
```

Actually, restructure the listener body to fetch cache first, then update, then emit:

```ts
    this.client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      let message = newMessage;
      if (message.partial) {
        try {
          message = await message.fetch();
        } catch {
          return;
        }
      }
      if (message.author?.bot) return;
      const previous = getChatMessage('discord', message.channelId, message.id);
      const editedAtIso =
        message.editedAt?.toISOString() ?? new Date().toISOString();
      putChatMessage({
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        sent_at: message.createdAt.toISOString(),
        sender: message.author?.id ?? 'unknown',
        sender_name: message.member?.displayName ?? message.author?.username,
        text: message.content,
        edited_at: editedAtIso,
      });
      eventBus.emit('chat.message.edited', {
        type: 'chat.message.edited',
        source: 'discord',
        timestamp: Date.now(),
        payload: {},
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        old_text: previous?.text ?? null,
        new_text: message.content ?? '',
        edited_at: editedAtIso,
        sender: message.author?.id ?? 'unknown',
      } satisfies ChatMessageEditedEvent);
    });
```

(Add `import type { ChatMessageEditedEvent } from '../events.js';` at the top.)

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord.ts src/channels/__tests__/discord.test.ts
git commit -m "feat(discord): emit chat.message.edited on MessageUpdate"
```

---

## Task 5: Discord channel — emit `chat.message.deleted` from MessageDelete

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/__tests__/discord.test.ts`

If a `MessageDelete` listener already exists, modify it. If not, add one.

- [ ] **Step 1: Append failing test**:

```ts
  it('MessageDelete emits chat.message.deleted', async () => {
    const events: ChatMessageDeletedEvent[] = [];
    eventBus.on('chat.message.deleted', (e) => events.push(e));
    const message = { id: 'msg-1', channelId: 'channel-1' };
    await client.emit('messageDelete', message);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat.message.deleted',
      platform: 'discord',
      chat_id: 'channel-1',
      message_id: 'msg-1',
    });
  });
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add listener** in `src/channels/discord.ts` immediately after the `MessageUpdate` listener (find the closing `});` of the update handler and add a new block):

```ts
    this.client.on(Events.MessageDelete, async (message) => {
      const deletedAtIso = new Date().toISOString();
      const cached = getChatMessage(
        'discord',
        message.channelId,
        message.id,
      );
      // Tombstone cache row.
      if (cached) {
        putChatMessage({
          ...cached,
          deleted_at: deletedAtIso,
        });
      }
      eventBus.emit('chat.message.deleted', {
        type: 'chat.message.deleted',
        source: 'discord',
        timestamp: Date.now(),
        payload: {},
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        deleted_at: deletedAtIso,
      } satisfies ChatMessageDeletedEvent);
    });
```

(Add `import type { ChatMessageDeletedEvent } from '../events.js';`.)

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord.ts src/channels/__tests__/discord.test.ts
git commit -m "feat(discord): emit chat.message.deleted on MessageDelete"
```

---

## Task 6: `chat-edit-sync` — locate KUs by message_id

**Files:**
- Create: `src/brain/chat-edit-sync.ts`
- Create: `src/brain/__tests__/chat-edit-sync.test.ts`

Helper that walks `raw_events` for a given `(platform, message_id)` and returns the candidate rows. Single-message rows have `source_ref = '<chat_id>:<message_id>'`; windowed rows carry `message_ids[]` inside `payload`.

- [ ] **Step 1: Failing test**:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() { return tmp; },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import { findRawEventsForMessage } from '../chat-edit-sync.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-edit-sync-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chat-edit-sync — findRawEventsForMessage', () => {
  it('finds single-message raw_events by source_ref suffix', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_message', ?, ?, ?)`,
    ).run('r1', 'group-X:msg-1', Buffer.from('{}'), '2026-04-27T00:00:00Z');
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_message', ?, ?, ?)`,
    ).run('r2', 'group-X:msg-2', Buffer.from('{}'), '2026-04-27T00:00:00Z');

    const hits = findRawEventsForMessage(db, 'signal', 'group-X', 'msg-1');
    expect(hits.map((r) => r.id)).toEqual(['r1']);
  });

  it('finds windowed raw_events when payload.message_ids includes the id', () => {
    const db = getBrainDb();
    const evtPayload = JSON.stringify({
      message_ids: ['msg-1', 'msg-2', 'msg-3'],
    });
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, 'signal_window', ?, ?, ?)`,
    ).run('w1', 'group-X:2026-04-27T00:00:00.000Z', Buffer.from(evtPayload), '2026-04-27T00:00:00Z');
    const hits = findRawEventsForMessage(db, 'signal', 'group-X', 'msg-2');
    expect(hits.map((r) => r.id)).toEqual(['w1']);
  });

  it('returns empty when no match', () => {
    const db = getBrainDb();
    const hits = findRawEventsForMessage(db, 'discord', 'no-chan', 'no-msg');
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** — expect FAIL (`chat-edit-sync.ts` doesn't exist).

- [ ] **Step 3: Implement** `src/brain/chat-edit-sync.ts`:

```ts
/**
 * Edit/delete sync for chat-derived KUs.
 *
 * Subscribes to chat.message.edited and chat.message.deleted. For each
 * event, walks raw_events to find rows whose source_ref or payload's
 * message_ids[] includes the changed message. For each match:
 *   - edit  → mark all dependent KUs superseded_at=now, then re-run
 *             extractPipeline on the new content and insert fresh KUs
 *             with superseded_by populated on the OLD ones.
 *   - delete → mark all dependent KUs superseded_at=now and write a
 *              deletion-marker raw_event so the audit trail is complete.
 *
 * Best-effort against Qdrant: failures log warn, SQLite stays authoritative.
 */

import type Database from 'better-sqlite3';
import { eventBus } from '../event-bus.js';
import type {
  ChatMessageDeletedEvent,
  ChatMessageEditedEvent,
} from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';

export interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  payload: Buffer;
  received_at: string;
}

/**
 * Find raw_events that derived from the given chat message.
 *
 * Two cases:
 *   1. `<platform>_message` rows: source_ref shape is `<chat_id>:<message_id>`.
 *   2. `<platform>_window` rows:  source_ref shape is `<chat_id>:<window_started_at>`,
 *      and message_id appears in payload.message_ids[].
 *
 * The query uses LIKE on source_ref (cheap) for case 1, and LIKE on the JSON
 * payload as a quick first-pass filter for case 2 (then JSON-parses to confirm).
 */
export function findRawEventsForMessage(
  db: Database.Database,
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): RawEventRow[] {
  const messageType = `${platform}_message`;
  const windowType = `${platform}_window`;
  const singleSourceRef = `${chat_id}:${message_id}`;
  // Case 1: single-message rows with exact source_ref.
  const singles = db
    .prepare(
      `SELECT id, source_type, source_ref, payload, received_at
       FROM raw_events
       WHERE source_type = ? AND source_ref = ?`,
    )
    .all(messageType, singleSourceRef) as RawEventRow[];
  // Case 2: window rows whose JSON payload mentions message_id. Use LIKE
  // as a coarse pre-filter, then verify by parsing.
  const likePattern = `%"${message_id}"%`;
  const winCandidates = db
    .prepare(
      `SELECT id, source_type, source_ref, payload, received_at
       FROM raw_events
       WHERE source_type = ?
         AND CAST(payload AS TEXT) LIKE ?`,
    )
    .all(windowType, likePattern) as RawEventRow[];
  const windows = winCandidates.filter((row) => {
    try {
      const evt = JSON.parse(row.payload.toString('utf8'));
      const ids: unknown = evt?.message_ids;
      return Array.isArray(ids) && ids.includes(message_id);
    } catch {
      return false;
    }
  });
  return [...singles, ...windows];
}
```

- [ ] **Step 4: Run** — expect PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/chat-edit-sync.ts src/brain/__tests__/chat-edit-sync.test.ts
git commit -m "feat(brain): chat-edit-sync findRawEventsForMessage helper"
```

---

## Task 7: `chat-edit-sync` — supersede KUs on edit

**Files:**
- Modify: `src/brain/chat-edit-sync.ts`
- Modify: `src/brain/__tests__/chat-edit-sync.test.ts`

Given a list of raw_events, mark all derived KUs `superseded_at=now`, then re-extract from the new content and insert fresh KUs that point back via `superseded_by`. For windowed events the new transcript drops the old text for that message_id and re-inserts with the new text.

- [ ] **Step 1: Failing test** appended to the existing test file:

```ts
import { handleChatMessageEdited } from '../chat-edit-sync.js';

describe('chat-edit-sync — handleChatMessageEdited', () => {
  it('supersedes KUs derived from a single-message raw_event and inserts new ones', async () => {
    const db = getBrainDb();
    // Seed: one raw_event + one KU.
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(
      Buffer.from(JSON.stringify({
        type: 'chat.message.saved', platform: 'signal',
        chat_id: 'chat-1', message_id: 'msg-1', text: 'pay $100', sender: 'alice',
      })),
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:01Z',
    );
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k1', 'pay $100 owed', 'signal_message', 'chat-1:msg-1', 'personal', NULL,
               0.9, '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', 'payment', 'rules', 0)`,
    ).run();

    const fakeLlm = vi.fn(async () => ({
      claims: [{ text: 'pay $250 owed', topic_seed: 'payment', entities_mentioned: [], confidence: 0.9 }],
      inputTokens: 10, outputTokens: 5,
    }));

    await handleChatMessageEdited(
      {
        type: 'chat.message.edited', source: 'signal', timestamp: Date.now(),
        payload: {}, platform: 'signal', chat_id: 'chat-1', message_id: 'msg-1',
        old_text: 'pay $100', new_text: 'pay $250',
        edited_at: '2026-04-28T00:00:00.000Z', sender: 'alice',
      },
      { llmCaller: fakeLlm, db },
    );

    // Old KU is now superseded.
    const oldKu = db.prepare(`SELECT superseded_at, superseded_by FROM knowledge_units WHERE id='k1'`).get() as any;
    expect(oldKu.superseded_at).not.toBeNull();
    expect(oldKu.superseded_by).not.toBeNull();
    // New KU exists with same source_ref.
    const newKu = db.prepare(
      `SELECT id, text, superseded_at FROM knowledge_units WHERE source_ref='chat-1:msg-1' AND id != 'k1'`,
    ).get() as any;
    expect(newKu).toBeDefined();
    expect(newKu.text).toBe('pay $250 owed');
    expect(newKu.superseded_at).toBeNull();
    expect(oldKu.superseded_by).toBe(newKu.id);
  });

  it('is a no-op when no raw_events match', async () => {
    const db = getBrainDb();
    const llm = vi.fn();
    await handleChatMessageEdited(
      {
        type: 'chat.message.edited', source: 'signal', timestamp: Date.now(),
        payload: {}, platform: 'signal', chat_id: 'unknown', message_id: 'unknown',
        old_text: null, new_text: 'whatever',
        edited_at: '2026-04-28T00:00:00.000Z', sender: 'x',
      },
      { llmCaller: llm, db },
    );
    expect(llm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** `handleChatMessageEdited` in `src/brain/chat-edit-sync.ts`. Append to the file:

```ts
import { extractPipeline, type LlmCaller } from './extract.js';
import { embedText, getEmbeddingModelVersion } from './embed.js';
import { upsertKu } from './qdrant.js';
import { newId } from './ulid.js';

export interface ChatEditSyncOpts {
  llmCaller?: LlmCaller;
  db?: Database.Database;
}

/**
 * Handle a chat.message.edited event:
 *   1. Find all raw_events derived from the message (single + windowed).
 *   2. For each match: mark dependent KUs superseded_at=now.
 *   3. Re-extract from new_text using extractPipeline (mode reflects the
 *      raw_event's source_type — chat_single or chat_window).
 *   4. Insert fresh KUs and set superseded_by on the OLD KUs to point at
 *      the new ones (one new KU absorbs the multiple old ones for that
 *      raw_event — confidence weighted by overlap of topic_key).
 */
export async function handleChatMessageEdited(
  evt: ChatMessageEditedEvent,
  opts: ChatEditSyncOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const matches = findRawEventsForMessage(db, evt.platform, evt.chat_id, evt.message_id);
  if (matches.length === 0) return;

  for (const raw of matches) {
    const isWindow = raw.source_type.endsWith('_window');
    const mode = isWindow ? ('chat_window' as const) : ('chat_single' as const);
    // Build the text to re-extract from.
    let text = evt.new_text;
    let participants: string[] | undefined;
    if (isWindow) {
      // Reconstruct transcript with new_text replacing the old line for this
      // message_id; preserve other lines as cached.
      const payload = JSON.parse(raw.payload.toString('utf8'));
      participants = payload.participants;
      text = rebuildTranscript(payload, evt.message_id, evt.new_text);
    }

    // Mark old KUs superseded.
    const supersededAt = new Date().toISOString();
    const oldKuIds = (
      db
        .prepare(
          `SELECT id FROM knowledge_units
           WHERE source_type = ? AND source_ref = ? AND superseded_at IS NULL`,
        )
        .all(raw.source_type, raw.source_ref) as Array<{ id: string }>
    ).map((r) => r.id);
    if (oldKuIds.length === 0) continue;

    // Re-extract.
    const claims = await extractPipeline(
      { text, mode, participants },
      { llmCaller: opts.llmCaller, db },
    );

    // Insert fresh KUs.
    const nowIso = new Date().toISOString();
    const validFrom = evt.edited_at;
    const newKuIds: string[] = [];
    db.transaction(() => {
      const insertKu = db.prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, source_ref, account, scope, confidence,
            valid_from, recorded_at, topic_key, extracted_by, needs_review)
         VALUES (?, ?, ?, ?, 'personal', NULL, ?, ?, ?, ?, ?, ?)`,
      );
      for (const claim of claims) {
        const kuId = newId();
        insertKu.run(
          kuId,
          claim.text,
          raw.source_type,
          raw.source_ref,
          claim.confidence,
          validFrom,
          nowIso,
          claim.topic_key ?? null,
          claim.extracted_by,
          claim.needs_review ? 1 : 0,
        );
        newKuIds.push(kuId);
      }
      // Mark old KUs as superseded by the FIRST new KU (or NULL if no claims).
      const supersededBy = newKuIds[0] ?? null;
      const updateOld = db.prepare(
        `UPDATE knowledge_units
            SET superseded_at = ?, superseded_by = ?
          WHERE id = ?`,
      );
      for (const oldId of oldKuIds) updateOld.run(supersededAt, supersededBy, oldId);
    })();

    // Best-effort embed/upsert for new KUs.
    const modelVersion = getEmbeddingModelVersion();
    for (const kuId of newKuIds) {
      const row = db.prepare(`SELECT text, topic_key FROM knowledge_units WHERE id = ?`).get(kuId) as any;
      try {
        const vec = await embedText(row.text, 'document');
        await upsertKu({
          kuId,
          vector: vec,
          payload: {
            account: 'personal',
            scope: null,
            model_version: modelVersion,
            valid_from: validFrom,
            recorded_at: nowIso,
            source_type: raw.source_type,
            topic_key: row.topic_key ?? null,
          },
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), kuId },
          'chat-edit-sync: embed/upsert failed for re-extracted KU',
        );
      }
    }
  }
}

/**
 * Build a windowed transcript with one line replaced. Preserves the original
 * order using the cached message_ids[]. Lines for ids other than the edited
 * one are pulled verbatim from the original payload's transcript (split on \n).
 */
function rebuildTranscript(
  payload: any,
  editedId: string,
  newText: string,
): string {
  const ids: string[] = payload.message_ids ?? [];
  const oldLines: string[] = (payload.transcript ?? '').split('\n');
  // Best-effort: line indexes match ids[] indexes when ids are in chronological order.
  return ids
    .map((id, i) => {
      if (id !== editedId) return oldLines[i] ?? '';
      // Replace just the text portion. Keep timestamp + sender prefix.
      const prefix = (oldLines[i] ?? '').replace(/:\s.*$/, '');
      return `${prefix}: ${newText}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/chat-edit-sync.ts src/brain/__tests__/chat-edit-sync.test.ts
git commit -m "feat(brain): supersede + re-extract KUs on chat.message.edited"
```

---

## Task 8: `chat-edit-sync` — tombstone KUs on delete

**Files:**
- Modify: `src/brain/chat-edit-sync.ts`
- Modify: `src/brain/__tests__/chat-edit-sync.test.ts`

Simpler than edit: just mark `superseded_at`, no replacement KU. Insert a marker raw_event so audit/recall queries can show "this was deleted".

- [ ] **Step 1: Failing test**:

```ts
import { handleChatMessageDeleted } from '../chat-edit-sync.js';

describe('chat-edit-sync — handleChatMessageDeleted', () => {
  it('tombstones KUs derived from a deleted single-message raw_event', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(Buffer.from('{}'), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k1', 'sensitive', 'signal_message', 'chat-1:msg-1', 'personal', NULL,
               0.9, '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();

    await handleChatMessageDeleted(
      {
        type: 'chat.message.deleted', source: 'signal', timestamp: Date.now(),
        payload: {}, platform: 'signal', chat_id: 'chat-1', message_id: 'msg-1',
        deleted_at: '2026-04-28T00:00:00.000Z',
      },
      { db },
    );

    const ku = db.prepare(`SELECT superseded_at, superseded_by FROM knowledge_units WHERE id='k1'`).get() as any;
    expect(ku.superseded_at).not.toBeNull();
    expect(ku.superseded_by).toBeNull(); // deletion = no replacement
    // A deletion-marker raw_event was inserted.
    const marker = db.prepare(
      `SELECT * FROM raw_events WHERE source_type='signal_deletion' AND source_ref='chat-1:msg-1'`,
    ).get() as any;
    expect(marker).toBeDefined();
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add** `handleChatMessageDeleted` to `src/brain/chat-edit-sync.ts`:

```ts
/**
 * Handle a chat.message.deleted event:
 *   1. Find all raw_events derived from the message.
 *   2. Mark all dependent KUs superseded_at=deleted_at, superseded_by=NULL.
 *   3. Insert a deletion-marker raw_event for audit.
 *
 * No re-extraction. The KU stays in the DB but is excluded from active recall.
 */
export async function handleChatMessageDeleted(
  evt: ChatMessageDeletedEvent,
  opts: ChatEditSyncOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const matches = findRawEventsForMessage(db, evt.platform, evt.chat_id, evt.message_id);
  // Always insert the deletion marker — even if no KUs derived from this
  // message — so the audit trail is complete.
  db.prepare(
    `INSERT OR IGNORE INTO raw_events (id, source_type, source_ref, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    `${evt.platform}_deletion`,
    `${evt.chat_id}:${evt.message_id}`,
    Buffer.from(JSON.stringify(evt)),
    evt.deleted_at,
  );
  if (matches.length === 0) return;
  const updateKu = db.prepare(
    `UPDATE knowledge_units
        SET superseded_at = ?, superseded_by = NULL
      WHERE source_type = ? AND source_ref = ? AND superseded_at IS NULL`,
  );
  db.transaction(() => {
    for (const raw of matches) {
      updateKu.run(evt.deleted_at, raw.source_type, raw.source_ref);
    }
  })();
  logger.info(
    { platform: evt.platform, chat_id: evt.chat_id, message_id: evt.message_id, count: matches.length },
    'chat-edit-sync: tombstoned KUs from deleted message',
  );
}
```

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/chat-edit-sync.ts src/brain/__tests__/chat-edit-sync.test.ts
git commit -m "feat(brain): tombstone KUs on chat.message.deleted"
```

---

## Task 9: Wire `chat-edit-sync` into chat-ingest start/stop

**Files:**
- Modify: `src/brain/chat-edit-sync.ts`
- Modify: `src/brain/chat-ingest.ts`
- Modify: `src/brain/__tests__/chat-edit-sync.test.ts`

Add `start/stopChatEditSync` and call them from chat-ingest's start/stop.

- [ ] **Step 1: Failing test**:

```ts
import { startChatEditSync, stopChatEditSync } from '../chat-edit-sync.js';

describe('chat-edit-sync — lifecycle', () => {
  it('startChatEditSync subscribes to edit + delete events', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES ('r1', 'signal_message', 'chat-1:msg-1', ?, ?, ?)`,
    ).run(Buffer.from('{}'), '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, source_ref, account, scope,
                                     confidence, valid_from, recorded_at, topic_key,
                                     extracted_by, needs_review)
       VALUES ('k1', 'x', 'signal_message', 'chat-1:msg-1', 'personal', NULL, 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:01Z', NULL, 'rules', 0)`,
    ).run();

    startChatEditSync();
    eventBus.emit('chat.message.deleted', {
      type: 'chat.message.deleted', source: 'signal', timestamp: Date.now(),
      payload: {}, platform: 'signal', chat_id: 'chat-1', message_id: 'msg-1',
      deleted_at: '2026-04-28T00:00:00.000Z',
    });
    await new Promise((r) => setTimeout(r, 50));
    stopChatEditSync();

    const ku = db.prepare(`SELECT superseded_at FROM knowledge_units WHERE id='k1'`).get() as any;
    expect(ku.superseded_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add lifecycle** at the bottom of `src/brain/chat-edit-sync.ts`:

```ts
let unsubEdited: (() => void) | null = null;
let unsubDeleted: (() => void) | null = null;

export interface ChatEditSyncStartOpts {
  llmCaller?: LlmCaller;
}

export function startChatEditSync(opts: ChatEditSyncStartOpts = {}): void {
  if (unsubEdited || unsubDeleted) return;
  unsubEdited = eventBus.on('chat.message.edited', async (evt) => {
    try {
      await handleChatMessageEdited(evt, { llmCaller: opts.llmCaller });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          message_id: evt.message_id,
        },
        'chat-edit-sync: edit handler failed',
      );
    }
  });
  unsubDeleted = eventBus.on('chat.message.deleted', async (evt) => {
    try {
      await handleChatMessageDeleted(evt);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          message_id: evt.message_id,
        },
        'chat-edit-sync: delete handler failed',
      );
    }
  });
  logger.info('Chat edit-sync started (chat.message.edited + chat.message.deleted)');
}

export function stopChatEditSync(): void {
  if (unsubEdited) {
    unsubEdited();
    unsubEdited = null;
  }
  if (unsubDeleted) {
    unsubDeleted();
    unsubDeleted = null;
  }
}
```

- [ ] **Step 4: Wire** into `src/brain/chat-ingest.ts`. Add the import:

```ts
import {
  startChatEditSync,
  stopChatEditSync,
} from './chat-edit-sync.js';
```

In `startChatIngest`, after `startWindowFlusher();` and before `logger.info('Chat ingest started ...')`, add:

```ts
  startChatEditSync({ llmCaller: opts.llmCaller });
```

In `stopChatIngest`, after `stopWindowFlusher();`, add:

```ts
  stopChatEditSync();
```

- [ ] **Step 5: Run all chat tests**: `npx vitest run src/brain/__tests__/chat-ingest.test.ts src/brain/__tests__/chat-edit-sync.test.ts` — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/brain/chat-edit-sync.ts src/brain/chat-ingest.ts src/brain/__tests__/chat-edit-sync.test.ts
git commit -m "feat(brain): start/stop chat-edit-sync alongside chat-ingest"
```

---

## Task 10: Manual end-to-end verification

**Files:**
- (operator-run) verification

- [ ] **Step 1: Build + restart**

```bash
cd /Users/topcoder1/dev/nanoclaw && npm run build && launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

Expected logs: `Window flusher started`, `Chat ingest started`, `Chat edit-sync started`.

- [ ] **Step 2: Edit verification (Signal)**

In a Signal chat opted in to brain ingest (e.g. `signal_main` Note-to-Self): send a message like `"pay $100 by Friday"`, wait for either single-save (🧠 react) or windowed flush. Confirm a KU exists:

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT id, substr(text,1,60), superseded_at FROM knowledge_units
   WHERE source_type IN ('signal_message','signal_window')
   ORDER BY recorded_at DESC LIMIT 3;"
```

Then EDIT the same Signal message in the Signal app to `"pay $250 by Friday"`. Wait ~5 seconds.

- [ ] **Step 3: Confirm supersede**

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT id, substr(text,1,60), superseded_at, superseded_by FROM knowledge_units
   WHERE source_type IN ('signal_message','signal_window')
   ORDER BY recorded_at DESC LIMIT 5;"
```

Expected: the original KU now has `superseded_at` set and `superseded_by` pointing at a fresh KU whose text reflects `$250`.

- [ ] **Step 4: Delete verification**

In the same Signal chat, send a fresh message, save it (🧠 react), then `Delete for everyone` in Signal. Wait ~5 seconds.

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT source_type, source_ref FROM raw_events
   WHERE source_type='signal_deletion' ORDER BY received_at DESC LIMIT 1;"
```

Expected: a `signal_deletion` row exists. Confirm the corresponding KU has `superseded_at` set and `superseded_by IS NULL`.

- [ ] **Step 5: Empty commit recording verification**

```bash
git commit --allow-empty -m "chore(chat): manual verification PR4 — Signal edit/delete sync green"
```

---

## Self-Review

- **Spec coverage** — both edit and delete paths covered for both Signal (Tasks 2, 3) and Discord (Tasks 4, 5); brain-side handler (Tasks 6–9); manual verification (Task 10). The `superseded_by` column existence (from PR 1) is leveraged but not re-introduced.
- **Placeholder scan** — no TBD/TODO; every code block is real and runnable. Test fixtures are concrete.
- **Type consistency** — `ChatMessageEditedEvent` declared in Task 1 and used identically in Tasks 2, 4, 7, 9. `ChatMessageDeletedEvent` declared in Task 1 and used in Tasks 3, 5, 8, 9. `RawEventRow` declared in Task 6 and used in Task 7/8. `ChatEditSyncOpts` declared in Task 7 and used in Task 8/9.
- **Out-of-scope** — no entity-merge engine (PR 3), no attachment summarization (PR 3), no UI surface for "view edit history" (future). Edit-sync is correctness-only: it keeps the DB in sync with reality but doesn't expose history to the user.
- **Failure modes** — `findRawEventsForMessage` uses LIKE pre-filter on JSON payload then verifies via parse, so it's correct on rare false-positive matches. Re-extract uses the same `extractPipeline` as ingest, so budget gating still applies. Embed/upsert is best-effort; SQLite is authoritative.
