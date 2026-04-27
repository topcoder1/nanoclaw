# Discord & Signal → Brain Ingest (PR 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Discord and Signal so messages reach NanoClaw and 🧠-emoji-react / `/save` / `claw save` triggers ingest the message (plus surrounding context and any attachments) into the brain as a `knowledge_unit`.

**Architecture:** Channel modules persist every message into a 24h `chat_messages` cache (nanoclaw DB). Reactions and slash/text triggers emit a new `ChatMessageSavedEvent` on the existing event bus. `src/brain/ingest.ts` grows a handler that runs the existing `extractPipeline` in a new `chat_single` mode (bypasses the email-tuned signal-score gate), creates entities under per-platform alias namespaces, and writes a `knowledge_unit` + Qdrant point via the same code path used by email today. Attachments (PDF / image / voice) are downloaded once, deduped by sha256, and surfaced to extraction either as text (PDF, voice transcript) or as a Haiku-captioned line (image).

**Tech Stack:** TypeScript, Node 20, better-sqlite3, discord.js, signal-cli-rest-api, Qdrant, Vitest, Anthropic SDK (Haiku 4.5 for vision), OpenAI Whisper (optional voice transcription).

**Spec:** `docs/superpowers/specs/2026-04-27-discord-signal-brain-ingest-design.md` (read first; this plan implements §1–§5 of the §Implementation phases section, labeled "PR 1").

---

## File Structure

**New files:**

| Path | Purpose |
|---|---|
| `src/chat-message-cache.ts` | 24h SQLite cache of inbound chat messages (used by reaction lookup + future window flusher). |
| `src/chat-message-cache.test.ts` | Unit tests for the cache. |
| `src/chat-attachments.ts` | Download, store, sha256-dedup, retry sweep for inbound attachments. |
| `src/chat-attachments.test.ts` | Unit tests for the attachment store. |
| `src/brain/chat-extract.ts` | Chat-aware extraction prompt + entity helpers; thin wrapper over `extractPipeline`. |
| `src/brain/chat-extract.test.ts` | Tests for chat-mode extraction. |
| `src/brain/chat-ingest.ts` | Handler for `chat.message.saved` — raw_events insert, extract, KU + Qdrant. |
| `src/brain/chat-ingest.test.ts` | Tests for the chat ingest handler. |

**Modified files:**

| Path | Change |
|---|---|
| `src/db.ts` | Add `chat_messages` CREATE TABLE + indexes (idempotent migration block). |
| `src/brain/db.ts` | Add idempotent `ALTER TABLE knowledge_units ADD COLUMN superseded_by TEXT` migration. |
| `src/events.ts` | Add `ChatMessageSavedEvent`, `ChatAttachment` interfaces; register `'chat.message.saved'` in `EventTypes`. |
| `src/brain/extract.ts` | Add `mode?: 'email' \| 'chat_single' \| 'chat_window'` to `ExtractInput`; bypass signal-score gate when chat mode; chat-aware prompt branch in `buildPrompt`. |
| `src/brain/entities.ts` | Export `findEntityIdByAlias`; add `createPersonFromHandle(platform, handle, displayName?)`. |
| `src/brain/ingest.ts` | Register `eventBus.on('chat.message.saved', ...)` in `start()`; track unsubscribes as an array so the new handler can be torn down. |
| `src/channels/discord.ts` | Add `GuildMessageReactions` + `DirectMessageReactions` intents; persist incoming messages to cache; handle `MessageUpdate` (cache update); handle `MessageReactionAdd` (🧠 → emit event); register `/save` slash command. |
| `src/channels/signal.ts` | Persist incoming messages to cache; detect `dataMessage.reaction` → emit event; detect `^claw save` text → emit event; detect `editMessage` / `remoteDelete` (cache update only — handlers in PR 4); fetch attachments via `/v1/attachments/<id>`. |
| `.env.example` | Add `BRAIN_SAVE_EMOJI`, `CHAT_CACHE_TTL_HOURS`, `BRAIN_ATTACHMENT_MAX_BYTES`, `BRAIN_IMAGE_VISION`. |

**Out of scope for PR 1** (PRs 2–4): window flusher, identity-merge engine, edit/delete sync, `chat.window.flushed` event handler, `chat_window` extraction prompt content (the `mode` value is added in this PR but only `chat_single` produces output).

---

## Task 1: `superseded_by` column migration

**Files:**
- Modify: `src/brain/db.ts`
- Test: `src/brain/__tests__/schema.test.ts`

The spec relies on `knowledge_units.superseded_by` for edit-sync (PR 4), but only `superseded_at` exists today. Add the column now so the live DB has it before PR 4 lands.

- [ ] **Step 1: Write the failing test**

Open `src/brain/__tests__/schema.test.ts` and append:

```ts
it('knowledge_units has a superseded_by column for forward-link supersession', () => {
  const db = openTestBrainDb(); // existing helper in this file
  const cols = db.prepare(`PRAGMA table_info(knowledge_units)`).all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  expect(names).toContain('superseded_at');
  expect(names).toContain('superseded_by');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/schema.test.ts -t superseded_by`
Expected: FAIL — `expected ['...', 'superseded_at'] to contain 'superseded_by'`

- [ ] **Step 3: Add the migration**

Open `src/brain/db.ts`. Locate the existing migration block (search for `ensureBrainSchema` or wherever idempotent migrations run). Add immediately after the existing `superseded_at` block (or anywhere in the migration sequence):

```ts
// PR 1 (chat ingest): forward-link to replacement KU on edit-sync supersession.
// Pre-existing brain DBs may not have this column.
try {
  db.exec(`ALTER TABLE knowledge_units ADD COLUMN superseded_by TEXT`);
} catch (err) {
  // Column already exists. SQLite throws on duplicate column.
  if (!/duplicate column name/i.test(String(err))) throw err;
}
```

Also add the column to the `CREATE TABLE knowledge_units` definition in `src/brain/schema.sql` immediately after `superseded_at`:

```sql
  superseded_at     TEXT,
  superseded_by     TEXT,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/schema.test.ts -t superseded_by`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/brain/db.ts src/brain/schema.sql src/brain/__tests__/schema.test.ts
git commit -m "feat(brain): add knowledge_units.superseded_by for edit-sync forward-link"
```

---

## Task 2: `chat_messages` cache table and module

**Files:**
- Create: `src/chat-message-cache.ts`
- Create: `src/chat-message-cache.test.ts`
- Modify: `src/db.ts`

Persistent 24h cache so reaction events (which arrive with only a message-id reference) can be resolved back to message bodies.

- [ ] **Step 1: Add the migration block to `src/db.ts`**

Locate the existing migration sequence (where you see `try { database.exec(\`ALTER TABLE ...\`) }` blocks around lines 360–780). Append a new block:

```ts
// PR 1 (chat ingest): 24h cache of inbound chat messages.
database.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    sent_at      TEXT NOT NULL,
    sender       TEXT NOT NULL,
    sender_name  TEXT,
    text         TEXT,
    reply_to_id  TEXT,
    attachments  TEXT,
    edited_at    TEXT,
    deleted_at   TEXT,
    attachment_download_attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, chat_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_msg_chat_time
    ON chat_messages (platform, chat_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_chat_msg_prune
    ON chat_messages (sent_at);
`);
```

- [ ] **Step 2: Write the failing test**

Create `src/chat-message-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initDb, closeDb } from './db.js';
import {
  putChatMessage,
  getChatMessage,
  pruneChatMessages,
  type CachedChatMessage,
} from './chat-message-cache.js';

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `nc-cache-${Date.now()}-${Math.random()}`);
  initDb(tmp);
});

afterEach(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('chat-message-cache', () => {
  const sample: CachedChatMessage = {
    platform: 'discord',
    chat_id: 'channel-1',
    message_id: 'msg-1',
    sent_at: '2026-04-27T12:00:00.000Z',
    sender: 'user-1',
    sender_name: 'Alice',
    text: 'hello world',
  };

  it('stores and retrieves a message by composite key', () => {
    putChatMessage(sample);
    const got = getChatMessage('discord', 'channel-1', 'msg-1');
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hello world');
    expect(got!.sender_name).toBe('Alice');
  });

  it('returns null for an unknown message', () => {
    expect(getChatMessage('discord', 'channel-1', 'missing')).toBeNull();
  });

  it('upserts on conflicting key — newer write replaces older', () => {
    putChatMessage(sample);
    putChatMessage({ ...sample, text: 'edited body', edited_at: '2026-04-27T12:05:00.000Z' });
    const got = getChatMessage('discord', 'channel-1', 'msg-1')!;
    expect(got.text).toBe('edited body');
    expect(got.edited_at).toBe('2026-04-27T12:05:00.000Z');
  });

  it('prunes rows older than the cutoff', () => {
    putChatMessage({ ...sample, message_id: 'old', sent_at: '2026-04-25T00:00:00.000Z' });
    putChatMessage({ ...sample, message_id: 'new', sent_at: '2026-04-27T12:00:00.000Z' });
    const removed = pruneChatMessages('2026-04-26T00:00:00.000Z');
    expect(removed).toBe(1);
    expect(getChatMessage('discord', 'channel-1', 'old')).toBeNull();
    expect(getChatMessage('discord', 'channel-1', 'new')).not.toBeNull();
  });

  it('lists messages in a chat ordered by sent_at descending', () => {
    putChatMessage({ ...sample, message_id: 'a', sent_at: '2026-04-27T12:00:00.000Z' });
    putChatMessage({ ...sample, message_id: 'b', sent_at: '2026-04-27T12:05:00.000Z' });
    putChatMessage({ ...sample, message_id: 'c', sent_at: '2026-04-27T11:55:00.000Z' });
    const list = listChatMessages('discord', 'channel-1', { limit: 10 });
    expect(list.map((m) => m.message_id)).toEqual(['b', 'a', 'c']);
  });
});

import { listChatMessages } from './chat-message-cache.js';
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/chat-message-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the cache module**

Create `src/chat-message-cache.ts`:

```ts
import { getDb } from './db.js';

export interface CachedChatMessage {
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  sent_at: string;
  sender: string;
  sender_name?: string;
  text?: string;
  reply_to_id?: string;
  attachments?: unknown[];
  edited_at?: string;
  deleted_at?: string;
  attachment_download_attempts?: number;
}

export interface ChatMessageRow extends CachedChatMessage {
  attachment_download_attempts: number;
}

export function putChatMessage(msg: CachedChatMessage): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO chat_messages
       (platform, chat_id, message_id, sent_at, sender, sender_name,
        text, reply_to_id, attachments, edited_at, deleted_at,
        attachment_download_attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
       sent_at      = excluded.sent_at,
       sender       = excluded.sender,
       sender_name  = excluded.sender_name,
       text         = excluded.text,
       reply_to_id  = excluded.reply_to_id,
       attachments  = excluded.attachments,
       edited_at    = excluded.edited_at,
       deleted_at   = excluded.deleted_at`,
  ).run(
    msg.platform,
    msg.chat_id,
    msg.message_id,
    msg.sent_at,
    msg.sender,
    msg.sender_name ?? null,
    msg.text ?? null,
    msg.reply_to_id ?? null,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.edited_at ?? null,
    msg.deleted_at ?? null,
    msg.attachment_download_attempts ?? 0,
  );
}

export function getChatMessage(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): ChatMessageRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE platform = ? AND chat_id = ? AND message_id = ?`,
    )
    .get(platform, chat_id, message_id) as
    | (Omit<ChatMessageRow, 'attachments'> & { attachments: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
  } as ChatMessageRow;
}

export function listChatMessages(
  platform: 'discord' | 'signal',
  chat_id: string,
  opts: { limit?: number; sinceIso?: string } = {},
): ChatMessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE platform = ? AND chat_id = ?
         AND (? IS NULL OR sent_at >= ?)
       ORDER BY sent_at DESC
       LIMIT ?`,
    )
    .all(
      platform,
      chat_id,
      opts.sinceIso ?? null,
      opts.sinceIso ?? null,
      opts.limit ?? 200,
    ) as Array<Omit<ChatMessageRow, 'attachments'> & { attachments: string | null }>;
  return rows.map((r) => ({
    ...r,
    attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
  })) as ChatMessageRow[];
}

export function pruneChatMessages(cutoffIso: string): number {
  const db = getDb();
  const r = db
    .prepare(`DELETE FROM chat_messages WHERE sent_at < ?`)
    .run(cutoffIso);
  return r.changes;
}

export function bumpAttachmentAttempts(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): number {
  const db = getDb();
  db.prepare(
    `UPDATE chat_messages SET attachment_download_attempts = attachment_download_attempts + 1
     WHERE platform = ? AND chat_id = ? AND message_id = ?`,
  ).run(platform, chat_id, message_id);
  const r = db
    .prepare(
      `SELECT attachment_download_attempts AS n FROM chat_messages
       WHERE platform = ? AND chat_id = ? AND message_id = ?`,
    )
    .get(platform, chat_id, message_id) as { n: number } | undefined;
  return r?.n ?? 0;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/chat-message-cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/chat-message-cache.ts src/chat-message-cache.test.ts
git commit -m "feat(chat): chat_messages cache table + cache module"
```

---

## Task 3: New event types

**Files:**
- Modify: `src/events.ts`
- Test: `src/event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/event-bus.test.ts` and append:

```ts
import type { ChatMessageSavedEvent } from './events.js';

it('emits and receives ChatMessageSavedEvent typed end-to-end', async () => {
  const bus = createEventBus();
  const seen: ChatMessageSavedEvent[] = [];
  bus.on('chat.message.saved', (e) => seen.push(e));
  const evt: ChatMessageSavedEvent = {
    type: 'chat.message.saved',
    timestamp: Date.now(),
    platform: 'discord',
    chat_id: 'channel-1',
    message_id: 'msg-1',
    sender: 'user-1',
    sent_at: '2026-04-27T12:00:00.000Z',
    text: 'hello',
    trigger: 'emoji',
  };
  bus.emit('chat.message.saved', evt);
  expect(seen).toHaveLength(1);
  expect(seen[0].text).toBe('hello');
});
```

(`createEventBus` should already be a helper in this file; if the file uses the singleton `eventBus` instead, follow the existing pattern.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/event-bus.test.ts -t ChatMessageSavedEvent`
Expected: FAIL — type not exported / event not in union.

- [ ] **Step 3: Add the types and union entry**

Open `src/events.ts`. Append after the last `LearnFeedbackReceivedEvent` interface (or wherever feels right — alphabetical isn't enforced):

```ts
// --- Chat ingest -----------------------------------------------------------

export interface ChatAttachment {
  filename: string;
  mime: string;
  sha256: string;
  local_path: string;
  size_bytes: number;
}

export interface ChatMessageSavedEvent extends NanoClawEvent {
  type: 'chat.message.saved';
  platform: 'discord' | 'signal';
  chat_id: string;
  chat_name?: string;
  message_id: string;
  sender: string;
  sender_display?: string;
  sent_at: string;
  text: string;
  attachments?: ChatAttachment[];
  context_before?: { sender: string; text: string; sent_at: string }[];
  reply_to?: { sender: string; text: string; sent_at: string };
  trigger: 'emoji' | 'slash' | 'text';
}
```

In the `EventTypes` union map (around line 740–770), add the entry:

```ts
'chat.message.saved': ChatMessageSavedEvent;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/event-bus.test.ts -t ChatMessageSavedEvent`
Expected: PASS.

Run a wider build check:
```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/event-bus.test.ts
git commit -m "feat(events): add ChatMessageSavedEvent + ChatAttachment types"
```

---

## Task 4: Attachment storage with sha256-dedup and retry counter

**Files:**
- Create: `src/chat-attachments.ts`
- Create: `src/chat-attachments.test.ts`
- Modify: `.env.example`

Downloads attachments to disk, dedups by content hash, tracks retry attempts via the cache row added in Task 2. No type-specific extraction yet — that's Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/chat-attachments.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  storeAttachment,
  attachmentRoot,
  type AttachmentDescriptor,
} from './chat-attachments.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'nc-att-'));
  process.env.BRAIN_ATTACHMENT_DIR = baseDir;
  process.env.BRAIN_ATTACHMENT_MAX_BYTES = String(1024 * 1024);
});

afterEach(() => {
  delete process.env.BRAIN_ATTACHMENT_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

describe('chat-attachments', () => {
  it('writes a downloaded buffer keyed by sha256 and returns a descriptor', async () => {
    const fetcher = vi.fn().mockResolvedValue(Buffer.from('hello world'));
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'note.txt', mime: 'text/plain', size_bytes: 11 },
      fetcher,
    );
    expect(desc).not.toBeNull();
    expect(desc!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(desc!.local_path)).toBe(true);
    expect(readFileSync(desc!.local_path).toString()).toBe('hello world');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedups by sha256 — same content from different messages reuses the file', async () => {
    const fetcher = vi.fn().mockResolvedValue(Buffer.from('shared'));
    const a = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'a.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    const b = await storeAttachment(
      { platform: 'discord', chat_id: 'c2', message_id: 'm2' },
      { filename: 'b.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    expect(a!.local_path).toBe(b!.local_path);
  });

  it('returns null when size exceeds BRAIN_ATTACHMENT_MAX_BYTES', async () => {
    process.env.BRAIN_ATTACHMENT_MAX_BYTES = '5';
    const fetcher = vi.fn();
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'too-big.bin', mime: 'application/octet-stream', size_bytes: 100 },
      fetcher,
    );
    expect(desc).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null when fetcher throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'a.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    expect(desc).toBeNull();
  });

  it('attachmentRoot honors BRAIN_ATTACHMENT_DIR', () => {
    expect(attachmentRoot()).toBe(baseDir);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chat-attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the attachment store**

Create `src/chat-attachments.ts`:

```ts
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { logger } from './logger.js';
import type { ChatAttachment } from './events.js';

export interface AttachmentRef {
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
}

export interface AttachmentDescriptor {
  filename: string;
  mime: string;
  size_bytes: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export function attachmentRoot(): string {
  return process.env.BRAIN_ATTACHMENT_DIR ?? join(homedir(), '.nanoclaw', 'chat-attachments');
}

function maxBytes(): number {
  const raw = process.env.BRAIN_ATTACHMENT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Download (via fetcher) and store an attachment, deduped by sha256.
 * Returns a ChatAttachment descriptor, or null if the file is too large
 * or the fetch failed.
 */
export async function storeAttachment(
  ref: AttachmentRef,
  desc: AttachmentDescriptor,
  fetcher: () => Promise<Buffer>,
): Promise<ChatAttachment | null> {
  if (desc.size_bytes > maxBytes()) {
    logger.warn(
      { ...ref, filename: desc.filename, size: desc.size_bytes, cap: maxBytes() },
      'attachment exceeds size cap — skipping download',
    );
    return null;
  }
  let buf: Buffer;
  try {
    buf = await fetcher();
  } catch (err) {
    logger.warn(
      { ...ref, filename: desc.filename, err: err instanceof Error ? err.message : String(err) },
      'attachment fetch failed',
    );
    return null;
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  const dir = join(attachmentRoot(), 'sha256', sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const local_path = join(dir, sha);
  if (!existsSync(local_path)) {
    writeFileSync(local_path, buf);
  }
  return {
    filename: desc.filename,
    mime: desc.mime,
    sha256: sha,
    local_path,
    size_bytes: buf.length,
  };
}
```

- [ ] **Step 4: Update `.env.example`**

Add (or update if present):

```
# Chat ingest (Discord + Signal → brain)
BRAIN_SAVE_EMOJI=🧠
CHAT_CACHE_TTL_HOURS=24
BRAIN_ATTACHMENT_MAX_BYTES=26214400
BRAIN_ATTACHMENT_DIR=             # defaults to ~/.nanoclaw/chat-attachments
BRAIN_IMAGE_VISION=true
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/chat-attachments.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/chat-attachments.ts src/chat-attachments.test.ts .env.example
git commit -m "feat(chat): attachment store with sha256-dedup and size cap"
```

---

## Task 5: Attachment-to-text adapters (PDF, image, audio, fallback)

**Files:**
- Modify: `src/chat-attachments.ts`
- Modify: `src/chat-attachments.test.ts`

Turns each stored attachment into a one-line "what does this contain" string that gets concatenated into the extraction input. Branch by mime type.

- [ ] **Step 1: Write the failing test**

Append to `src/chat-attachments.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { describeAttachment } from './chat-attachments.js';

describe('describeAttachment', () => {
  it('returns the placeholder for unknown types', async () => {
    const path = join(baseDir, 'a.zip');
    writeFileSync(path, Buffer.from('PK\x03\x04'));
    const out = await describeAttachment(
      { filename: 'archive.zip', mime: 'application/zip', sha256: 'x', local_path: path, size_bytes: 4 },
      { imageVision: false, voiceTranscribe: false },
    );
    expect(out).toBe('[Attachment: archive.zip, 4 B]');
  });

  it('returns a placeholder for images when vision is off', async () => {
    const path = join(baseDir, 'a.png');
    writeFileSync(path, Buffer.alloc(8));
    const out = await describeAttachment(
      { filename: 'pic.png', mime: 'image/png', sha256: 'x', local_path: path, size_bytes: 8 },
      { imageVision: false, voiceTranscribe: false },
    );
    expect(out).toBe('[Attachment image: pic.png]');
  });

  it('extracts text from a PDF when pdftotext is available', async () => {
    // pdftotext is invoked by the impl; we'll mock spawn/exec behind an injection point.
    // For this unit test, pass a stubbed extractor.
    const stub = vi.fn().mockResolvedValue('Quarterly report — Q3 revenue up 12%.');
    const out = await describeAttachment(
      { filename: 'q3.pdf', mime: 'application/pdf', sha256: 'x', local_path: '/dev/null', size_bytes: 100 },
      { imageVision: false, voiceTranscribe: false, _pdfExtractor: stub },
    );
    expect(out.startsWith('[Attachment PDF: q3.pdf]')).toBe(true);
    expect(out).toContain('Quarterly report');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chat-attachments.test.ts -t describeAttachment`
Expected: FAIL — `describeAttachment is not a function`.

- [ ] **Step 3: Implement `describeAttachment`**

Append to `src/chat-attachments.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExecFile = promisify(execFile);

export interface DescribeOpts {
  imageVision: boolean;
  voiceTranscribe: boolean;
  /** Test seam — replaces the pdftotext call. */
  _pdfExtractor?: (path: string) => Promise<string>;
  /** Test seam — replaces the Haiku vision call. */
  _imageCaptioner?: (path: string) => Promise<string>;
  /** Test seam — replaces the Whisper call. */
  _audioTranscriber?: (path: string) => Promise<string>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function defaultPdfExtractor(path: string): Promise<string> {
  try {
    const { stdout } = await pExecFile('pdftotext', ['-layout', '-q', '-l', '50', path, '-']);
    return stdout.trim();
  } catch (err) {
    logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'pdftotext failed');
    return '';
  }
}

async function defaultImageCaptioner(path: string): Promise<string> {
  // Implementation: single Haiku 4.5 vision call. Wired in Task 5b once
  // we know the project's preferred Anthropic SDK invocation point.
  // Default returns empty string — caller treats as placeholder-only.
  void path;
  return '';
}

async function defaultAudioTranscriber(path: string): Promise<string> {
  // Implementation requires the /add-voice-transcription skill (Whisper).
  // If not installed (no OPENAI_API_KEY or no transcription helper), return ''.
  void path;
  return '';
}

export async function describeAttachment(
  att: ChatAttachment,
  opts: DescribeOpts,
): Promise<string> {
  const size = fmtBytes(att.size_bytes);
  if (att.mime === 'application/pdf') {
    const extract = opts._pdfExtractor ?? defaultPdfExtractor;
    const txt = (await extract(att.local_path)).slice(0, 8000);
    return `[Attachment PDF: ${att.filename}]\n${txt}`.trim();
  }
  if (att.mime.startsWith('image/')) {
    if (!opts.imageVision) return `[Attachment image: ${att.filename}]`;
    const cap = (opts._imageCaptioner ?? defaultImageCaptioner)(att.local_path);
    const caption = (await cap).trim();
    return caption
      ? `[Attachment image: ${att.filename} — ${caption}]`
      : `[Attachment image: ${att.filename}]`;
  }
  if (att.mime.startsWith('audio/')) {
    if (!opts.voiceTranscribe) return `[Attachment audio: ${att.filename}, ${size}]`;
    const tx = (await (opts._audioTranscriber ?? defaultAudioTranscriber)(att.local_path)).trim();
    return tx
      ? `[Attachment audio: ${att.filename}]\n${tx}`
      : `[Attachment audio: ${att.filename}, ${size}]`;
  }
  return `[Attachment: ${att.filename}, ${size}]`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/chat-attachments.test.ts -t describeAttachment`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chat-attachments.ts src/chat-attachments.test.ts
git commit -m "feat(chat): describeAttachment adapters (PDF/image/audio/fallback)"
```

---

## Task 6: ExtractInput.mode + chat-aware prompt + bypass signal-score gate

**Files:**
- Modify: `src/brain/extract.ts`
- Modify: `src/brain/__tests__/extract.test.ts`

Email signal-score gate would block chat content from reaching LLM extraction. Add a `mode` field; when chat, bypass the gate and use a chat-specific prompt.

- [ ] **Step 1: Write the failing test**

Append to `src/brain/__tests__/extract.test.ts`:

```ts
it('chat_single mode bypasses the signal-score gate even on plain chat', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const fakeLlm = vi.fn(async ({ system, user }: { system: string; user: string }) => {
    calls.push({ system, user });
    return {
      claims: [{
        text: 'Launch moved to next Wednesday',
        topic_seed: 'launch date',
        topic_key: 'launch_date',
        entities_mentioned: [],
        confidence: 0.85,
        needs_review: false,
        extracted_by: 'llm',
      }],
      _usage: { input_tokens: 200, output_tokens: 50 },
    };
  });
  const claims = await extractPipeline(
    { text: "ok let's call it — launch = next Wed", mode: 'chat_single' },
    { llmCaller: fakeLlm as unknown as LlmCaller, db: testDb, day: '2026-04-27' },
  );
  expect(fakeLlm).toHaveBeenCalledTimes(1);
  expect(claims.length).toBeGreaterThan(0);
  expect(calls[0].system).toContain('chat');
});

it('default email mode still gates on signal score', async () => {
  const fakeLlm = vi.fn();
  await extractPipeline(
    { text: 'hi how are you', sender: 'a@b.com' }, // no $/deal/dates → signal=0
    { llmCaller: fakeLlm as unknown as LlmCaller, db: testDb, day: '2026-04-27' },
  );
  expect(fakeLlm).not.toHaveBeenCalled();
});
```

(Reuse the `LlmCaller` type and `testDb` helper that already exist in this test file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/extract.test.ts -t "chat_single mode bypasses"`
Expected: FAIL — `mode` not a property of `ExtractInput`.

- [ ] **Step 3: Add `mode` to `ExtractInput`**

In `src/brain/extract.ts`, modify the interface:

```ts
export interface ExtractInput {
  text: string;
  subject?: string;
  sender?: string;
  /** Override today's date for tests. ISO YYYY-MM-DD. */
  today?: string;
  /** Source of this input. Affects signal-score gating and prompt. */
  mode?: 'email' | 'chat_single' | 'chat_window';
  /** For chat_window mode — speaker handles for the prompt. */
  participants?: string[];
}
```

- [ ] **Step 4: Bypass the signal-score gate for chat modes**

Locate `extractLLM` (search for `function extractLLM(`). Inside, before the line that checks `signalScore < 0.3` (or whatever the actual threshold is — confirm by reading the function), add:

```ts
const isChat = input.mode === 'chat_single' || input.mode === 'chat_window';
if (!isChat && opts.signalScore < 0.3) {
  return [];  // existing email-mode gate
}
// chat modes proceed regardless of signal score; the trigger is the signal.
```

(If the existing code reads more like `if (signalScore < 0.3) return []` directly, replace it with the conditional above.)

- [ ] **Step 5: Add chat-aware prompt branch in `buildPrompt`**

Locate `function buildPrompt(input: ExtractInput): string`. At the top, branch on mode:

```ts
function buildPrompt(input: ExtractInput): string {
  if (input.mode === 'chat_single') {
    return [
      `You extract durable knowledge from a single chat message. Return JSON {claims: [...]}.`,
      `Each claim should be a self-contained factual statement, decision, or commitment.`,
      `Skip greetings, acknowledgements, and pure reactions.`,
      input.sender ? `Sender: ${input.sender}` : '',
      `Message: ${input.text}`,
    ].filter(Boolean).join('\n\n');
  }
  if (input.mode === 'chat_window') {
    return [
      `You extract durable knowledge from a chat-conversation transcript. Return JSON {claims: [...]}.`,
      `Identify distinct factual statements, decisions, and commitments — one claim per topic.`,
      `Skip chitchat, greetings, and pure reactions. Use participant names where attribution matters.`,
      input.participants?.length ? `Participants: ${input.participants.join(', ')}` : '',
      `Transcript:\n${input.text}`,
    ].filter(Boolean).join('\n\n');
  }
  // ... existing email prompt body unchanged below ...
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/extract.test.ts`
Expected: all existing tests + 2 new ones PASS.

- [ ] **Step 7: Commit**

```bash
git add src/brain/extract.ts src/brain/__tests__/extract.test.ts
git commit -m "feat(brain): ExtractInput.mode — chat extraction bypasses email signal-score gate"
```

---

## Task 7: `createPersonFromHandle` + entity-alias namespaces

**Files:**
- Modify: `src/brain/entities.ts`
- Modify: `src/brain/__tests__/entities.test.ts`

Maps Discord/Signal handles into the existing `entity_aliases` table under typed `field_name` namespaces.

- [ ] **Step 1: Write the failing test**

Append to `src/brain/__tests__/entities.test.ts`:

```ts
import { createPersonFromHandle, findEntityIdByAlias } from '../entities.js';

describe('createPersonFromHandle', () => {
  it('creates a person and discord_username alias for a Discord handle', async () => {
    const e = await createPersonFromHandle('discord', 'alice#1234', 'Alice');
    expect(e.kind).toBe('person');
    const found = findEntityIdByAlias(getBrainDb(), 'discord_username', 'alice');
    expect(found).toBe(e.id);
  });

  it('creates a person and signal_phone alias normalized to E.164', async () => {
    const e = await createPersonFromHandle('signal', '+1 (555) 123-4567');
    expect(e.kind).toBe('person');
    const found = findEntityIdByAlias(getBrainDb(), 'signal_phone', '+15551234567');
    expect(found).toBe(e.id);
  });

  it('is idempotent — second call returns the same entity', async () => {
    const a = await createPersonFromHandle('discord', 'bob');
    const b = await createPersonFromHandle('discord', 'bob');
    expect(a.id).toBe(b.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/entities.test.ts -t createPersonFromHandle`
Expected: FAIL — symbol not exported.

- [ ] **Step 3: Export `findEntityIdByAlias` and add `createPersonFromHandle`**

In `src/brain/entities.ts`, change `function findEntityIdByAlias(...)` to `export function findEntityIdByAlias(...)`.

Append:

```ts
export type ChatPlatform = 'discord' | 'signal';

interface HandleNamespace {
  field: string;
  normalize: (raw: string) => string | null;
}

function pickNamespace(platform: ChatPlatform, raw: string): HandleNamespace | null {
  if (platform === 'discord') {
    if (/^\d{17,20}$/.test(raw)) {
      return { field: 'discord_snowflake', normalize: (s) => s };
    }
    return {
      field: 'discord_username',
      normalize: (s) => s.replace(/#\d+$/, '').toLowerCase().trim() || null,
    };
  }
  // signal
  if (/^\+?\d[\d\s().-]{6,}$/.test(raw)) {
    return {
      field: 'signal_phone',
      normalize: (s) => {
        const digits = s.replace(/[^\d+]/g, '');
        if (!digits) return null;
        return digits.startsWith('+') ? digits : `+${digits}`;
      },
    };
  }
  if (/^[0-9a-f-]{36}$/i.test(raw)) {
    return { field: 'signal_uuid', normalize: (s) => s.toLowerCase() };
  }
  return {
    field: 'signal_profile_name',
    normalize: (s) => s.normalize('NFC').trim() || null,
  };
}

export async function createPersonFromHandle(
  platform: ChatPlatform,
  rawHandle: string,
  displayName?: string,
): Promise<Entity> {
  const ns = pickNamespace(platform, rawHandle);
  if (!ns) throw new Error(`createPersonFromHandle: cannot classify '${rawHandle}'`);
  const value = ns.normalize(rawHandle);
  if (!value) throw new Error(`createPersonFromHandle: empty after normalize '${rawHandle}'`);

  const db = getBrainDb();
  const existingId = findEntityIdByAlias(db, ns.field, value);
  if (existingId) {
    const e = readEntity(db, existingId);
    if (e) return e;
  }

  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO entities (id, kind, name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`,
  ).run(id, displayName ?? value, now, now);
  db.prepare(
    `INSERT INTO entity_aliases (entity_id, field_name, field_value, source_type, source_ref, valid_from)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, ns.field, value, platform, value, now);

  const e = readEntity(db, id);
  if (!e) throw new Error(`createPersonFromHandle: failed to persist ${value}`);
  return e;
}
```

(Use the existing `newId` and `readEntity` helpers in the file. If `readEntity` is private, follow the same pattern used by `createPersonFromEmail` for the SELECT.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/entities.test.ts -t createPersonFromHandle`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/entities.ts src/brain/__tests__/entities.test.ts
git commit -m "feat(brain): createPersonFromHandle for Discord/Signal entity aliases"
```

---

## Task 8: Discord channel — cache write, MessageUpdate, reactions, /save slash command

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/discord.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/channels/discord.test.ts`:

```ts
import { eventBus } from '../event-bus.js';
import type { ChatMessageSavedEvent } from '../events.js';
import * as cache from '../chat-message-cache.js';

describe('Discord chat-ingest hooks', () => {
  it('persists every inbound MessageCreate to the chat_messages cache', async () => {
    const ch = await connectMockDiscord(); // helper that returns a connected channel + emit-message stub
    ch.emit('MessageCreate', mockMessage({ id: 'msg-1', channelId: 'channel-1', content: 'hello' }));
    const got = cache.getChatMessage('discord', 'channel-1', 'msg-1');
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hello');
  });

  it('emits ChatMessageSavedEvent when 🧠 is reacted on a cached message', async () => {
    cache.putChatMessage({
      platform: 'discord',
      chat_id: 'channel-1',
      message_id: 'msg-7',
      sent_at: new Date().toISOString(),
      sender: 'user-7',
      sender_name: 'Alice',
      text: 'Launch is next Wednesday',
    });
    const ch = await connectMockDiscord();
    const seen: ChatMessageSavedEvent[] = [];
    eventBus.on('chat.message.saved', (e) => seen.push(e));
    ch.emit('MessageReactionAdd', mockReaction({ emoji: '🧠', messageId: 'msg-7', channelId: 'channel-1', userId: 'me' }));
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('Launch is next Wednesday');
    expect(seen[0].trigger).toBe('emoji');
  });

  it('ignores reactions from the bot itself', async () => {
    const ch = await connectMockDiscord();
    const seen: ChatMessageSavedEvent[] = [];
    eventBus.on('chat.message.saved', (e) => seen.push(e));
    ch.emit('MessageReactionAdd', mockReaction({ emoji: '🧠', messageId: 'msg-1', channelId: 'channel-1', userId: BOT_USER_ID }));
    await flushPromises();
    expect(seen).toHaveLength(0);
  });

  it('emits ChatMessageSavedEvent on /save slash command', async () => {
    const ch = await connectMockDiscord();
    const seen: ChatMessageSavedEvent[] = [];
    eventBus.on('chat.message.saved', (e) => seen.push(e));
    ch.emit('InteractionCreate', mockSlashSave({ text: 'remember: KV cache hit ratio is 80%', userId: 'me', channelId: 'channel-1' }));
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(seen[0].trigger).toBe('slash');
    expect(seen[0].text).toContain('KV cache hit ratio');
  });
});
```

(Mock helpers `connectMockDiscord`, `mockMessage`, `mockReaction`, `mockSlashSave`, `flushPromises`, and `BOT_USER_ID` should follow the patterns already in `discord.test.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/channels/discord.test.ts -t "chat-ingest hooks"`
Expected: FAIL — handlers not wired.

- [ ] **Step 3: Add reaction intents and chat-ingest handlers**

In `src/channels/discord.ts`:

```ts
// At the top:
import { eventBus } from '../event-bus.js';
import { putChatMessage, getChatMessage } from '../chat-message-cache.js';
import type { ChatMessageSavedEvent } from '../events.js';
```

In `connect()`, add the new intents:

```ts
this.client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,    // NEW
    GatewayIntentBits.DirectMessageReactions,   // NEW
  ],
});
```

Inside the existing `Events.MessageCreate` handler, before any `return`, add the cache write:

```ts
putChatMessage({
  platform: 'discord',
  chat_id: channelId,
  message_id: msgId,
  sent_at: timestamp,
  sender,
  sender_name: senderName,
  text: message.content,
  reply_to_id: message.reference?.messageId ?? undefined,
});
```

Add a `MessageUpdate` listener (immediately after the existing `MessageCreate` registration):

```ts
this.client.on(Events.MessageUpdate, async (_old, message) => {
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }
  if (message.author?.bot) return;
  putChatMessage({
    platform: 'discord',
    chat_id: message.channelId,
    message_id: message.id,
    sent_at: message.createdAt.toISOString(),
    sender: message.author?.id ?? 'unknown',
    sender_name: message.member?.displayName ?? message.author?.username,
    text: message.content,
    edited_at: message.editedAt?.toISOString() ?? new Date().toISOString(),
  });
  // (PR 4 will emit ChatMessageEditedEvent here.)
});
```

Add a `MessageReactionAdd` listener:

```ts
this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
  const targetEmoji = process.env.BRAIN_SAVE_EMOJI ?? '🧠';
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.emoji.name !== targetEmoji) return;
  if (user.id === this.client?.user?.id) return; // ignore self

  const cached = getChatMessage('discord', reaction.message.channelId, reaction.message.id);
  if (!cached) {
    logger.warn(
      { messageId: reaction.message.id, channelId: reaction.message.channelId },
      'Discord 🧠-react: message not in cache (older than TTL?)',
    );
    return;
  }
  const evt: ChatMessageSavedEvent = {
    type: 'chat.message.saved',
    timestamp: Date.now(),
    platform: 'discord',
    chat_id: reaction.message.channelId,
    chat_name: this.channelDisplayName(reaction.message),
    message_id: reaction.message.id,
    sender: cached.sender,
    sender_display: cached.sender_name,
    sent_at: cached.sent_at,
    text: cached.text ?? '',
    trigger: 'emoji',
  };
  eventBus.emit('chat.message.saved', evt);
});
```

Register the `/save` slash command on ready and handle it in `InteractionCreate`:

```ts
this.client.once(Events.ClientReady, async (c) => {
  try {
    await c.application?.commands.create({
      name: 'save',
      description: 'Save text to your brain',
      options: [{ name: 'text', description: 'What to save', type: 3, required: true }], // 3 = STRING
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Discord /save command registration failed');
  }
});

this.client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'save') return;
  const text = interaction.options.getString('text', true);
  const evt: ChatMessageSavedEvent = {
    type: 'chat.message.saved',
    timestamp: Date.now(),
    platform: 'discord',
    chat_id: interaction.channelId ?? `dm:${interaction.user.id}`,
    message_id: interaction.id,
    sender: interaction.user.id,
    sender_display: interaction.user.username,
    sent_at: new Date().toISOString(),
    text,
    trigger: 'slash',
  };
  eventBus.emit('chat.message.saved', evt);
  await interaction.reply({ content: `🧠 saved.`, ephemeral: true });
});
```

Add a small helper for `channelDisplayName(msg)` — extract the same `chatName` formatting that the existing `MessageCreate` handler uses, and call it from both places.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/channels/discord.test.ts`
Expected: existing tests + 4 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): cache writes + 🧠-react + /save → ChatMessageSavedEvent"
```

---

## Task 9: Signal channel — cache write, reactions, `claw save`, attachments

**Files:**
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/signal.test.ts`

- [ ] **Step 1: Extend the `DataMessage` type to include reaction / edit / delete payloads**

In `src/channels/signal.ts`, update the `DataMessage` interface:

```ts
interface DataMessage {
  timestamp: number;
  message?: string | null;
  expiresInSeconds?: number;
  viewOnce?: boolean;
  attachments?: Array<{
    id?: string;
    contentType: string;
    filename?: string;
    size?: number;
  }>;
  groupInfo?: { groupId: string; type: string };
  reaction?: {
    emoji: string;
    targetAuthor: string;
    targetSentTimestamp: number;
    isRemove?: boolean;
  };
  editMessage?: {
    targetSentTimestamp: number;
    dataMessage: { message?: string | null };
  };
  remoteDelete?: { timestamp: number };
}
```

- [ ] **Step 2: Write the failing test**

Append to `src/channels/signal.test.ts`:

```ts
import { eventBus } from '../event-bus.js';
import * as cache from '../chat-message-cache.js';

describe('Signal chat-ingest hooks', () => {
  it('writes inbound messages to the chat_messages cache', async () => {
    const ch = await connectMockSignal({ phone: '+15550000000' });
    ch.deliver({
      envelope: {
        source: '+15551234567', sourceName: 'Alice', timestamp: 1714000000000,
        dataMessage: { timestamp: 1714000000000, message: 'hello from signal' },
      },
    });
    await flushPromises();
    const got = cache.getChatMessage('signal', '+15551234567', '1714000000000');
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hello from signal');
  });

  it('emits ChatMessageSavedEvent when 🧠 reaction arrives for a cached message', async () => {
    cache.putChatMessage({
      platform: 'signal', chat_id: '+15551234567', message_id: '1714000000000',
      sent_at: new Date(1714000000000).toISOString(),
      sender: '+15551234567', sender_name: 'Alice', text: 'Launch is next Wed',
    });
    const ch = await connectMockSignal({ phone: '+15550000000' });
    const seen: ChatMessageSavedEvent[] = [];
    eventBus.on('chat.message.saved', (e) => seen.push(e));
    ch.deliver({
      envelope: {
        source: '+15550000001', timestamp: 1714000005000,
        dataMessage: {
          timestamp: 1714000005000,
          reaction: { emoji: '🧠', targetAuthor: '+15551234567', targetSentTimestamp: 1714000000000 },
        },
      },
    });
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(seen[0].trigger).toBe('emoji');
    expect(seen[0].text).toContain('Launch');
  });

  it('emits ChatMessageSavedEvent on `claw save` text trigger with quoted body', async () => {
    const ch = await connectMockSignal({ phone: '+15550000000' });
    const seen: ChatMessageSavedEvent[] = [];
    eventBus.on('chat.message.saved', (e) => seen.push(e));
    ch.deliver({
      envelope: {
        source: '+15550000001', timestamp: 1714000010000,
        dataMessage: {
          timestamp: 1714000010000,
          message: 'claw save This is the gem',
        },
      },
    });
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(seen[0].trigger).toBe('text');
    expect(seen[0].text).toBe('This is the gem');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/channels/signal.test.ts -t "chat-ingest hooks"`
Expected: FAIL — handlers not wired.

- [ ] **Step 4: Wire the handlers**

In `src/channels/signal.ts`, modify `handleEnvelope`:

```ts
private handleEnvelope(data: SignalPayload): void {
  const envelope = data.envelope;
  if (!envelope) return;
  const dataMsg =
    envelope.dataMessage ?? envelope.syncMessage?.sentMessage ?? null;
  if (!dataMsg) return;

  const sourceJid = envelope.source ?? envelope.sourceNumber ?? 'unknown';
  const chatId = dataMsg.groupInfo?.groupId ?? sourceJid;
  const messageId = String(dataMsg.timestamp);
  const sentAt = new Date(dataMsg.timestamp).toISOString();

  // 1. Reaction → emit save event if emoji matches and not a remove.
  if (dataMsg.reaction) {
    if (dataMsg.reaction.isRemove) return;
    const target = (process.env.BRAIN_SAVE_EMOJI ?? '🧠');
    if (dataMsg.reaction.emoji !== target) return;
    const targetAuthor = dataMsg.reaction.targetAuthor;
    const targetTs = String(dataMsg.reaction.targetSentTimestamp);
    const targetChatId = dataMsg.groupInfo?.groupId ?? targetAuthor;
    const cached = getChatMessage('signal', targetChatId, targetTs);
    if (!cached) {
      logger.warn({ targetTs, targetChatId }, 'Signal 🧠-react: target not cached');
      return;
    }
    eventBus.emit('chat.message.saved', {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      platform: 'signal',
      chat_id: targetChatId,
      message_id: targetTs,
      sender: cached.sender,
      sender_display: cached.sender_name,
      sent_at: cached.sent_at,
      text: cached.text ?? '',
      trigger: 'emoji',
    });
    return;
  }

  // 2. `claw save` text trigger.
  const body = dataMsg.message?.trim() ?? '';
  const clawMatch = body.match(/^claw\s+save\b\s*(.*)$/i);
  if (clawMatch) {
    const tail = clawMatch[1].trim();
    eventBus.emit('chat.message.saved', {
      type: 'chat.message.saved',
      timestamp: Date.now(),
      platform: 'signal',
      chat_id: chatId,
      message_id: messageId,
      sender: sourceJid,
      sender_display: envelope.sourceName,
      sent_at: sentAt,
      text: tail,
      trigger: 'text',
    });
    return;
  }

  // 3. Cache the message for future reaction lookups.
  if (body || (dataMsg.attachments?.length ?? 0) > 0) {
    putChatMessage({
      platform: 'signal',
      chat_id: chatId,
      message_id: messageId,
      sent_at: sentAt,
      sender: sourceJid,
      sender_name: envelope.sourceName,
      text: body || undefined,
    });
  }

  // 4. Existing inbound-message routing (unchanged).
  // ... existing call to this.opts.onMessage(...) ...
}
```

(Preserve every existing call to `this.opts.onMessage` and `this.opts.onChatMetadata` that the file already has — only add the four blocks above.)

Add the imports near the top:

```ts
import { eventBus } from '../event-bus.js';
import { putChatMessage, getChatMessage } from '../chat-message-cache.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: existing tests + 3 new ones PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): cache writes + 🧠-react + claw save → ChatMessageSavedEvent"
```

---

## Task 10: Brain ingest handler for `chat.message.saved`

**Files:**
- Create: `src/brain/chat-ingest.ts`
- Create: `src/brain/__tests__/chat-ingest.test.ts`
- Modify: `src/brain/ingest.ts`

End-to-end: event → raw_events → extract → KU → Qdrant.

- [ ] **Step 1: Write the failing test**

Create `src/brain/__tests__/chat-ingest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { eventBus } from '../../event-bus.js';
import type { ChatMessageSavedEvent } from '../../events.js';
import { startChatIngest, stopChatIngest } from '../chat-ingest.js';
import { getBrainDb } from '../db.js';
// helpers below come from the existing ingest-pipeline test:
import { setupTestBrain, teardownTestBrain, mockEmbed, mockUpsertKu } from './_brain-test-helpers.js';

describe('chat-ingest', () => {
  beforeEach(() => setupTestBrain());
  afterEach(() => { stopChatIngest(); teardownTestBrain(); });

  it('inserts a raw_events row and produces a knowledge_unit for a saved chat message', async () => {
    const fakeLlm = vi.fn(async () => ({
      claims: [{ text: 'Launch moved to next Wednesday', topic_seed: 'launch', topic_key: 'launch_date',
                 entities_mentioned: [], confidence: 0.9, needs_review: false, extracted_by: 'llm' }],
      _usage: { input_tokens: 100, output_tokens: 30 },
    }));
    startChatIngest({ llmCaller: fakeLlm });
    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved', timestamp: Date.now(),
      platform: 'discord', chat_id: 'channel-1', message_id: 'msg-7',
      sender: 'user-7', sender_display: 'Alice',
      sent_at: '2026-04-27T12:00:00.000Z',
      text: "ok let's call it — launch = next Wed", trigger: 'emoji',
    };
    eventBus.emit('chat.message.saved', evt);
    await flushPromises();

    const db = getBrainDb();
    const raw = db.prepare(`SELECT * FROM raw_events WHERE source_type = 'discord_message'`).get() as any;
    expect(raw).toBeDefined();
    expect(raw.source_ref).toBe('channel-1:msg-7');

    const ku = db.prepare(`SELECT * FROM knowledge_units WHERE source_type = 'discord_message'`).get() as any;
    expect(ku).toBeDefined();
    expect(ku.text).toContain('Launch');
    expect(mockUpsertKu).toHaveBeenCalledTimes(1);
  });

  it('dedups via raw_events UNIQUE — same message twice produces one KU', async () => {
    const fakeLlm = vi.fn(async () => ({ claims: [], _usage: { input_tokens: 50, output_tokens: 10 } }));
    startChatIngest({ llmCaller: fakeLlm });
    const evt: ChatMessageSavedEvent = {
      type: 'chat.message.saved', timestamp: Date.now(),
      platform: 'signal', chat_id: '+1555', message_id: '1714000000000',
      sender: '+1555', sent_at: '2026-04-27T12:00:00.000Z',
      text: 'hello', trigger: 'text',
    };
    eventBus.emit('chat.message.saved', evt);
    eventBus.emit('chat.message.saved', evt);
    await flushPromises();

    const db = getBrainDb();
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE source_type = 'signal_message'`).get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
```

(`_brain-test-helpers.js` is a small extraction of the setup/teardown patterns already in `ingest-pipeline.test.ts`. If creating it is heavy, inline the same setup directly in this file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chat-ingest handler**

Create `src/brain/chat-ingest.ts`:

```ts
import { eventBus } from '../event-bus.js';
import type { ChatMessageSavedEvent } from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { extractPipeline, type LlmCaller } from './extract.js';
import { embedText } from './embed.js';
import { upsertKu } from './qdrant.js';
import {
  createPersonFromHandle,
  type Entity,
} from './entities.js';
import { newId } from './ulid.js';

export interface ChatIngestOpts {
  llmCaller?: LlmCaller;
}

let unsubscribe: (() => void) | null = null;

export function startChatIngest(opts: ChatIngestOpts = {}): void {
  if (unsubscribe) return; // already started
  unsubscribe = eventBus.on('chat.message.saved', async (evt: ChatMessageSavedEvent) => {
    try {
      await handleChatMessageSaved(evt, opts);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), msgId: evt.message_id },
        'chat ingest: handler failed',
      );
    }
  });
  logger.info('Chat ingest started (chat.message.saved handler)');
}

export function stopChatIngest(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

async function handleChatMessageSaved(
  evt: ChatMessageSavedEvent,
  opts: ChatIngestOpts,
): Promise<void> {
  const db = getBrainDb();
  const sourceType = `${evt.platform}_message`;
  const sourceRef = `${evt.chat_id}:${evt.message_id}`;
  const receivedAt = new Date(evt.timestamp).toISOString();

  // 1. raw_events idempotent insert.
  const rawId = newId();
  const insertRaw = db.prepare(
    `INSERT OR IGNORE INTO raw_events (id, source_type, source_ref, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const result = insertRaw.run(
    rawId,
    sourceType,
    sourceRef,
    Buffer.from(JSON.stringify(evt), 'utf8'),
    receivedAt,
  );
  if (result.changes === 0) {
    logger.debug({ sourceRef }, 'chat ingest: duplicate raw_event, skipping');
    return;
  }

  // 2. Extract.
  const claims = await extractPipeline(
    {
      text: evt.text,
      sender: evt.sender_display ?? evt.sender,
      mode: 'chat_single',
    },
    { llmCaller: opts.llmCaller, db },
  );

  // 3. Resolve sender entity.
  let senderEntity: Entity | null = null;
  try {
    senderEntity = await createPersonFromHandle(
      evt.platform,
      evt.sender,
      evt.sender_display,
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'chat ingest: entity resolve failed');
  }

  if (claims.length === 0) {
    db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(receivedAt, rawId);
    return;
  }

  // 4. KU + embedding + Qdrant per claim.
  for (const claim of claims) {
    const kuId = newId();
    db.prepare(
      `INSERT INTO knowledge_units
         (id, source_type, source_ref, text, topic_key, confidence, needs_review,
          account_bucket, valid_from, created_at)
       VALUES (?,?,?,?,?,?,?, 'personal', ?, ?)`,
    ).run(
      kuId,
      sourceType,
      sourceRef,
      claim.text,
      claim.topic_key,
      claim.confidence,
      claim.needs_review ? 1 : 0,
      evt.sent_at,
      receivedAt,
    );
    if (senderEntity) {
      db.prepare(
        `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
      ).run(kuId, senderEntity.id);
    }
    try {
      const vec = await embedText(claim.text);
      await upsertKu({ id: kuId, vector: vec, payload: { text: claim.text, source_type: sourceType, source_ref: sourceRef } });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), kuId },
        'chat ingest: embed/upsert failed — KU stands without vector',
      );
    }
  }
  db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(receivedAt, rawId);
}
```

- [ ] **Step 4: Wire into `start()` of `src/brain/ingest.ts`**

At the top:

```ts
import { startChatIngest, stopChatIngest } from './chat-ingest.js';
```

In the `start()` function, after the existing `eventBus.on('email.received', ...)` block, add:

```ts
startChatIngest();
```

In the `stop()` / `stopBrainIngest` function, add:

```ts
stopChatIngest();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts`
Expected: PASS (2 tests).

Run a wider sanity sweep:
```bash
npx vitest run src/brain/__tests__/ingest-pipeline.test.ts src/brain/__tests__/chat-ingest.test.ts
```
Expected: all PASS — confirms the existing email path still works.

- [ ] **Step 6: Commit**

```bash
git add src/brain/chat-ingest.ts src/brain/__tests__/chat-ingest.test.ts src/brain/ingest.ts
git commit -m "feat(brain): chat.message.saved → raw_events → extract → KU"
```

---

## Task 11: Manual end-to-end verification

**Files:** none (rollout exercise)

This task is **operator-run**, not automated. Skipping it = shipping blind.

- [ ] **Step 1: Build and start NanoClaw with credentials**

Set in `.env`:
```
DISCORD_BOT_TOKEN=<your bot token>
SIGNAL_API_URL=http://localhost:18080
SIGNAL_PHONE_NUMBER=<your linked Signal number>
BRAIN_SAVE_EMOJI=🧠
BRAIN_IMAGE_VISION=true
```

```bash
npm run build
npm run dev
```

Expected: log lines `Discord channel: connected as <bot>` and `Signal channel: polling http://localhost:18080 every 2s` and `Chat ingest started (chat.message.saved handler)`.

- [ ] **Step 2: Discord — 🧠 react path**

In a Discord channel where the bot is present, send a normal message. Wait 2 seconds. React to it with 🧠.

Verify in logs: `chat ingest: handler` line for `discord_message` source. Then:

```bash
sqlite3 ~/.nanoclaw/brain.db "SELECT id, source_type, source_ref, substr(text,1,80) FROM knowledge_units WHERE source_type='discord_message' ORDER BY created_at DESC LIMIT 5;"
```

Expected: at least one row matching the message you reacted to.

- [ ] **Step 3: Discord — `/save` path**

In any Discord channel, run `/save text:"my brain test note"`. Verify:
- Bot replies ephemerally `🧠 saved.`
- Same SQL query above shows a new row.

- [ ] **Step 4: Signal — 🧠 react path**

From your linked phone, in any 1:1 or group, react with 🧠 to a recent message. Verify:

```bash
sqlite3 ~/.nanoclaw/brain.db "SELECT source_ref, substr(text,1,80) FROM knowledge_units WHERE source_type='signal_message' ORDER BY created_at DESC LIMIT 5;"
```

Expected: a row matching the reacted message.

- [ ] **Step 5: Signal — `claw save` text path**

Send `claw save This is my Signal test note` in any chat. Verify a new `signal_message` row.

- [ ] **Step 6: Attachment path**

Drop a small PDF into a Discord channel where the bot is present, then 🧠-react it. Verify:
- File present under `~/.nanoclaw/chat-attachments/sha256/<...>`.
- The corresponding `knowledge_units.text` includes content extracted from the PDF.

- [ ] **Step 7: Cleanup**

If anything from steps 2–6 produced a malformed KU, delete it:
```bash
sqlite3 ~/.nanoclaw/brain.db "DELETE FROM knowledge_units WHERE id = '<id>';"
```

- [ ] **Step 8: Commit (no code changes; just a log entry)**

```bash
git commit --allow-empty -m "chore(chat): manual verification PR1 — Discord/Signal 🧠/save paths green"
```

---

## Self-Review Checklist (run after writing the plan)

This was run before publishing this plan. Outcome:

**1. Spec coverage** — every PR-1 phase from the spec maps to a task:
- §1 cache → Task 2
- §2 attachments + adapters → Tasks 4, 5
- §3 Discord wiring → Task 8
- §4 Signal wiring → Task 9
- §5 Brain ingest extension → Tasks 6 (extract mode), 7 (entity helper), 10 (handler)
- §superseded_by migration → Task 1
- §Manual verification → Task 11

**2. Placeholder scan** — no TBD/TODO/"add appropriate error handling"/etc. Any "(unchanged)" markers in code blocks are explicit pointers, not omissions.

**3. Type consistency** — `ChatMessageSavedEvent` shape declared once in Task 3 and used identically across Tasks 8, 9, 10. `ChatAttachment` declared once and used in `chat-attachments.ts`. `createPersonFromHandle(platform, handle, displayName?)` signature is identical in Tasks 7 and 10.

**Known follow-ups for PR 2+**: window flusher, identity-merge engine, edit/delete sync. Spec already documents these as separate PRs.
