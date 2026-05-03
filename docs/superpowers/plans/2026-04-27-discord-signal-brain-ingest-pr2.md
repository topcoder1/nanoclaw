# Discord & Signal → Brain Ingest (PR 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-chat opt-in window auto-ingest to NanoClaw — a per-`(platform, chat_id)` state machine accumulates message bursts, flushes on idle/cap/daily/shutdown, and runs `extractPipeline(mode='chat_window')` over the resulting transcript so multiple distinct claims drop into `knowledge_units`.

**Architecture:** A single host-side `setInterval` ticker drives an in-memory map of open windows. Channel-side message arrivals call `noteMessage()` (registered as an observer on `chat-message-cache.putChatMessage`); a 🧠-react inside an open window calls `noteSave()` so the windowed flush excludes the manually-saved id. On flush, the flusher emits `ChatWindowFlushedEvent` with a transcript built from cached messages (excluding `excluded_message_ids`). `chat-ingest.ts` grows a second handler for `chat.window.flushed` that mirrors the single-message path: insert `raw_events` (source_type `discord_window`/`signal_window`, payload carries `message_ids[]` for PR 4 edit-sync), run `extractPipeline(mode='chat_window')`, link KUs to all participants. LLM budget partitions so chat extraction can't starve email — chat checks an `extract_chat` cost-log slice in addition to the overall ceiling.

**Tech Stack:** TypeScript, Node 20, better-sqlite3, js-yaml (already a dep), Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-27-discord-signal-brain-ingest-design.md` (read first; this plan implements §6, §7 (`chat_window` mode only), §8 race resolution, §9 chat→group lookup, §10 LLM budget partition, and the §Failure-modes "process restart with open window" row from the spec's Implementation phases section labeled "PR 2").

**Building on (already on `main` from PR 1):** `src/chat-message-cache.ts` (cache + `listChatMessages`), `src/events.ts` (`ChatMessageSavedEvent`, `ChatAttachment`), `src/brain/chat-ingest.ts` (single-message handler), `src/brain/extract.ts` (already has `mode?: 'email' | 'chat_single' | 'chat_window'` in `ExtractInput` plus a `chat_window` prompt branch in `buildPrompt`; signal-score gate already bypasses chat modes), `src/brain/entities.ts` (`createPersonFromHandle`).

---

## File Structure

**New files:**

| Path                                            | Purpose                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/brain/group-frontmatter.ts`                | Read `groups/<folder>/CLAUDE.md` YAML frontmatter into a typed `ChatIngestConfig` (`brain_ingest`, `window_idle_min`, `window_cap`); cache by mtime. |
| `src/brain/__tests__/group-frontmatter.test.ts` | Unit tests for frontmatter parsing + chat→group resolution.                                                                                          |
| `src/brain/window-flusher.ts`                   | Per-`(platform, chat_id)` state machine; idle/cap/daily/shutdown flush; race-exclusion via `noteSave()`; emits `ChatWindowFlushedEvent`.             |
| `src/brain/__tests__/window-flusher.test.ts`    | Unit tests for flush triggers and exclusion.                                                                                                         |

**Modified files:**

| Path                        | Change                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/events.ts`             | Add `ChatWindowFlushedEvent` interface; register `'chat.window.flushed'` in `EventMap`.                                                                                                                                           |
| `src/chat-message-cache.ts` | Add `registerChatMessageObserver(fn)` extension point; `putChatMessage` invokes the observer at the end.                                                                                                                          |
| `src/brain/extract.ts`      | `getTodaysExtractSpend(db, day, category?)` — optional category filter; `writeCost` records `operation='extract_chat'` for chat modes; `extractLLM` checks the chat slice in addition to the overall ceiling when `mode` is chat. |
| `src/brain/chat-ingest.ts`  | Add `'chat.window.flushed'` listener and `handleChatWindowFlushed`; call `noteSave()` from `handleChatMessageSaved` for race exclusion; start/stop the window flusher from `startChatIngest`/`stopChatIngest`.                    |
| `.env.example`              | Add `WINDOW_IDLE_MS`, `WINDOW_CAP`, `WINDOW_DAILY_FLUSH_HOUR`, `BRAIN_LLM_BUDGET_CHAT_PCT`.                                                                                                                                       |

**Out of scope for PR 2** (PRs 3–4): identity-merge engine, edit/delete sync, attachment summarization in window mode, `claw merge` admin command, `/brainwindow flush` command. Window mode emits `attachments: []` for now — the PR-4 path will fill that in.

---

## Task 1: `ChatWindowFlushedEvent` type

**Files:**

- Modify: `src/events.ts`

PR 1 already declared `ChatMessageSavedEvent` and `ChatAttachment` in this file. Add the windowed counterpart so downstream code is type-safe.

- [ ] **Step 1: Add the interface**

In `src/events.ts`, locate the `// --- Chat ingest ---` section (currently ends with `ChatMessageSavedEvent`). Append, immediately after the closing brace of `ChatMessageSavedEvent`:

```ts
export interface ChatWindowFlushedEvent extends NanoClawEvent {
  type: 'chat.window.flushed';
  source: 'discord' | 'signal';
  platform: 'discord' | 'signal';
  chat_id: string;
  chat_name?: string;
  window_started_at: string; // ISO
  window_ended_at: string; // ISO
  message_count: number;
  /** Formatted "[ISO] sender: text\n..." with excluded ids omitted. */
  transcript: string;
  /** Message ids included in the transcript (for PR 4 edit-sync). */
  message_ids: string[];
  /** Distinct sender display names (or handles) seen in the window. */
  participants: string[];
  attachments?: ChatAttachment[];
  flush_reason: 'idle' | 'cap' | 'daily' | 'shutdown';
  group_folder: string;
  payload: Record<string, unknown>;
}
```

- [ ] **Step 2: Register in `EventMap`**

In the same file, locate `export interface EventMap { ... 'chat.message.saved': ChatMessageSavedEvent; }` (last entry as of PR 1). Add a new line just before the closing brace:

```ts
  'chat.window.flushed': ChatWindowFlushedEvent;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: PASS — no type errors. (Existing files only reference `ChatMessageSavedEvent`, so adding the new event is additive.)

- [ ] **Step 4: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): add ChatWindowFlushedEvent for windowed chat ingest"
```

---

## Task 2: Group frontmatter parser + chat→group resolver

**Files:**

- Create: `src/brain/group-frontmatter.ts`
- Create: `src/brain/__tests__/group-frontmatter.test.ts`

The window flusher needs two questions answered for any incoming message:

1. **Is this chat opted into windowed ingest?** — read `brain_ingest:` from the group's `CLAUDE.md` YAML frontmatter (default `off`).
2. **Which group folder owns this `(platform, chat_id)`?** — translate to JID via the spec's conventions (`dc:<channelId>`, `sig:group:<groupId>`, `sig:<number>`) and look up via `getRegisteredGroup`.

Centralizing both lookups here keeps the flusher free of filesystem and DB plumbing.

- [ ] **Step 1: Write the failing test**

Create `src/brain/__tests__/group-frontmatter.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpGroupsDir: string;
let tmpDataDir: string;
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return tmpGroupsDir;
  },
  get STORE_DIR() {
    return tmpDataDir;
  },
  QDRANT_URL: '',
}));

import { initDb, _closeDb, setRegisteredGroup } from '../../db.js';
import {
  readChatIngestConfig,
  resolveGroupForChat,
  _resetGroupFrontmatterCache,
} from '../group-frontmatter.js';

function writeGroupClaudeMd(folder: string, body: string): void {
  const dir = path.join(tmpGroupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body, 'utf8');
}

beforeEach(() => {
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-groups-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
  initDb(tmpDataDir);
  _resetGroupFrontmatterCache();
});

afterEach(() => {
  _closeDb();
  fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('group-frontmatter', () => {
  it('returns brain_ingest:off when no CLAUDE.md exists', () => {
    fs.mkdirSync(path.join(tmpGroupsDir, 'orphan'), { recursive: true });
    expect(readChatIngestConfig('orphan')).toEqual({
      brain_ingest: 'off',
      window_idle_min: undefined,
      window_cap: undefined,
    });
  });

  it('returns brain_ingest:off when CLAUDE.md has no frontmatter', () => {
    writeGroupClaudeMd('plain', '# just markdown\n\nnothing here.\n');
    expect(readChatIngestConfig('plain').brain_ingest).toBe('off');
  });

  it('parses brain_ingest:window with overrides', () => {
    writeGroupClaudeMd(
      'opted-in',
      '---\nbrain_ingest: window\nwindow_idle_min: 5\nwindow_cap: 20\n---\n\nbody\n',
    );
    expect(readChatIngestConfig('opted-in')).toEqual({
      brain_ingest: 'window',
      window_idle_min: 5,
      window_cap: 20,
    });
  });

  it('treats invalid brain_ingest values as off', () => {
    writeGroupClaudeMd('bogus', '---\nbrain_ingest: not-a-mode\n---\nbody\n');
    expect(readChatIngestConfig('bogus').brain_ingest).toBe('off');
  });

  it('treats malformed YAML as off (no throw)', () => {
    writeGroupClaudeMd(
      'broken',
      '---\nbrain_ingest: window\n  bad: indent\n---\n',
    );
    expect(readChatIngestConfig('broken').brain_ingest).toBe('off');
  });

  it('resolves a Discord chat_id to its registered group folder', () => {
    setRegisteredGroup('dc:111222', {
      name: 'g1',
      folder: 'discord-group',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('discord', '111222');
    expect(got).not.toBeNull();
    expect(got!.folder).toBe('discord-group');
    expect(got!.jid).toBe('dc:111222');
  });

  it('resolves a Signal group chat_id via sig:group: prefix', () => {
    setRegisteredGroup('sig:group:abc', {
      name: 'sigroup',
      folder: 'signal-group',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('signal', 'abc');
    expect(got!.folder).toBe('signal-group');
    expect(got!.jid).toBe('sig:group:abc');
  });

  it('falls back to sig:<number> for Signal 1:1 chats', () => {
    setRegisteredGroup('sig:+15551234567', {
      name: 'sig11',
      folder: 'signal-dm',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('signal', '+15551234567');
    expect(got!.folder).toBe('signal-dm');
    expect(got!.jid).toBe('sig:+15551234567');
  });

  it('returns null when no registered group matches', () => {
    expect(resolveGroupForChat('discord', 'nope')).toBeNull();
    expect(resolveGroupForChat('signal', 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/group-frontmatter.test.ts`
Expected: FAIL with "Cannot find module '../group-frontmatter.js'".

- [ ] **Step 3: Implement `src/brain/group-frontmatter.ts`**

```ts
/**
 * Per-chat ingest config from `groups/<folder>/CLAUDE.md` YAML frontmatter,
 * plus a chat_id → registered-group resolver. Cache invalidates on file mtime.
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { GROUPS_DIR } from '../config.js';
import { getRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';

export interface ChatIngestConfig {
  brain_ingest: 'off' | 'window';
  window_idle_min?: number;
  window_cap?: number;
}

interface CacheEntry {
  mtimeMs: number;
  config: ChatIngestConfig;
}

const cache = new Map<string, CacheEntry>();
const FRONTMATTER_DELIM = '---';
const DEFAULT_CONFIG: ChatIngestConfig = { brain_ingest: 'off' };

/** Test helper — drop the in-memory cache. */
export function _resetGroupFrontmatterCache(): void {
  cache.clear();
}

export function readChatIngestConfig(groupFolder: string): ChatIngestConfig {
  const claudeMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(claudeMd);
  } catch {
    return DEFAULT_CONFIG;
  }
  const cached = cache.get(groupFolder);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;

  let raw: string;
  try {
    raw = fs.readFileSync(claudeMd, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  const config = parseConfig(raw);
  cache.set(groupFolder, { mtimeMs: stat.mtimeMs, config });
  return config;
}

function parseConfig(raw: string): ChatIngestConfig {
  if (!raw.startsWith(FRONTMATTER_DELIM)) return DEFAULT_CONFIG;
  const end = raw.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length);
  if (end < 0) return DEFAULT_CONFIG;
  const front = raw.slice(FRONTMATTER_DELIM.length, end).trim();
  let parsed: unknown;
  try {
    parsed = yaml.load(front);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'group-frontmatter: malformed YAML — treating as brain_ingest:off',
    );
    return DEFAULT_CONFIG;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_CONFIG;
  const fm = parsed as Record<string, unknown>;

  const mode = fm.brain_ingest;
  if (mode !== 'window') return DEFAULT_CONFIG;

  const idleRaw = fm.window_idle_min;
  const capRaw = fm.window_cap;
  return {
    brain_ingest: 'window',
    window_idle_min:
      typeof idleRaw === 'number' && idleRaw > 0 ? idleRaw : undefined,
    window_cap: typeof capRaw === 'number' && capRaw > 0 ? capRaw : undefined,
  };
}

export interface ResolvedGroup {
  jid: string;
  folder: string;
}

/**
 * Translate a chat_id from a channel into the registered-group folder, if any.
 * Conventions match the spec §9 + existing channel JID logic:
 *   - Discord:        dc:<channelId>
 *   - Signal group:   sig:group:<groupId>
 *   - Signal 1:1:     sig:<number-or-uuid>
 */
export function resolveGroupForChat(
  platform: 'discord' | 'signal',
  chat_id: string,
): ResolvedGroup | null {
  const candidates: string[] =
    platform === 'discord'
      ? [`dc:${chat_id}`]
      : [`sig:group:${chat_id}`, `sig:${chat_id}`];
  for (const jid of candidates) {
    const group = getRegisteredGroup(jid);
    if (group) return { jid, folder: group.folder };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/group-frontmatter.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/group-frontmatter.ts src/brain/__tests__/group-frontmatter.test.ts
git commit -m "feat(brain): chat-ingest config from group frontmatter + chat_id→group resolver"
```

---

## Task 3: Chat-message observer hook

**Files:**

- Modify: `src/chat-message-cache.ts`

The window flusher needs to learn about every cached chat message. To avoid touching PR 1's channel files, expose a single observer-registration extension point. `putChatMessage` invokes the registered observer (if any) at the end. Window flusher registers on startup; tests can register their own.

- [ ] **Step 1: Add the hook**

In `src/chat-message-cache.ts`, after the `bumpAttachmentAttempts` function (the file's current last export), append:

```ts
type ChatMessageObserver = (msg: CachedChatMessage) => void;
let observer: ChatMessageObserver | null = null;

/**
 * Register a single observer to be notified after every successful putChatMessage.
 * Single-slot by design (one consumer = window flusher); call with `null` to
 * clear (used by tests). Re-registering replaces the prior observer.
 */
export function registerChatMessageObserver(
  fn: ChatMessageObserver | null,
): void {
  observer = fn;
}
```

Then locate `putChatMessage`'s body. After the existing `db.prepare(...).run(...)` call (the file's only `INSERT INTO chat_messages` block ends with `msg.attachment_download_attempts ?? 0,);`), append, before the closing brace of `putChatMessage`:

```ts
if (observer) {
  try {
    observer(msg);
  } catch {
    // Observer must never break cache writes. PR 2 logs internally.
  }
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run src/chat-message-cache.test.ts`
Expected: PASS — no behavior change for existing call sites (the observer is null by default).

- [ ] **Step 3: Commit**

```bash
git add src/chat-message-cache.ts
git commit -m "feat(cache): add chat-message observer hook for window flusher"
```

---

## Task 4: Window flusher state machine — core (idle, cap, race exclusion)

**Files:**

- Create: `src/brain/window-flusher.ts`
- Create: `src/brain/__tests__/window-flusher.test.ts`

In-memory, per-`(platform, chat_id)` state. `noteMessage` opens a window the first time a message arrives in an opted-in chat, bumps `last_at` and pushes message_id on each subsequent message. `noteSave` records the message_id in `excluded_message_ids`. `flushIdle()` and `flushCap()` walk the state map and emit `ChatWindowFlushedEvent`s; transcript is built from `listChatMessages` filtered by message_ids minus excluded ids.

This task implements the data model + idle + cap + race exclusion. Daily/shutdown flush is added in Task 5. The `setInterval` ticker is added in Task 5 too.

- [ ] **Step 1: Write the failing test**

Create `src/brain/__tests__/window-flusher.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpGroupsDir: string;
let tmpDataDir: string;
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return tmpGroupsDir;
  },
  get STORE_DIR() {
    return tmpDataDir;
  },
  QDRANT_URL: '',
}));

import { eventBus } from '../../event-bus.js';
import type { ChatWindowFlushedEvent } from '../../events.js';
import { initDb, _closeDb, setRegisteredGroup } from '../../db.js';
import { putChatMessage } from '../../chat-message-cache.js';
import { _resetGroupFrontmatterCache } from '../group-frontmatter.js';
import {
  noteMessage,
  noteSave,
  flushIdle,
  flushAll,
  _resetWindowState,
  _peekWindow,
} from '../window-flusher.js';

function writeOptIn(
  folder: string,
  opts: { idleMin?: number; cap?: number } = {},
): void {
  const dir = path.join(tmpGroupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', 'brain_ingest: window'];
  if (opts.idleMin !== undefined)
    lines.push(`window_idle_min: ${opts.idleMin}`);
  if (opts.cap !== undefined) lines.push(`window_cap: ${opts.cap}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), lines.join('\n'), 'utf8');
}

function captured(): ChatWindowFlushedEvent[] {
  const out: ChatWindowFlushedEvent[] = [];
  eventBus.on('chat.window.flushed', (e) => out.push(e));
  return out;
}

beforeEach(() => {
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wf-groups-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wf-data-'));
  initDb(tmpDataDir);
  _resetGroupFrontmatterCache();
  _resetWindowState();
  eventBus.removeAllListeners();
});

afterEach(() => {
  _closeDb();
  fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('window-flusher', () => {
  it('ignores messages from chats that are not opted in', () => {
    // No registered group at all.
    noteMessage('discord', 'random-chat', 'm1', new Date().toISOString());
    expect(_peekWindow('discord', 'random-chat')).toBeUndefined();
  });

  it('ignores messages from registered groups with brain_ingest=off (the default)', () => {
    setRegisteredGroup('dc:c1', {
      name: 'g1',
      folder: 'no-frontmatter',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    fs.mkdirSync(path.join(tmpGroupsDir, 'no-frontmatter'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'no-frontmatter', 'CLAUDE.md'),
      '# no frontmatter\n',
      'utf8',
    );
    noteMessage('discord', 'c1', 'm1', new Date().toISOString());
    expect(_peekWindow('discord', 'c1')).toBeUndefined();
  });

  it('opens a window on the first message in an opted-in chat', () => {
    setRegisteredGroup('dc:c2', {
      name: 'g2',
      folder: 'opt2',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt2');
    const t = '2026-04-27T12:00:00.000Z';
    noteMessage('discord', 'c2', 'm1', t);
    const w = _peekWindow('discord', 'c2');
    expect(w).toBeDefined();
    expect(w!.message_ids).toEqual(['m1']);
    expect(w!.started_at).toBe(t);
    expect(w!.last_at).toBe(t);
  });

  it('flushIdle emits a ChatWindowFlushedEvent for windows past the idle threshold', () => {
    setRegisteredGroup('dc:c3', {
      name: 'g3',
      folder: 'opt3',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    // 1-minute idle threshold for fast tests.
    writeOptIn('opt3', { idleMin: 1 });

    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c3',
      message_id: 'm1',
      sent_at: new Date(t0).toISOString(),
      sender: 'u1',
      sender_name: 'Alice',
      text: 'hello',
    });
    putChatMessage({
      platform: 'discord',
      chat_id: 'c3',
      message_id: 'm2',
      sent_at: new Date(t0 + 30_000).toISOString(),
      sender: 'u1',
      sender_name: 'Alice',
      text: 'follow-up',
    });
    noteMessage('discord', 'c3', 'm1', new Date(t0).toISOString());
    noteMessage('discord', 'c3', 'm2', new Date(t0 + 30_000).toISOString());

    // Now is 90s after the last message — exceeds 60s idle.
    flushIdle(t0 + 30_000 + 90_000);

    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('idle');
    expect(events[0].message_count).toBe(2);
    expect(events[0].message_ids).toEqual(['m1', 'm2']);
    expect(events[0].transcript).toContain('Alice');
    expect(events[0].transcript).toContain('hello');
    expect(events[0].transcript).toContain('follow-up');
    expect(events[0].participants).toEqual(['Alice']);
    expect(events[0].group_folder).toBe('opt3');
    expect(_peekWindow('discord', 'c3')).toBeUndefined();
  });

  it('flushes on cap when the message count reaches window_cap', () => {
    setRegisteredGroup('dc:c4', {
      name: 'g4',
      folder: 'opt4',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt4', { cap: 3 });
    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    for (let i = 1; i <= 3; i++) {
      const t = t0 + i * 1000;
      putChatMessage({
        platform: 'discord',
        chat_id: 'c4',
        message_id: `m${i}`,
        sent_at: new Date(t).toISOString(),
        sender: 'u1',
        sender_name: 'Bob',
        text: `msg ${i}`,
      });
      noteMessage('discord', 'c4', `m${i}`, new Date(t).toISOString());
    }
    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('cap');
    expect(events[0].message_count).toBe(3);
    expect(_peekWindow('discord', 'c4')).toBeUndefined();
  });

  it('excludes message_ids passed to noteSave from the flushed transcript', () => {
    setRegisteredGroup('dc:c5', {
      name: 'g5',
      folder: 'opt5',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt5', { idleMin: 1 });
    const events = captured();
    const t0 = new Date('2026-04-27T12:00:00.000Z').getTime();
    for (const id of ['m1', 'm2', 'm3']) {
      putChatMessage({
        platform: 'discord',
        chat_id: 'c5',
        message_id: id,
        sent_at: new Date(t0).toISOString(),
        sender: 'u1',
        sender_name: 'Carol',
        text: `text ${id}`,
      });
      noteMessage('discord', 'c5', id, new Date(t0).toISOString());
    }
    noteSave('discord', 'c5', 'm2');
    flushIdle(t0 + 5 * 60_000);

    expect(events).toHaveLength(1);
    expect(events[0].message_ids).toEqual(['m1', 'm3']);
    expect(events[0].transcript).not.toContain('text m2');
    expect(events[0].transcript).toContain('text m1');
    expect(events[0].transcript).toContain('text m3');
  });

  it('flushAll emits with reason="shutdown" for every open window', () => {
    setRegisteredGroup('dc:c6', {
      name: 'g6',
      folder: 'opt6',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    setRegisteredGroup('sig:group:c7', {
      name: 'g7',
      folder: 'opt7',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt6');
    writeOptIn('opt7');
    const events = captured();
    const now = new Date().toISOString();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c6',
      message_id: 'mA',
      sent_at: now,
      sender: 'u',
      sender_name: 'X',
      text: 'a',
    });
    noteMessage('discord', 'c6', 'mA', now);
    putChatMessage({
      platform: 'signal',
      chat_id: 'c7',
      message_id: 'mB',
      sent_at: now,
      sender: 'u',
      sender_name: 'Y',
      text: 'b',
    });
    noteMessage('signal', 'c7', 'mB', now);

    flushAll('shutdown');

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.flush_reason === 'shutdown')).toBe(true);
    expect(_peekWindow('discord', 'c6')).toBeUndefined();
    expect(_peekWindow('signal', 'c7')).toBeUndefined();
  });

  it('flushAll on an empty state map is a no-op', () => {
    const events = captured();
    flushAll('shutdown');
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/window-flusher.test.ts`
Expected: FAIL with "Cannot find module '../window-flusher.js'".

- [ ] **Step 3: Implement core state machine**

Create `src/brain/window-flusher.ts`:

```ts
/**
 * Per-(platform, chat_id) window state machine for chat → brain ingest.
 *
 * State is in-memory only. A process restart forfeits the current open
 * window for each chat (acceptable v1 — windows are short-lived). The
 * `flushAll('shutdown')` path is wired into stopBrainIngest so SIGTERM
 * still emits one event per open window before exit.
 */

import { eventBus } from '../event-bus.js';
import type { ChatWindowFlushedEvent } from '../events.js';
import { logger } from '../logger.js';
import {
  listChatMessages,
  type ChatMessageRow,
  registerChatMessageObserver,
} from '../chat-message-cache.js';

import {
  readChatIngestConfig,
  resolveGroupForChat,
} from './group-frontmatter.js';

// --- Defaults / env --------------------------------------------------------

const DEFAULT_IDLE_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_CAP = 50;
const DEFAULT_DAILY_FLUSH_HOUR = 23;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getIdleMs(): number {
  return envInt('WINDOW_IDLE_MS', DEFAULT_IDLE_MS);
}
export function getCap(): number {
  return envInt('WINDOW_CAP', DEFAULT_CAP);
}
export function getDailyFlushHour(): number {
  const h = envInt('WINDOW_DAILY_FLUSH_HOUR', DEFAULT_DAILY_FLUSH_HOUR);
  return h >= 0 && h < 24 ? h : DEFAULT_DAILY_FLUSH_HOUR;
}

// --- State -----------------------------------------------------------------

interface WindowState {
  platform: 'discord' | 'signal';
  chat_id: string;
  group_folder: string;
  group_jid: string;
  started_at: string; // ISO of first message
  last_at: string; // ISO of latest message
  message_ids: string[];
  excluded_message_ids: Set<string>;
  idle_ms: number;
  cap: number;
}

const windows = new Map<string, WindowState>();

function key(platform: string, chat_id: string): string {
  return `${platform}:${chat_id}`;
}

/** Test helper — inspect a window without mutating it. */
export function _peekWindow(
  platform: 'discord' | 'signal',
  chat_id: string,
): WindowState | undefined {
  return windows.get(key(platform, chat_id));
}

/** Test helper — drop all windows. */
export function _resetWindowState(): void {
  windows.clear();
}

// --- noteMessage / noteSave -----------------------------------------------

/**
 * Called once per inbound chat message (registered as a chat-message-cache
 * observer). Opens a window if the chat is opted in; appends the id; flushes
 * on cap.
 */
export function noteMessage(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
  sent_at: string,
): void {
  const resolved = resolveGroupForChat(platform, chat_id);
  if (!resolved) return;
  const cfg = readChatIngestConfig(resolved.folder);
  if (cfg.brain_ingest !== 'window') return;

  const k = key(platform, chat_id);
  let w = windows.get(k);
  if (!w) {
    const idleMs =
      (cfg.window_idle_min ?? 0) > 0
        ? (cfg.window_idle_min as number) * 60_000
        : getIdleMs();
    const cap =
      (cfg.window_cap ?? 0) > 0 ? (cfg.window_cap as number) : getCap();
    w = {
      platform,
      chat_id,
      group_folder: resolved.folder,
      group_jid: resolved.jid,
      started_at: sent_at,
      last_at: sent_at,
      message_ids: [],
      excluded_message_ids: new Set(),
      idle_ms: idleMs,
      cap,
    };
    windows.set(k, w);
  }
  if (!w.message_ids.includes(message_id)) {
    w.message_ids.push(message_id);
    w.last_at = sent_at;
  }
  if (w.message_ids.length >= w.cap) {
    flushOne(w, 'cap');
  }
}

/**
 * Called when a single-message save fires inside an open window. Records the
 * id in the per-window excluded set so the flushed transcript skips it (avoids
 * double-ingest while preserving both signals).
 */
export function noteSave(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): void {
  const w = windows.get(key(platform, chat_id));
  if (!w) return;
  w.excluded_message_ids.add(message_id);
}

// --- Flushing --------------------------------------------------------------

/**
 * Emit a ChatWindowFlushedEvent for the given window and remove it from state.
 * Builds the transcript from cache, omitting excluded ids. Skips emission if
 * no non-excluded messages remain.
 */
function flushOne(
  w: WindowState,
  reason: ChatWindowFlushedEvent['flush_reason'],
): void {
  windows.delete(key(w.platform, w.chat_id));
  const includedIds = w.message_ids.filter(
    (id) => !w.excluded_message_ids.has(id),
  );
  if (includedIds.length === 0) {
    logger.info(
      { platform: w.platform, chat_id: w.chat_id, reason },
      'window-flusher: skip emit — all messages excluded',
    );
    return;
  }
  // Pull cached rows; keep only those still in the included list.
  const allRows = listChatMessages(w.platform, w.chat_id, {
    limit: 500,
    sinceIso: w.started_at,
  });
  const byId = new Map(allRows.map((r) => [r.message_id, r]));
  const rows = includedIds
    .map((id) => byId.get(id))
    .filter((r): r is ChatMessageRow => Boolean(r))
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  if (rows.length === 0) {
    logger.warn(
      { platform: w.platform, chat_id: w.chat_id, reason },
      'window-flusher: skip emit — no cached rows for window ids (cache evicted?)',
    );
    return;
  }

  const transcript = rows
    .map((r) =>
      `[${r.sent_at}] ${r.sender_name ?? r.sender}: ${r.text ?? ''}`.trim(),
    )
    .join('\n');
  const participantSet = new Set<string>();
  for (const r of rows) participantSet.add(r.sender_name ?? r.sender);
  const participants = [...participantSet];

  const evt: ChatWindowFlushedEvent = {
    type: 'chat.window.flushed',
    source: w.platform,
    timestamp: Date.now(),
    platform: w.platform,
    chat_id: w.chat_id,
    window_started_at: w.started_at,
    window_ended_at: w.last_at,
    message_count: rows.length,
    transcript,
    message_ids: rows.map((r) => r.message_id),
    participants,
    flush_reason: reason,
    group_folder: w.group_folder,
    payload: {},
  };
  eventBus.emit('chat.window.flushed', evt);
}

/**
 * Walk every open window; emit on those whose last_at is older than idle_ms.
 * `now` is injectable for tests.
 */
export function flushIdle(now: number = Date.now()): void {
  for (const w of [...windows.values()]) {
    const lastMs = Date.parse(w.last_at);
    if (Number.isFinite(lastMs) && now - lastMs >= w.idle_ms) {
      flushOne(w, 'idle');
    }
  }
}

/** Flush every open window with the given reason. Used for daily/shutdown. */
export function flushAll(reason: ChatWindowFlushedEvent['flush_reason']): void {
  for (const w of [...windows.values()]) {
    flushOne(w, reason);
  }
}

// --- Lifecycle (timer + observer) wired in Task 5/6 ------------------------

let observerRegistered = false;

export function _registerObserver(): void {
  if (observerRegistered) return;
  registerChatMessageObserver((msg) => {
    if (msg.platform !== 'discord' && msg.platform !== 'signal') return;
    noteMessage(msg.platform, msg.chat_id, msg.message_id, msg.sent_at);
  });
  observerRegistered = true;
}

export function _unregisterObserver(): void {
  if (!observerRegistered) return;
  registerChatMessageObserver(null);
  observerRegistered = false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/window-flusher.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/window-flusher.ts src/brain/__tests__/window-flusher.test.ts
git commit -m "feat(brain): window flusher state machine — idle, cap, race exclusion"
```

---

## Task 5: Window flusher — daily flush + setInterval ticker

**Files:**

- Modify: `src/brain/window-flusher.ts`
- Modify: `src/brain/__tests__/window-flusher.test.ts`

Add the per-minute ticker and the daily-flush-hour check. Keep both injectable for tests (`tickInterval`, `now()`).

- [ ] **Step 1: Append the failing tests**

Append to `src/brain/__tests__/window-flusher.test.ts`, inside the existing `describe('window-flusher', ...)` block (before the closing brace):

```ts
  it('startWindowFlusher schedules a tick that triggers idle flushes', async () => {
    setRegisteredGroup('dc:c8', {
      name: 'g8',
      folder: 'opt8',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt8', { idleMin: 1 });
    const events = captured();
    const sentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c8',
      message_id: 'mT',
      sent_at: sentAt,
      sender: 'u',
      sender_name: 'Tic',
      text: 'tick test',
    });
    noteMessage('discord', 'c8', 'mT', sentAt);

    const { startWindowFlusher, stopWindowFlusher } = await import(
      '../window-flusher.js'
    );
    startWindowFlusher({ tickIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    stopWindowFlusher();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].flush_reason).toBe('idle');
  });

  it('daily flush fires once per day when local hour crosses the threshold', async () => {
    setRegisteredGroup('dc:c9', {
      name: 'g9',
      folder: 'opt9',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt9');
    const events = captured();
    const now = Date.now();
    putChatMessage({
      platform: 'discord',
      chat_id: 'c9',
      message_id: 'mD',
      sent_at: new Date(now).toISOString(),
      sender: 'u',
      sender_name: 'Day',
      text: 'daily test',
    });
    noteMessage('discord', 'c9', 'mD', new Date(now).toISOString());

    const { _runDailyCheck } = await import('../window-flusher.js');
    // Pretend it's exactly the daily-flush hour today and we haven't fired.
    const today = new Date(now);
    today.setHours(getDailyFlushHourForTest(), 0, 0, 0);
    _runDailyCheck(today.getTime());

    expect(events).toHaveLength(1);
    expect(events[0].flush_reason).toBe('daily');

    // A second call within the same day should NOT fire again.
    _runDailyCheck(today.getTime() + 60_000);
    expect(events).toHaveLength(1);
  });
});

function getDailyFlushHourForTest(): number {
  const h = Number(process.env.WINDOW_DAILY_FLUSH_HOUR ?? '23');
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : 23;
}
```

(Note: the trailing `getDailyFlushHourForTest` helper goes _after_ the closing `});` of the `describe` block.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/brain/__tests__/window-flusher.test.ts -t "schedules a tick"`
Expected: FAIL — `startWindowFlusher` is not exported.

- [ ] **Step 3: Add daily-check + ticker to `src/brain/window-flusher.ts`**

Append to the bottom of `src/brain/window-flusher.ts`:

```ts
// --- Daily flush + ticker --------------------------------------------------

let lastDailyFlushDay: string | null = null;

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Test/internal: run one daily-flush check at the given wall-clock instant. */
export function _runDailyCheck(now: number = Date.now()): void {
  const hour = new Date(now).getHours();
  if (hour < getDailyFlushHour()) return;
  const day = localDayKey(now);
  if (lastDailyFlushDay === day) return;
  lastDailyFlushDay = day;
  flushAll('daily');
}

let timer: NodeJS.Timeout | null = null;

export interface WindowFlusherOptions {
  /** Override the per-tick interval. Default: 60_000 (one minute). */
  tickIntervalMs?: number;
}

/**
 * Start the per-minute ticker and register the chat-message observer. Safe
 * to call multiple times — second call is a no-op.
 */
export function startWindowFlusher(opts: WindowFlusherOptions = {}): void {
  if (timer) return;
  _registerObserver();
  const interval = opts.tickIntervalMs ?? 60_000;
  timer = setInterval(() => {
    try {
      flushIdle();
      _runDailyCheck();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'window-flusher: tick failed',
      );
    }
  }, interval);
  // Don't keep the event loop alive on its own — tests and graceful
  // shutdown should not hang on this timer.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(
    { idle_ms: getIdleMs(), cap: getCap(), daily_hour: getDailyFlushHour() },
    'Window flusher started',
  );
}

/**
 * Stop the ticker and emit `flush_reason='shutdown'` for every still-open
 * window. Wired into stopBrainIngest in Task 6.
 */
export function stopWindowFlusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  _unregisterObserver();
  flushAll('shutdown');
  lastDailyFlushDay = null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/brain/__tests__/window-flusher.test.ts`
Expected: PASS — 9 tests total now.

- [ ] **Step 5: Commit**

```bash
git add src/brain/window-flusher.ts src/brain/__tests__/window-flusher.test.ts
git commit -m "feat(brain): window flusher daily/shutdown flush + per-minute ticker"
```

---

## Task 6: Wire window flusher into chat-ingest start/stop

**Files:**

- Modify: `src/brain/chat-ingest.ts`

`startChatIngest`/`stopChatIngest` are the existing entry points called from `startBrainIngest`/`stopBrainIngest`. Piggyback on them so `index.ts`'s SIGTERM path automatically drains open windows.

- [ ] **Step 1: Add imports**

Open `src/brain/chat-ingest.ts`. After the existing import block (the last existing import is `import { newId } from './ulid.js';`), insert:

```ts
import { startWindowFlusher, stopWindowFlusher } from './window-flusher.js';
```

- [ ] **Step 2: Wire into `startChatIngest`**

In `startChatIngest`, after the existing `unsubscribe = eventBus.on('chat.message.saved', ...)` block but before the trailing `logger.info(...)`, insert:

```ts
startWindowFlusher();
```

- [ ] **Step 3: Wire into `stopChatIngest`**

In `stopChatIngest`, change the body so it always invokes `stopWindowFlusher()`:

```ts
export function stopChatIngest(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  stopWindowFlusher();
}
```

- [ ] **Step 4: Type-check + run brain tests**

Run: `npx tsc --noEmit -p .`
Expected: PASS.

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts src/brain/__tests__/window-flusher.test.ts`
Expected: PASS — both files green.

- [ ] **Step 5: Commit**

```bash
git add src/brain/chat-ingest.ts
git commit -m "feat(brain): start/stop window flusher alongside chat ingest"
```

---

## Task 7: LLM budget partition for chat extraction

**Files:**

- Modify: `src/brain/extract.ts`
- Create: `src/brain/__tests__/extract-budget.test.ts`

Today `extractLLM` uses one daily LLM budget for everything. Add a chat slice (`BRAIN_LLM_BUDGET_CHAT_PCT`, default 30%) so windowed/single chat extraction can never exceed `chatPct% × budget` of the daily ceiling. Email retains its existing path. Both still share the overall ceiling.

- [ ] **Step 1: Write the failing test**

Create `src/brain/__tests__/extract-budget.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmp;
  },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  extractLLM,
  getTodaysExtractSpend,
  getDailyLlmBudgetUsd,
} from '../extract.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-budget-'));
  process.env.BRAIN_LLM_DAILY_BUDGET_USD = '0.10';
  process.env.BRAIN_LLM_BUDGET_CHAT_PCT = '30'; // 30% of $0.10 = $0.03
});

afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.BRAIN_LLM_DAILY_BUDGET_USD;
  delete process.env.BRAIN_LLM_BUDGET_CHAT_PCT;
});

describe('extract budget partition', () => {
  it('chat extraction is gated when extract_chat spend reaches the chat slice', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    // Pre-fill the chat slice to its cap.
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('seed', ?, 'anthropic', 'extract_chat', 100, 0.03, ?)`,
    ).run(today, new Date().toISOString());

    expect(getTodaysExtractSpend(db, today, 'chat')).toBeCloseTo(0.03, 5);
    expect(getTodaysExtractSpend(db, today)).toBeCloseTo(0.03, 5);

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'something to extract', mode: 'chat_single' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('email extraction is unaffected by chat-slice spend', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('seed', ?, 'anthropic', 'extract_chat', 100, 0.03, ?)`,
    ).run(today, new Date().toISOString());

    const llm = vi.fn(async () => ({
      claims: [
        { text: 'a', topic_seed: 't', confidence: 0.9, entities_mentioned: [] },
      ],
      inputTokens: 1,
      outputTokens: 1,
    }));
    const claims = await extractLLM(
      { text: 'pay $5,000 by Friday', mode: 'email' },
      { llmCaller: llm, db, day: today, signalScore: 1 },
    );
    expect(claims.length).toBe(1);
    expect(llm).toHaveBeenCalled();
  });

  it('email extraction is gated when overall spend exceeds the budget', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('over', ?, 'anthropic', 'extract', 100, ?, ?)`,
    ).run(today, getDailyLlmBudgetUsd(), new Date().toISOString());

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'pay $5,000 by Friday', mode: 'email' },
      { llmCaller: llm, db, day: today, signalScore: 1 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('chat extraction is gated when overall spend exceeds the budget', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    // Email spent the full budget — chat must also stop.
    db.prepare(
      `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
       VALUES ('over', ?, 'anthropic', 'extract', 100, ?, ?)`,
    ).run(today, getDailyLlmBudgetUsd(), new Date().toISOString());

    const llm = vi.fn();
    const claims = await extractLLM(
      { text: 'meaningful chat content', mode: 'chat_window' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    expect(claims).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('records chat-mode cost under operation=extract_chat', async () => {
    const db = getBrainDb();
    const today = '2026-04-27';
    const llm = vi.fn(async () => ({
      claims: [
        { text: 'a', topic_seed: 't', confidence: 0.9, entities_mentioned: [] },
      ],
      inputTokens: 1000,
      outputTokens: 500,
    }));
    await extractLLM(
      { text: 'chat content', mode: 'chat_single' },
      { llmCaller: llm, db, day: today, signalScore: 0 },
    );
    const chatSpend = getTodaysExtractSpend(db, today, 'chat');
    const emailSpend = getTodaysExtractSpend(db, today, 'email');
    expect(chatSpend).toBeGreaterThan(0);
    expect(emailSpend).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/brain/__tests__/extract-budget.test.ts`
Expected: FAIL — `getTodaysExtractSpend(db, today, 'chat')` rejects the third argument; chat-slice gating doesn't exist yet.

- [ ] **Step 3: Update `getTodaysExtractSpend` signature**

In `src/brain/extract.ts`, replace the existing `getTodaysExtractSpend` function with:

```ts
export type ExtractCategory = 'email' | 'chat';

/**
 * Sum today's Anthropic extract spend. With no `category`, sums across both
 * email (`operation='extract'`) and chat (`operation='extract_chat'`). With a
 * category, filters to that operation tag.
 */
export function getTodaysExtractSpend(
  db: Database.Database,
  day: string = todayStr(),
  category?: ExtractCategory,
): number {
  if (!category) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log
         WHERE day = ? AND provider = 'anthropic'
           AND operation IN ('extract', 'extract_chat')`,
      )
      .get(day) as { total: number };
    return row.total;
  }
  const op = category === 'chat' ? 'extract_chat' : 'extract';
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log
       WHERE day = ? AND provider = 'anthropic' AND operation = ?`,
    )
    .get(day, op) as { total: number };
  return row.total;
}
```

- [ ] **Step 4: Add `getChatBudgetPct` and category-aware `writeCost`**

Below `getDailyLlmBudgetUsd`, add:

```ts
/**
 * Resolve the chat-extraction slice as a fraction of the overall daily LLM
 * budget. Reads `BRAIN_LLM_BUDGET_CHAT_PCT` (integer percent, 0–100); falls
 * back to 30 if unset, blank, non-numeric, or out of range.
 */
export function getChatBudgetPct(): number {
  const raw = process.env.BRAIN_LLM_BUDGET_CHAT_PCT;
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 30;
  return n;
}
```

Replace the existing `writeCost` with:

```ts
function writeCost(
  db: Database.Database,
  day: string,
  units: number,
  costUsd: number,
  category: ExtractCategory = 'email',
): void {
  const op = category === 'chat' ? 'extract_chat' : 'extract';
  db.prepare(
    `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
     VALUES (?, ?, 'anthropic', ?, ?, ?, ?)`,
  ).run(newId(), day, op, units, costUsd, new Date().toISOString());
}
```

- [ ] **Step 5: Update `extractLLM` gating + cost recording**

In `extractLLM`, replace the budget-check block (currently `const spent = getTodaysExtractSpend(db, day); const budget = getDailyLlmBudgetUsd(); if (spent >= budget) { ... return []; }`) with:

```ts
const budget = getDailyLlmBudgetUsd();
const totalSpent = getTodaysExtractSpend(db, day);
if (totalSpent >= budget) {
  logger.warn(
    { spent: totalSpent, budget, day },
    'extractLLM: daily budget exceeded — skipping LLM tier',
  );
  return [];
}
if (isChat) {
  const chatBudget = budget * (getChatBudgetPct() / 100);
  const chatSpent = getTodaysExtractSpend(db, day, 'chat');
  if (chatSpent >= chatBudget) {
    logger.warn(
      { chatSpent, chatBudget, day },
      'extractLLM: chat-slice budget exceeded — skipping chat LLM tier',
    );
    return [];
  }
}
```

In the same function, update the `writeCost` call (currently `writeCost(db, day, response.inputTokens + response.outputTokens, cost);`) to pass the category:

```ts
writeCost(
  db,
  day,
  response.inputTokens + response.outputTokens,
  cost,
  isChat ? 'chat' : 'email',
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/brain/__tests__/extract-budget.test.ts`
Expected: PASS — 5 tests.

Also re-run the existing extract test suite to confirm no regression:

Run: `npx vitest run src/brain/__tests__/extract.test.ts`
Expected: PASS — existing email-mode behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/brain/extract.ts src/brain/__tests__/extract-budget.test.ts
git commit -m "feat(brain): partition LLM budget — chat slice via BRAIN_LLM_BUDGET_CHAT_PCT"
```

---

## Task 8: `chat.window.flushed` handler in chat-ingest

**Files:**

- Modify: `src/brain/chat-ingest.ts`
- Modify: `src/brain/__tests__/chat-ingest.test.ts`

Mirror the existing `handleChatMessageSaved` path: insert `raw_events` (deduped by source_ref), run `extractPipeline(mode='chat_window')`, resolve participants → entities, link every KU to every participant, embed + Qdrant upsert. Source_type is `${platform}_window`; source_ref is `${chat_id}:${window_started_at}`. The full event (including `message_ids`) goes into `raw_events.payload` so PR 4 edit-sync can locate windowed messages by membership.

- [ ] **Step 1: Append the failing test**

Append to `src/brain/__tests__/chat-ingest.test.ts`, inside the existing `describe('chat-ingest', ...)` block (before the closing `});`):

```ts
it('inserts raw_events + KUs + participant links for a flushed window', async () => {
  const fakeLlm = vi.fn(async () => ({
    claims: [
      {
        text: 'Decided to go with Vendor A for Q3',
        topic_seed: 'vendor selection',
        entities_mentioned: [],
        confidence: 0.9,
      },
      {
        text: 'Vendor B rejected — pricing model incompatible',
        topic_seed: 'vendor rejection',
        entities_mentioned: [],
        confidence: 0.85,
      },
    ],
    inputTokens: 200,
    outputTokens: 80,
  }));

  startChatIngest({ llmCaller: fakeLlm });

  const evt = {
    type: 'chat.window.flushed' as const,
    source: 'signal' as const,
    timestamp: Date.now(),
    payload: {},
    platform: 'signal' as const,
    chat_id: 'group-xyz',
    window_started_at: '2026-04-27T14:00:00.000Z',
    window_ended_at: '2026-04-27T14:32:00.000Z',
    message_count: 18,
    transcript: '[14:00] Alice: ...\n[14:32] Bob: ...',
    message_ids: ['m1', 'm2', 'm3'],
    participants: ['Alice', 'Bob'],
    flush_reason: 'idle' as const,
    group_folder: 'opt-window',
  };

  eventBus.emit('chat.window.flushed', evt);
  await wait(1500);

  const db = getBrainDb();

  const raw = db
    .prepare(`SELECT * FROM raw_events WHERE source_type = 'signal_window'`)
    .get() as { source_ref: string; payload: Buffer } | undefined;
  expect(raw).toBeDefined();
  expect(raw!.source_ref).toBe('group-xyz:2026-04-27T14:00:00.000Z');
  const payload = JSON.parse(raw!.payload.toString('utf8'));
  expect(payload.message_ids).toEqual(['m1', 'm2', 'm3']);

  const kuCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_units WHERE source_type = 'signal_window'`,
      )
      .get() as { n: number }
  ).n;
  expect(kuCount).toBe(2);

  // Both participants exist as person entities, and every KU links to both.
  const linkRows = db
    .prepare(
      `SELECT ku_id, entity_id FROM ku_entities
         WHERE ku_id IN (SELECT id FROM knowledge_units WHERE source_type='signal_window')`,
    )
    .all() as Array<{ ku_id: string; entity_id: string }>;
  expect(linkRows.length).toBe(4); // 2 KUs × 2 participants

  expect(qdrantUpsertMock).toHaveBeenCalledTimes(2);
});

it('window flush dedups via raw_events UNIQUE — same window_started_at twice yields one row', async () => {
  const fakeLlm = vi.fn(async () => ({
    claims: [],
    inputTokens: 10,
    outputTokens: 5,
  }));
  startChatIngest({ llmCaller: fakeLlm });

  const evt = {
    type: 'chat.window.flushed' as const,
    source: 'discord' as const,
    timestamp: Date.now(),
    payload: {},
    platform: 'discord' as const,
    chat_id: 'channel-dup',
    window_started_at: '2026-04-27T15:00:00.000Z',
    window_ended_at: '2026-04-27T15:15:00.000Z',
    message_count: 1,
    transcript: '[15:00] X: hi',
    message_ids: ['m1'],
    participants: ['X'],
    flush_reason: 'idle' as const,
    group_folder: 'opt-dup',
  };

  eventBus.emit('chat.window.flushed', evt);
  eventBus.emit('chat.window.flushed', evt);
  await wait(1500);

  const db = getBrainDb();
  const n = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM raw_events WHERE source_type='discord_window'`,
      )
      .get() as { n: number }
  ).n;
  expect(n).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts -t "flushed window"`
Expected: FAIL — `chat.window.flushed` has no handler.

- [ ] **Step 3: Add the handler in `src/brain/chat-ingest.ts`**

Add to the existing imports at the top of the file:

```ts
import type {
  ChatMessageSavedEvent,
  ChatWindowFlushedEvent,
} from '../events.js';
```

(Replace the existing `import type { ChatMessageSavedEvent } from '../events.js';`.)

Below the existing `let unsubscribe: (() => void) | null = null;`, add a second slot:

```ts
let unsubscribeWindow: (() => void) | null = null;
```

Update `startChatIngest` to also subscribe to the window event. After the existing `unsubscribe = eventBus.on('chat.message.saved', ...)` block, insert:

```ts
unsubscribeWindow = eventBus.on(
  'chat.window.flushed',
  async (evt: ChatWindowFlushedEvent) => {
    try {
      await handleChatWindowFlushed(evt, opts);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chat_id: evt.chat_id,
          window_started_at: evt.window_started_at,
        },
        'chat ingest: window handler failed',
      );
    }
  },
);
```

Update `stopChatIngest` to unsubscribe both:

```ts
export function stopChatIngest(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeWindow) {
    unsubscribeWindow();
    unsubscribeWindow = null;
  }
  stopWindowFlusher();
}
```

Append the new handler at the bottom of the file:

```ts
async function handleChatWindowFlushed(
  evt: ChatWindowFlushedEvent,
  opts: ChatIngestOpts,
): Promise<void> {
  const db = getBrainDb();
  const sourceType = `${evt.platform}_window`;
  const sourceRef = `${evt.chat_id}:${evt.window_started_at}`;
  const receivedAt = new Date(evt.timestamp).toISOString();

  // 1. Idempotent raw_events insert. Payload carries the full event so PR 4
  //    edit-sync can locate windowed messages by message_ids[].
  const rawId = newId();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      rawId,
      sourceType,
      sourceRef,
      Buffer.from(JSON.stringify(evt), 'utf8'),
      receivedAt,
    );
  if (result.changes === 0) {
    logger.debug(
      { sourceRef },
      'chat ingest: duplicate window raw_event, skipping',
    );
    return;
  }

  // 2. Extract claims from the transcript with chat_window mode (uses the
  //    transcript-aware prompt and bypasses the email signal-score gate).
  const claims = await extractPipeline(
    {
      text: evt.transcript,
      mode: 'chat_window',
      participants: evt.participants,
    },
    { llmCaller: opts.llmCaller, db },
  );

  // 3. Resolve every participant → entity. Use sender_display where the
  //    flusher captured one (it's already deduped in evt.participants).
  const participantEntityIds: string[] = [];
  for (const handle of evt.participants) {
    try {
      const entity = await createPersonFromHandle(evt.platform, handle, handle);
      participantEntityIds.push(entity.entity_id);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          handle,
        },
        'chat ingest: window participant resolve failed',
      );
    }
  }

  if (claims.length === 0) {
    db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
      receivedAt,
      rawId,
    );
    return;
  }

  // 4. KU + ku_entities (one link per participant) in a single transaction.
  const nowIso = new Date().toISOString();
  const validFrom = evt.window_ended_at;
  const insertKu = db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, confidence,
        valid_from, recorded_at, topic_key, extracted_by, needs_review)
     VALUES (?, ?, ?, ?, 'personal', NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
  );

  const kuRows: Array<{ id: string; text: string; topicKey: string | null }> =
    [];

  db.transaction(() => {
    for (const claim of claims) {
      const kuId = newId();
      insertKu.run(
        kuId,
        claim.text,
        sourceType,
        sourceRef,
        claim.confidence,
        validFrom,
        nowIso,
        claim.topic_key ?? null,
        claim.extracted_by,
        claim.needs_review ? 1 : 0,
      );
      for (const eid of participantEntityIds) {
        insertLink.run(kuId, eid);
      }
      kuRows.push({
        id: kuId,
        text: claim.text,
        topicKey: claim.topic_key ?? null,
      });
    }
  })();

  // 5. Embed + upsert (best-effort).
  const modelVersion = getEmbeddingModelVersion();
  for (const ku of kuRows) {
    try {
      const vec = await embedText(ku.text, 'document');
      await upsertKu({
        kuId: ku.id,
        vector: vec,
        payload: {
          account: 'personal',
          scope: null,
          model_version: modelVersion,
          valid_from: validFrom,
          recorded_at: nowIso,
          source_type: sourceType,
          topic_key: ku.topicKey ?? null,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          kuId: ku.id,
        },
        'chat ingest (window): embed/upsert failed — KU stands without vector',
      );
    }
  }

  db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
    nowIso,
    rawId,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts`
Expected: PASS — all existing tests + 2 new window tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/chat-ingest.ts src/brain/__tests__/chat-ingest.test.ts
git commit -m "feat(brain): chat.window.flushed → raw_events → extract → KU"
```

---

## Task 9: Race resolution — `noteSave` from single-message handler

**Files:**

- Modify: `src/brain/chat-ingest.ts`
- Modify: `src/brain/__tests__/chat-ingest.test.ts`

When a 🧠-react fires inside an opted-in chat with an open window, the operator's deliberate save runs immediately (existing PR 1 path). Add a one-line call into the window-flusher's `noteSave` so the windowed flush at idle/cap excludes the same message_id and avoids double-ingesting it.

- [ ] **Step 1: Write the failing test**

Append to `src/brain/__tests__/chat-ingest.test.ts`, inside the existing `describe('chat-ingest', ...)` block:

```ts
it('a saved message inside an open window is recorded as excluded', async () => {
  // Mock noteSave to confirm the chat-ingest handler calls it.
  const noteSaveSpy = vi.fn();
  vi.doMock('../window-flusher.js', async () => {
    const real = await vi.importActual<typeof import('../window-flusher.js')>(
      '../window-flusher.js',
    );
    return { ...real, noteSave: noteSaveSpy };
  });
  // Re-import chat-ingest so it picks up the mocked noteSave.
  const { startChatIngest: startMocked, stopChatIngest: stopMocked } =
    await import('../chat-ingest.js');

  const fakeLlm = vi.fn(async () => ({
    claims: [],
    inputTokens: 10,
    outputTokens: 5,
  }));
  startMocked({ llmCaller: fakeLlm });

  const evt: ChatMessageSavedEvent = {
    type: 'chat.message.saved',
    timestamp: Date.now(),
    source: 'discord',
    payload: {},
    platform: 'discord',
    chat_id: 'channel-race',
    message_id: 'msg-race',
    sender: 'u-race',
    sent_at: '2026-04-27T16:00:00.000Z',
    text: 'race-test',
    trigger: 'emoji',
  };
  eventBus.emit('chat.message.saved', evt);
  await wait(1500);
  stopMocked();

  expect(noteSaveSpy).toHaveBeenCalledWith(
    'discord',
    'channel-race',
    'msg-race',
  );

  vi.doUnmock('../window-flusher.js');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts -t "saved message inside an open window"`
Expected: FAIL — `noteSave` is never called.

- [ ] **Step 3: Update the imports**

In `src/brain/chat-ingest.ts`, change the existing window-flusher import:

```ts
import {
  startWindowFlusher,
  stopWindowFlusher,
  noteSave,
} from './window-flusher.js';
```

- [ ] **Step 4: Call `noteSave` from `handleChatMessageSaved`**

In `handleChatMessageSaved`, immediately after the `if (result.changes === 0) { logger.debug(...); return; }` block (right before the `// Step 2:` extraction call), insert:

```ts
// Race resolution: if a window is open for this chat, mark this message
// as excluded so the windowed flush at idle/cap/daily doesn't re-ingest it.
noteSave(evt.platform, evt.chat_id, evt.message_id);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts -t "saved message inside an open window"`
Expected: PASS.

Run the full chat-ingest suite to confirm no regressions:

Run: `npx vitest run src/brain/__tests__/chat-ingest.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/brain/chat-ingest.ts src/brain/__tests__/chat-ingest.test.ts
git commit -m "feat(brain): exclude single-message saves from open windows (race resolution)"
```

---

## Task 10: `.env.example` + manual end-to-end verification

**Files:**

- Modify: `.env.example`
- (operator-run) verification

- [ ] **Step 1: Add new env vars to `.env.example`**

Locate the `BRAIN_*` block (or the section where PR 1 added `BRAIN_SAVE_EMOJI`/`CHAT_CACHE_TTL_HOURS`/etc.). Append:

```
# --- PR 2: chat windowed-ingest tunables ---
WINDOW_IDLE_MS=900000              # 15 min — idle gap before window flush
WINDOW_CAP=50                      # max messages per window before forced flush
WINDOW_DAILY_FLUSH_HOUR=23         # 0–23, local hour for daily flush of all open windows
BRAIN_LLM_BUDGET_CHAT_PCT=30       # share of daily LLM budget reserved for chat (0–100)
```

- [ ] **Step 2: Build + restart**

```bash
npm run build
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

Expected: log line `Window flusher started` with `idle_ms`, `cap`, `daily_hour` fields, plus the existing `Chat ingest started` line.

- [ ] **Step 3: Pick a Signal-side opt-in chat and add frontmatter**

Pick one Signal group (Discord MessageCreate isn't reaching the bot today per the operational note in the task brief — Signal is the verification path). Identify the group folder (`groups/<name>/CLAUDE.md`).

Edit `groups/<that-group>/CLAUDE.md` and add at the top, BEFORE any existing content:

```yaml
---
brain_ingest: window
window_idle_min: 1
---
```

(The `1` minute idle is for verification; revert to default after.)

- [ ] **Step 4: Send messages**

In the Signal chat, send 3–5 normal messages (e.g., "Hi", "I think we should ship Friday", "Budget is approved", "Ok let's go"). Wait at least 90 seconds without further messages.

- [ ] **Step 5: Confirm window flush + KU**

```bash
sqlite3 ~/.nanoclaw/brain.db \
  "SELECT source_type, source_ref, substr(payload,1,80) FROM raw_events WHERE source_type='signal_window' ORDER BY received_at DESC LIMIT 3;"
```

Expected: at least one row with `source_type='signal_window'` and `source_ref` shaped `<chat_id>:<window_started_at_iso>`.

```bash
sqlite3 ~/.nanoclaw/brain.db \
  "SELECT id, source_type, substr(text,1,80) FROM knowledge_units WHERE source_type='signal_window' ORDER BY recorded_at DESC LIMIT 5;"
```

Expected: 1+ KU rows summarizing the window.

- [ ] **Step 6: Race check**

In the same chat, send a fresh message ("This is a brain test"), then react to it with 🧠 within ~30 seconds. Wait again for window flush.

```bash
sqlite3 ~/.nanoclaw/brain.db \
  "SELECT source_type, source_ref FROM knowledge_units ORDER BY recorded_at DESC LIMIT 8;"
```

Expected: a `signal_message` row for the 🧠-react AND a separate `signal_window` row whose transcript does NOT contain the brain-test message body.

To confirm the exclusion:

```bash
sqlite3 ~/.nanoclaw/brain.db \
  "SELECT substr(payload,1,400) FROM raw_events WHERE source_type='signal_window' ORDER BY received_at DESC LIMIT 1;"
```

The `message_ids` array in the JSON payload should NOT include the message_id you reacted to.

- [ ] **Step 7: Revert verification frontmatter**

Edit `groups/<that-group>/CLAUDE.md` and remove `window_idle_min: 1` (keep `brain_ingest: window` if you want to keep ingest enabled for that group; otherwise change to `off`).

- [ ] **Step 8: Empty commit recording the verification result**

```bash
git commit --allow-empty -m "chore(chat): manual verification PR2 — Signal window flush green"
```

---

## Self-Review Checklist (run after writing the plan)

**1. Spec coverage** — every PR-2 phase from the spec maps to a task:

- §6 Window flusher state machine → Tasks 4, 5
- §6 Idle / cap / daily / shutdown flush → Tasks 4, 5
- §6 Per-chat opt-in via groups/<name>/CLAUDE.md → Task 2 (`readChatIngestConfig`)
- §7 chat_window mode wiring (prompt already exists from PR 1; race resolution) → Tasks 8, 9
- §8 Race resolution `excluded_message_ids` → Tasks 4, 9
- §9 chat_id → group lookup using dc:/sig:group: conventions → Task 2 (`resolveGroupForChat`)
- §10 LLM budget partition `BRAIN_LLM_BUDGET_CHAT_PCT` → Task 7
- Failure-mode "Process restart with open window" → Task 5/6 (`stopWindowFlusher` flushes all on shutdown via `stopChatIngest`/`stopBrainIngest`)
- ChatWindowFlushedEvent type → Task 1
- Brain ingest handler for chat.window.flushed → Task 8

**2. Placeholder scan** — no TBD/TODO/"add appropriate error handling"/etc. Code blocks contain real, executable content. Test files contain real assertions, not pseudocode.

**3. Type consistency** —

- `ChatWindowFlushedEvent` declared once in Task 1 and used identically in Tasks 4, 5, 8.
- `ChatIngestConfig` declared once in Task 2 and used in Task 4 (`readChatIngestConfig`).
- `ResolvedGroup` declared in Task 2 and used in Task 4.
- `ExtractCategory` declared in Task 7 and used identically in `getTodaysExtractSpend` and `writeCost`.
- `WindowState` is internal to window-flusher — only `_peekWindow` exposes it for tests.
- `noteMessage(platform, chat_id, message_id, sent_at)` and `noteSave(platform, chat_id, message_id)` signatures are stable across Tasks 4, 5, 9.
- `startWindowFlusher({tickIntervalMs?})` and `stopWindowFlusher()` signatures stable across Tasks 5, 6.
- `registerChatMessageObserver(fn|null)` signature stable across Task 3 and Task 4.

**4. Out-of-scope check** — no edit/delete sync, no identity-merge engine, no `claw merge` command, no attachment summarization in window mode. Each is explicitly deferred to PR 3 or PR 4.

**5. Commit cadence** — 10 commits total, one per task. Each commit produces a buildable, test-green tree.
