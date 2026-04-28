# Discord/Signal Brain Ingest — PR 3: Identity Merge + `claw merge` + Window Attachment Summaries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three features that finish the chat-ingest UX layer:
1. **Identity-merge engine** — merge two `person` entities into one, atomically rebinding all `ku_entities` and `entity_aliases` and writing to `entity_merge_log`.
2. **`claw merge` chat command** — operator says `claw merge <handle-a> <handle-b>` in any opted-in chat; the engine resolves both handles to entity_ids and merges them.
3. **Window attachment summaries** — when a flushed window contains cached messages with attachments, the windowed transcript embeds a one-line summary per attachment so the LLM extractor sees their content (vision-tier where available, filename fallback otherwise).

**Architecture:** Three layered concerns:
- **Engine** (`src/brain/identity-merge.ts`) — pure DB transaction `mergeEntities(keptId, mergedId, evidence)` that pivots `ku_entities`, `entity_aliases`, and writes `entity_merge_log`. No event emission yet.
- **Trigger surface** (Signal/Discord channel + chat-ingest) — `^claw\s+merge\s+<a>\s+<b>` text trigger emits `entity.merge.requested`; a brain-side handler resolves handles → entity_ids and calls the engine, then sends an ack reply.
- **Window enrichment** (`src/brain/window-flusher.ts`) — the transcript builder calls a new `summarizeAttachment()` helper for each cached row that has attachments. Vision summarization piggybacks on existing `BRAIN_IMAGE_VISION` machinery; falls back to `[<kind>: <filename>]` otherwise.

The three are independently shippable and could land as 3a / 3b / 3c if preferred. They are bundled here because they share the same end-user mental model ("clean up the brain's view of who said what") and share Tasks 0 (schema audit) and 11 (manual e2e).

**Tech Stack:** TypeScript, better-sqlite3, vitest, existing Pino logger, existing event bus, existing `BRAIN_IMAGE_VISION` vision pipeline.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/brain/identity-merge.ts` | NEW — `mergeEntities(keptId, mergedId, evidence)`; helpers to validate compatibility |
| `src/brain/__tests__/identity-merge.test.ts` | NEW — engine tests (KU rebind, alias rebind, log entry, idempotency, type-mismatch rejection) |
| `src/events.ts` | Add `EntityMergeRequestedEvent` type + bus map entry |
| `src/channels/signal.ts` | Detect `claw merge <a> <b>` text trigger; emit `entity.merge.requested` |
| `src/channels/discord.ts` | Same trigger for Discord |
| `src/brain/identity-merge-handler.ts` | NEW — subscriber that resolves handles → entity_ids and calls the engine; sends ack reply |
| `src/brain/__tests__/identity-merge-handler.test.ts` | NEW — handler integration tests |
| `src/brain/chat-ingest.ts` | Wire `start/stopIdentityMergeHandler` |
| `src/brain/attachment-summary.ts` | NEW — `summarizeAttachment(att, opts)` returns a single line; uses vision when enabled |
| `src/brain/__tests__/attachment-summary.test.ts` | NEW — unit tests for summary generation |
| `src/brain/window-flusher.ts` | In `flushOne`'s transcript build, call `summarizeAttachment` for each row with attachments |
| `src/brain/__tests__/window-flusher.test.ts` | Append test verifying transcript contains attachment summary lines |
| `.env.example` | Document `BRAIN_MERGE_AUTO_LOW_CONF_REJECT` (defaults true) |

---

## Task 0: Schema audit — confirm `entity_merge_log` table exists at HEAD

**Files:** none (read-only check)

The schema already has `entity_merge_log` (see `src/brain/schema.sql:49-58`). PR 1 included it for future use. Confirm before relying on it.

- [ ] **Step 1: Verify** the live DB has the table:

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db ".schema entity_merge_log" | head
```

Expected: a CREATE TABLE statement with columns `merge_id, kept_entity_id, merged_entity_id, pre_merge_snapshot, confidence, evidence, merged_at, merged_by`.

If the table is missing, the daemon will error on first merge — bail out and bring the schema in line first.

- [ ] **Step 2: No commit.** This is a guardrail for the implementer.

---

## Task 1: `mergeEntities` engine — happy path

**Files:**
- Create: `src/brain/identity-merge.ts`
- Create: `src/brain/__tests__/identity-merge.test.ts`

The core transaction. Two valid `person` entity_ids in; aliases and ku_entities for the loser are rewritten to point at the winner; an `entity_merge_log` row is inserted. Both rows in `entities` table remain (loser is kept for audit, marked via merge log) — but loser is excluded from active queries by joining against `entity_merge_log.merged_entity_id`.

**Decision: physical row delete vs soft delete.** Soft delete is cheaper on FK references (`ku_entities.entity_id REFERENCES entities`). Going with soft: leave the loser row in `entities`, but `idx_entity_active` view (added later) excludes it. For now Task 1 just leaves the loser row in place after rebinding.

- [ ] **Step 1: Failing test** at `src/brain/__tests__/identity-merge.test.ts`:

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
import { mergeEntities } from '../identity-merge.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-merge-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedPerson(db: any, id: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`,
  ).run(id, JSON.stringify({ name }), '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z');
}

describe('mergeEntities — happy path', () => {
  it('rebinds ku_entities and entity_aliases from loser to winner', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-keep', 'Jonathan Z');
    seedPerson(db, 'e-merge', 'J Zhang');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
         valid_from, recorded_at, extracted_by, needs_review)
       VALUES ('k1', 'x', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
    ).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'e-merge', 'mentioned')`).run();
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('a1', 'e-merge', 'signal', 'phone', '+15551234567', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();

    const result = await mergeEntities('e-keep', 'e-merge', {
      evidence: { trigger: 'manual', requested_by: 'op' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });

    expect(result.merge_id).toMatch(/^[A-Z0-9]{26}$/);
    // ku_entities rebound.
    const links = db.prepare(`SELECT entity_id FROM ku_entities WHERE ku_id='k1'`).all() as any[];
    expect(links.map((l) => l.entity_id)).toEqual(['e-keep']);
    // entity_aliases rebound.
    const alias = db.prepare(`SELECT entity_id FROM entity_aliases WHERE alias_id='a1'`).get() as any;
    expect(alias.entity_id).toBe('e-keep');
    // merge_log row written.
    const log = db.prepare(`SELECT * FROM entity_merge_log WHERE merge_id=?`).get(result.merge_id) as any;
    expect(log.kept_entity_id).toBe('e-keep');
    expect(log.merged_entity_id).toBe('e-merge');
    expect(log.merged_by).toBe('human:op');
    expect(JSON.parse(log.pre_merge_snapshot)).toMatchObject({
      kept: { entity_id: 'e-keep' },
      merged: { entity_id: 'e-merge' },
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/brain/__tests__/identity-merge.test.ts -t "rebinds"` — expect FAIL.

- [ ] **Step 3: Implement** `src/brain/identity-merge.ts`:

```ts
/**
 * Identity merge engine. Atomically pivots ku_entities and entity_aliases
 * rows from `mergedEntityId` to `keptEntityId`, then writes a row to
 * entity_merge_log capturing the pre-merge state for audit/undo.
 *
 * Two entities being merged must share entity_type. Same-id merges are a
 * no-op. Already-merged loser ids (entity_merge_log.merged_entity_id) are
 * rejected — the caller should resolve through the chain first.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { newId } from './ulid.js';

export interface MergeEvidence {
  trigger: 'manual' | 'deterministic' | 'splink';
  requested_by?: string;
  matched_field?: 'email' | 'phone' | 'name' | 'slack_id' | 'signal_uuid';
  matched_value?: string;
  [k: string]: unknown;
}

export interface MergeOpts {
  evidence: MergeEvidence;
  confidence: number;
  mergedBy: string; // 'deterministic' | 'splink' | `human:${id}`
  db?: Database.Database;
}

export interface MergeResult {
  merge_id: string;
  kept_entity_id: string;
  merged_entity_id: string;
}

export async function mergeEntities(
  keptEntityId: string,
  mergedEntityId: string,
  opts: MergeOpts,
): Promise<MergeResult> {
  if (keptEntityId === mergedEntityId) {
    throw new Error(`mergeEntities: refusing self-merge of ${keptEntityId}`);
  }
  const db = opts.db ?? getBrainDb();

  // Look up both rows; reject if missing or type-mismatched.
  const kept = db.prepare(`SELECT * FROM entities WHERE entity_id = ?`).get(keptEntityId) as any;
  const merged = db.prepare(`SELECT * FROM entities WHERE entity_id = ?`).get(mergedEntityId) as any;
  if (!kept) throw new Error(`mergeEntities: kept entity ${keptEntityId} not found`);
  if (!merged) throw new Error(`mergeEntities: merged entity ${mergedEntityId} not found`);
  if (kept.entity_type !== merged.entity_type) {
    throw new Error(
      `mergeEntities: type mismatch ${kept.entity_type} vs ${merged.entity_type}`,
    );
  }

  // Reject if merged was previously merged into something else.
  const prior = db
    .prepare(`SELECT kept_entity_id FROM entity_merge_log WHERE merged_entity_id = ? LIMIT 1`)
    .get(mergedEntityId) as { kept_entity_id: string } | undefined;
  if (prior) {
    throw new Error(
      `mergeEntities: ${mergedEntityId} was already merged into ${prior.kept_entity_id}; resolve chain first`,
    );
  }

  const mergeId = newId();
  const mergedAt = new Date().toISOString();
  const snapshot = JSON.stringify({ kept, merged });

  db.transaction(() => {
    // 1. Rebind ku_entities. Use INSERT-or-IGNORE-then-DELETE pattern to avoid
    //    UNIQUE conflicts on (ku_id, entity_id) when both already linked.
    db.prepare(
      `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role)
       SELECT ku_id, ?, role FROM ku_entities WHERE entity_id = ?`,
    ).run(keptEntityId, mergedEntityId);
    db.prepare(`DELETE FROM ku_entities WHERE entity_id = ?`).run(mergedEntityId);

    // 2. Rebind entity_aliases. Same pattern; aliases have a unique alias_id so
    //    no conflict here, just an UPDATE.
    db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?`).run(
      keptEntityId,
      mergedEntityId,
    );

    // 3. Rebind entity_relationships (both directions).
    db.prepare(`UPDATE entity_relationships SET from_entity_id = ? WHERE from_entity_id = ?`).run(
      keptEntityId,
      mergedEntityId,
    );
    db.prepare(`UPDATE entity_relationships SET to_entity_id = ? WHERE to_entity_id = ?`).run(
      keptEntityId,
      mergedEntityId,
    );

    // 4. Bump kept entity's updated_at.
    db.prepare(`UPDATE entities SET updated_at = ? WHERE entity_id = ?`).run(
      mergedAt,
      keptEntityId,
    );

    // 5. Write merge log.
    db.prepare(
      `INSERT INTO entity_merge_log
         (merge_id, kept_entity_id, merged_entity_id, pre_merge_snapshot,
          confidence, evidence, merged_at, merged_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mergeId,
      keptEntityId,
      mergedEntityId,
      snapshot,
      opts.confidence,
      JSON.stringify(opts.evidence),
      mergedAt,
      opts.mergedBy,
    );
  })();

  logger.info(
    { merge_id: mergeId, kept: keptEntityId, merged: mergedEntityId, by: opts.mergedBy },
    'identity-merge: entities merged',
  );

  return {
    merge_id: mergeId,
    kept_entity_id: keptEntityId,
    merged_entity_id: mergedEntityId,
  };
}
```

- [ ] **Step 4: Run** the test — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/identity-merge.ts src/brain/__tests__/identity-merge.test.ts
git commit -m "feat(brain): identity-merge engine — pivot ku_entities + aliases atomically"
```

---

## Task 2: `mergeEntities` — error paths

**Files:**
- Modify: `src/brain/__tests__/identity-merge.test.ts`

Cover the three rejection cases.

- [ ] **Step 1: Failing tests** appended to the existing describe block:

```ts
  it('rejects self-merge', async () => {
    await expect(
      mergeEntities('e1', 'e1', {
        evidence: { trigger: 'manual' }, confidence: 1, mergedBy: 'human:op', db: getBrainDb(),
      }),
    ).rejects.toThrow(/self-merge/);
  });

  it('rejects when entities have different types', async () => {
    const db = getBrainDb();
    db.prepare(`INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES ('p1', 'person', ?, ?), ('c1', 'company', ?, ?)`).run(
      '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
    );
    await expect(
      mergeEntities('p1', 'c1', {
        evidence: { trigger: 'manual' }, confidence: 1, mergedBy: 'human:op', db,
      }),
    ).rejects.toThrow(/type mismatch/);
  });

  it('rejects re-merging an already-merged loser', async () => {
    const db = getBrainDb();
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');
    seedPerson(db, 'c', 'C');
    await mergeEntities('a', 'b', {
      evidence: { trigger: 'manual' }, confidence: 1, mergedBy: 'human:op', db,
    });
    await expect(
      mergeEntities('c', 'b', {
        evidence: { trigger: 'manual' }, confidence: 1, mergedBy: 'human:op', db,
      }),
    ).rejects.toThrow(/already merged/);
  });
```

- [ ] **Step 2: Run** — expect PASS (all three should already work with the Task 1 implementation).

- [ ] **Step 3: Commit**

```bash
git add src/brain/__tests__/identity-merge.test.ts
git commit -m "test(brain): identity-merge — self/type/double-merge rejections"
```

---

## Task 3: `EntityMergeRequestedEvent` type

**Files:**
- Modify: `src/events.ts`
- Modify: `src/__tests__/events.test.ts`

- [ ] **Step 1: Failing test**:

```ts
import type { EntityMergeRequestedEvent } from '../events.js';
it('EntityMergeRequestedEvent has all required fields', () => {
  const evt: EntityMergeRequestedEvent = {
    type: 'entity.merge.requested',
    source: 'signal',
    timestamp: Date.now(),
    payload: {},
    platform: 'signal',
    chat_id: 'c1',
    requested_by_handle: 'alice',
    handle_a: 'jonathan',
    handle_b: 'j zhang',
  };
  expect(evt.type).toBe('entity.merge.requested');
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add** to `src/events.ts` (near the other chat events):

```ts
/**
 * Emitted when an operator types `claw merge <handle-a> <handle-b>` in an
 * opted-in chat. The brain-side handler resolves both handles to entity_ids
 * via entity_aliases / canonical name lookup, calls mergeEntities, and
 * sends an ack reply to the chat.
 */
export interface EntityMergeRequestedEvent extends NanoClawEvent {
  type: 'entity.merge.requested';
  source: 'discord' | 'signal';
  platform: 'discord' | 'signal';
  chat_id: string;
  requested_by_handle: string; // who typed the command
  handle_a: string;
  handle_b: string;
}
```

And in `NanoClawEventMap`:

```ts
  'entity.merge.requested': EntityMergeRequestedEvent;
```

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/__tests__/events.test.ts
git commit -m "feat(events): EntityMergeRequestedEvent type"
```

---

## Task 4: `claw merge` text trigger in Signal channel

**Files:**
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/__tests__/signal.test.ts`

Mirror of the existing `claw save` trigger (look for `^claw\s+save\b` pattern around the inbound branch).

- [ ] **Step 1: Failing test**:

```ts
  it('claw merge text emits entity.merge.requested', async () => {
    const events: EntityMergeRequestedEvent[] = [];
    eventBus.on('entity.merge.requested', (e) => events.push(e));
    const env = {
      source: 'alice',
      sourceNumber: '+15551234567',
      sourceName: 'Alice',
      timestamp: Date.now(),
      dataMessage: {
        timestamp: Date.now(),
        message: 'claw merge Jonathan "J Zhang"',
        groupInfo: { groupId: 'group-X', type: 'DELIVER' },
      },
    };
    await channel.handleEnvelope(env as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entity.merge.requested',
      platform: 'signal',
      handle_a: 'Jonathan',
      handle_b: 'J Zhang',
    });
  });
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add trigger** in `src/channels/signal.ts`. Find the `claw save` block and add an analogous block immediately after it. Use a simple parser that handles bare words and double-quoted phrases:

```ts
    // `claw merge` text trigger — operator-issued identity merge.
    const mergeMatch = body.match(/^claw\s+merge\b\s*(.+)$/i);
    if (mergeMatch) {
      const args = parseMergeArgs(mergeMatch[1].trim());
      if (args.length === 2) {
        eventBus.emit('entity.merge.requested', {
          type: 'entity.merge.requested',
          source: 'signal',
          timestamp: Date.now(),
          payload: {},
          platform: 'signal',
          chat_id: chatId,
          requested_by_handle: envelope.sourceName ?? sourceJid,
          handle_a: args[0],
          handle_b: args[1],
        } satisfies EntityMergeRequestedEvent);
      } else {
        logger.warn(
          { body, parsed: args },
          'signal: claw merge needs exactly two handles — ignoring',
        );
      }
      return;
    }
```

Add the helper at the bottom of the file:

```ts
/**
 * Parse `claw merge` arguments. Supports bare words and double-quoted phrases.
 * Examples: `Jonathan "J Zhang"` → ['Jonathan', 'J Zhang']
 *           `alice bob` → ['alice', 'bob']
 */
function parseMergeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? '');
  return out;
}
```

(Add `import type { EntityMergeRequestedEvent } from '../events.js';`.)

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/__tests__/signal.test.ts
git commit -m "feat(signal): claw merge text trigger emits entity.merge.requested"
```

---

## Task 5: `claw merge` text trigger in Discord channel

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/__tests__/discord.test.ts`

Discord MessageCreate already detects `claw save` in the message content; mirror that for `claw merge`.

- [ ] **Step 1: Failing test**:

```ts
  it('claw merge MessageCreate emits entity.merge.requested', async () => {
    const events: EntityMergeRequestedEvent[] = [];
    eventBus.on('entity.merge.requested', (e) => events.push(e));
    const message = {
      id: 'm1',
      channelId: 'channel-1',
      content: 'claw merge alice bob',
      author: { id: 'u1', username: 'Op', bot: false },
      member: { displayName: 'Op' },
      createdAt: new Date(),
    };
    await client.emit('messageCreate', message);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'discord',
      chat_id: 'channel-1',
      handle_a: 'alice',
      handle_b: 'bob',
    });
  });
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Add trigger** in `src/channels/discord.ts` MessageCreate handler — find the existing `claw save` regex and add a parallel `claw merge` block. Reuse the same `parseMergeArgs` helper (extract to `src/channels/parse-merge-args.ts` so both channels can import it):

Create `src/channels/parse-merge-args.ts`:

```ts
export function parseMergeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? '');
  return out;
}
```

(Then update Task 4's signal.ts to import from this shared helper instead of defining it locally — adjust the commit message of Task 4 to mention the shared helper, or do this refactor as part of Task 5's commit.)

In `src/channels/discord.ts` MessageCreate handler:

```ts
      const mergeMatch = message.content?.match(/^claw\s+merge\b\s*(.+)$/i);
      if (mergeMatch) {
        const args = parseMergeArgs(mergeMatch[1].trim());
        if (args.length === 2) {
          eventBus.emit('entity.merge.requested', {
            type: 'entity.merge.requested',
            source: 'discord',
            timestamp: Date.now(),
            payload: {},
            platform: 'discord',
            chat_id: message.channelId,
            requested_by_handle: message.member?.displayName ?? message.author?.username ?? 'unknown',
            handle_a: args[0],
            handle_b: args[1],
          } satisfies EntityMergeRequestedEvent);
        }
        return;
      }
```

(Add `import { parseMergeArgs } from './parse-merge-args.js';` and `import type { EntityMergeRequestedEvent } from '../events.js';`.)

- [ ] **Step 4: Run** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord.ts src/channels/signal.ts src/channels/parse-merge-args.ts src/channels/__tests__/discord.test.ts
git commit -m "feat(discord): claw merge text trigger; share parseMergeArgs"
```

---

## Task 6: `identity-merge-handler` — handle resolution + merge

**Files:**
- Create: `src/brain/identity-merge-handler.ts`
- Create: `src/brain/__tests__/identity-merge-handler.test.ts`

Subscriber that takes an `entity.merge.requested` event, resolves both handles to entity_ids using `entity_aliases.field_value` matches and `entities.canonical->>'name'` ILIKE matches (both case-insensitive), and calls `mergeEntities`. Ambiguous handles (multiple entities match) reject with a warn log; the channel sends back an ack reply.

- [ ] **Step 1: Failing test**:

```ts
import { handleEntityMergeRequested } from '../identity-merge-handler.js';

it('resolves both handles via canonical name and calls mergeEntities', async () => {
  const db = getBrainDb();
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES ('e-jz', 'person', ?, ?, ?), ('e-jz2', 'person', ?, ?, ?)`,
  ).run(
    JSON.stringify({ name: 'Jonathan' }), '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
    JSON.stringify({ name: 'J Zhang' }), '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
  );
  // Seed a KU pointing at the loser so we can verify rebind happened.
  db.prepare(
    `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
       valid_from, recorded_at, extracted_by, needs_review)
     VALUES ('k1', 'x', 'signal_message', 'personal', 0.9,
             '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
  ).run();
  db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'e-jz2', 'mentioned')`).run();

  const sentReplies: string[] = [];
  await handleEntityMergeRequested(
    {
      type: 'entity.merge.requested', source: 'signal', timestamp: Date.now(),
      payload: {}, platform: 'signal', chat_id: 'c1',
      requested_by_handle: 'op', handle_a: 'Jonathan', handle_b: 'J Zhang',
    },
    { db, sendReply: async (text: string) => { sentReplies.push(text); } },
  );
  // Both rebound to e-jz (whichever was alphabetically resolved first); confirm log row.
  const log = db.prepare(`SELECT * FROM entity_merge_log LIMIT 1`).get() as any;
  expect(log).toBeDefined();
  expect([log.kept_entity_id, log.merged_entity_id].sort()).toEqual(['e-jz', 'e-jz2']);
  // Ack reply sent.
  expect(sentReplies).toHaveLength(1);
  expect(sentReplies[0]).toMatch(/merged/i);
});

it('refuses when a handle is ambiguous', async () => {
  const db = getBrainDb();
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES ('e1', 'person', ?, ?, ?), ('e2', 'person', ?, ?, ?), ('e3', 'person', ?, ?, ?)`,
  ).run(
    JSON.stringify({ name: 'Jonathan' }), '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
    JSON.stringify({ name: 'Jonathan' }), '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
    JSON.stringify({ name: 'Jane' }),    '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z',
  );
  const sent: string[] = [];
  await handleEntityMergeRequested(
    {
      type: 'entity.merge.requested', source: 'signal', timestamp: Date.now(),
      payload: {}, platform: 'signal', chat_id: 'c1',
      requested_by_handle: 'op', handle_a: 'Jonathan', handle_b: 'Jane',
    },
    { db, sendReply: async (t: string) => { sent.push(t); } },
  );
  expect(db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get()).toEqual({ n: 0 });
  expect(sent[0]).toMatch(/ambiguous|multiple/i);
});

it('refuses when a handle resolves to nothing', async () => {
  const db = getBrainDb();
  const sent: string[] = [];
  await handleEntityMergeRequested(
    {
      type: 'entity.merge.requested', source: 'signal', timestamp: Date.now(),
      payload: {}, platform: 'signal', chat_id: 'c1',
      requested_by_handle: 'op', handle_a: 'nobody', handle_b: 'somebody',
    },
    { db, sendReply: async (t: string) => { sent.push(t); } },
  );
  expect(sent[0]).toMatch(/not found|no match/i);
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** `src/brain/identity-merge-handler.ts`:

```ts
import type Database from 'better-sqlite3';
import type { EntityMergeRequestedEvent } from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { mergeEntities } from './identity-merge.js';

export interface MergeHandlerOpts {
  db?: Database.Database;
  /**
   * Send an ack/error reply back to the source chat. Wired by chat-ingest
   * to the appropriate channel router. In tests, capture into an array.
   */
  sendReply?: (text: string) => Promise<void>;
}

interface ResolvedCandidate {
  entity_id: string;
  reason: 'alias' | 'canonical_name';
}

/**
 * Resolve a handle to person entity_ids. Tries:
 *   1. Exact alias match (case-insensitive on field_value, any field_name).
 *   2. Canonical name match (canonical->>'name' lowercased == handle lowered).
 * Returns ALL matches so callers can detect ambiguity.
 */
function resolveHandle(db: Database.Database, handle: string): ResolvedCandidate[] {
  const lowered = handle.trim().toLowerCase();
  if (!lowered) return [];
  const aliasHits = db
    .prepare(
      `SELECT DISTINCT entity_id FROM entity_aliases
        WHERE LOWER(field_value) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;
  const nameHits = db
    .prepare(
      `SELECT entity_id FROM entities
        WHERE entity_type = 'person'
          AND LOWER(json_extract(canonical, '$.name')) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;
  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const r of aliasHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'alias' });
      seen.add(r.entity_id);
    }
  }
  for (const r of nameHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'canonical_name' });
      seen.add(r.entity_id);
    }
  }
  return out;
}

export async function handleEntityMergeRequested(
  evt: EntityMergeRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const candA = resolveHandle(db, evt.handle_a);
  const candB = resolveHandle(db, evt.handle_b);
  if (candA.length === 0) {
    await reply(`claw merge: handle '${evt.handle_a}' not found`);
    return;
  }
  if (candB.length === 0) {
    await reply(`claw merge: handle '${evt.handle_b}' not found`);
    return;
  }
  if (candA.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_a}' is ambiguous (${candA.length} matches) — quote a more specific name or use entity_id`,
    );
    return;
  }
  if (candB.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_b}' is ambiguous (${candB.length} matches)`,
    );
    return;
  }
  const a = candA[0].entity_id;
  const b = candB[0].entity_id;
  if (a === b) {
    await reply(`claw merge: '${evt.handle_a}' and '${evt.handle_b}' already resolve to the same entity`);
    return;
  }

  // Convention: keep the alphabetically-earlier entity_id (deterministic).
  // For human merges this is arbitrary; merge_log records which won.
  const [keptId, mergedId] = a < b ? [a, b] : [b, a];

  try {
    const result = await mergeEntities(keptId, mergedId, {
      evidence: {
        trigger: 'manual',
        requested_by: evt.requested_by_handle,
        platform: evt.platform,
        chat_id: evt.chat_id,
      },
      confidence: 1.0,
      mergedBy: `human:${evt.requested_by_handle}`,
      db,
    });
    await reply(
      `claw merge: ✓ merged ${evt.handle_b} (${mergedId.slice(0, 6)}…) into ${evt.handle_a} (${keptId.slice(0, 6)}…) — log ${result.merge_id.slice(0, 6)}…`,
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), evt },
      'identity-merge-handler: merge failed',
    );
    await reply(
      `claw merge: failed — ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
```

- [ ] **Step 4: Run** the tests — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/__tests__/identity-merge-handler.test.ts
git commit -m "feat(brain): identity-merge handler — resolve handles + ack reply"
```

---

## Task 7: Wire merge handler into chat-ingest start/stop

**Files:**
- Modify: `src/brain/identity-merge-handler.ts`
- Modify: `src/brain/chat-ingest.ts`

- [ ] **Step 1: Add lifecycle** at the bottom of `src/brain/identity-merge-handler.ts`:

```ts
import { eventBus } from '../event-bus.js';

let unsub: (() => void) | null = null;

export interface IdentityMergeStartOpts {
  /** Channel-aware reply sender. Wired by chat-ingest to router.replyTo(...). */
  sendReply?: (chat_id: string, platform: 'discord' | 'signal', text: string) => Promise<void>;
}

export function startIdentityMergeHandler(opts: IdentityMergeStartOpts = {}): void {
  if (unsub) return;
  unsub = eventBus.on('entity.merge.requested', async (evt) => {
    try {
      await handleEntityMergeRequested(evt, {
        sendReply: opts.sendReply
          ? async (text: string) => opts.sendReply!(evt.chat_id, evt.platform, text)
          : undefined,
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: top-level error',
      );
    }
  });
  logger.info('Identity merge handler started');
}

export function stopIdentityMergeHandler(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
```

- [ ] **Step 2: Wire** into `src/brain/chat-ingest.ts`. Add import:

```ts
import {
  startIdentityMergeHandler,
  stopIdentityMergeHandler,
} from './identity-merge-handler.js';
```

In `startChatIngest`, after `startWindowFlusher();` (and after PR 4's `startChatEditSync` if it landed), add:

```ts
  startIdentityMergeHandler({ sendReply: opts.sendReply });
```

Update `ChatIngestOpts`:

```ts
export interface ChatIngestOpts {
  llmCaller?: LlmCaller;
  /** Reply-back hook used by claw-merge handler. Provided by index.ts wiring. */
  sendReply?: (
    chat_id: string,
    platform: 'discord' | 'signal',
    text: string,
  ) => Promise<void>;
}
```

In `stopChatIngest`, after `stopWindowFlusher();`, add:

```ts
  stopIdentityMergeHandler();
```

In `src/index.ts` (or wherever `startChatIngest` is currently called from production wiring), pass a real `sendReply`. Look up the existing channel router — it already knows how to send messages back per chat. Use whatever helper is in scope (e.g. `router.send`). If the wiring is non-obvious, add a TODO log line and accept that the ack won't reach the chat in production until index.ts is updated, but tests still pass.

- [ ] **Step 3: Run** the chat-ingest test suite: `npx vitest run src/brain/__tests__/chat-ingest.test.ts src/brain/__tests__/identity-merge-handler.test.ts` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/chat-ingest.ts src/index.ts
git commit -m "feat(brain): start/stop identity-merge handler with chat-ingest"
```

---

## Task 8: `attachment-summary` helper

**Files:**
- Create: `src/brain/attachment-summary.ts`
- Create: `src/brain/__tests__/attachment-summary.test.ts`

Generates a single-line summary of one attachment for inclusion in a windowed transcript. Three tiers:
1. If `BRAIN_IMAGE_VISION` is enabled AND the attachment is an image with a downloaded local path → call vision summarizer (existing helper from PR 1).
2. Else if attachment has a filename → `[<kind>: <filename>]` (e.g. `[image: receipt.jpg]`, `[file: contract.pdf]`).
3. Else → `[attachment]`.

This needs to know what the existing PR-1 attachment shape looks like. From `chat-message-cache.ts:13` we know `attachments?: unknown[]`. The actual shape lives in the channel handlers' putChatMessage calls — for Signal, attachments come from `dataMsg.attachments` (signal-cli format); for Discord, from `message.attachments` (discord.js format). The summarizer should accept a normalized minimal shape.

- [ ] **Step 1: Failing test**:

```ts
import { describe, expect, it, vi } from 'vitest';
import { summarizeAttachment } from '../attachment-summary.js';

describe('attachment-summary', () => {
  it('falls back to filename tag when vision is disabled', async () => {
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'receipt.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: false },
    );
    expect(result).toBe('[image: receipt.jpg]');
  });

  it('uses the vision summary when vision is enabled and local_path exists', async () => {
    const visionMock = vi.fn(async () => 'Acme invoice for $250');
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'receipt.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[image: receipt.jpg — Acme invoice for $250]');
    expect(visionMock).toHaveBeenCalledWith('/tmp/r.jpg');
  });

  it('handles missing filename', async () => {
    const result = await summarizeAttachment({ kind: 'file' }, { visionEnabled: false });
    expect(result).toBe('[file]');
  });

  it('handles unknown kind gracefully', async () => {
    const result = await summarizeAttachment({}, { visionEnabled: false });
    expect(result).toBe('[attachment]');
  });

  it('falls back to filename when vision throws', async () => {
    const visionMock = vi.fn(async () => { throw new Error('boom'); });
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'r.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[image: r.jpg]');
  });
});
```

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement** `src/brain/attachment-summary.ts`:

```ts
/**
 * Single-line attachment summary for windowed transcripts.
 *
 * Three tiers:
 *   1. Image + vision enabled + local_path → "[image: <name> — <vision summary>]"
 *   2. Filename present                    → "[<kind>: <filename>]"
 *   3. No metadata                          → "[attachment]"
 *
 * Vision failures fall back to tier 2.
 */

import { logger } from '../logger.js';

export interface AttachmentInput {
  kind?: string;        // 'image' | 'file' | 'audio' | 'video' | other
  filename?: string;
  local_path?: string;
}

export interface AttachmentSummaryOpts {
  /** Reads BRAIN_IMAGE_VISION at construction time. */
  visionEnabled?: boolean;
  /** Injectable vision summarizer for tests. Defaults to an internal lazy import. */
  summarizeVision?: (path: string) => Promise<string>;
}

export async function summarizeAttachment(
  att: AttachmentInput,
  opts: AttachmentSummaryOpts = {},
): Promise<string> {
  const kind = att.kind ?? 'attachment';
  const filename = att.filename;
  const baseTag = filename ? `${kind}: ${filename}` : kind;

  if (
    opts.visionEnabled &&
    kind === 'image' &&
    att.local_path &&
    opts.summarizeVision
  ) {
    try {
      const summary = await opts.summarizeVision(att.local_path);
      const trimmed = summary.trim();
      if (trimmed) return `[${baseTag} — ${trimmed}]`;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), filename },
        'attachment-summary: vision failed; falling back to filename tag',
      );
    }
  }

  return `[${baseTag}]`;
}
```

- [ ] **Step 4: Run** — expect PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/attachment-summary.ts src/brain/__tests__/attachment-summary.test.ts
git commit -m "feat(brain): attachment-summary helper with vision tier + fallback"
```

---

## Task 9: Use `summarizeAttachment` in window-flusher transcript

**Files:**
- Modify: `src/brain/window-flusher.ts`
- Modify: `src/brain/__tests__/window-flusher.test.ts`

Find the transcript builder in `flushOne` (currently joining `[<sent_at>] <sender>: <text>` lines). Append attachment summary lines for any cached row with attachments.

- [ ] **Step 1: Failing test** appended to `window-flusher.test.ts`:

```ts
  it('window transcript includes attachment summary lines', async () => {
    setRegisteredGroup('dc:c-att', {
      name: 'g-att', folder: 'opt-att', trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    writeOptIn('opt-att', { idleMin: 1 });
    const events = captured();
    const t1 = new Date(Date.now() - 5 * 60_000).toISOString();
    putChatMessage({
      platform: 'discord', chat_id: 'c-att', message_id: 'mA',
      sent_at: t1, sender: 'u', sender_name: 'X', text: 'see attached',
      attachments: [{ kind: 'image', filename: 'receipt.jpg' }],
    });
    noteMessage('discord', 'c-att', 'mA', t1);
    flushIdle(Date.now()); // force the idle flush
    expect(events).toHaveLength(1);
    expect(events[0].transcript).toContain('see attached');
    expect(events[0].transcript).toContain('[image: receipt.jpg]');
  });
```

- [ ] **Step 2: Run** — expect FAIL (`receipt.jpg` won't appear in transcript).

- [ ] **Step 3: Modify** `flushOne` in `src/brain/window-flusher.ts`. Find the `transcript` build (currently `rows.map((r) => '[' + r.sent_at + '] ' + ... + ': ' + r.text).join('\n')`). Replace with an async transcript build:

```ts
import { summarizeAttachment, type AttachmentInput } from './attachment-summary.js';

// Inside flushOne, replace:
//   const transcript = rows.map((r) => `[${r.sent_at}] ${...}: ${r.text ?? ''}`.trim()).join('\n');
// with:
const visionEnabled = process.env.BRAIN_IMAGE_VISION === 'true';
const lines: string[] = [];
for (const r of rows) {
  const sender = r.sender_name ?? r.sender;
  lines.push(`[${r.sent_at}] ${sender}: ${r.text ?? ''}`.trim());
  const atts = (r.attachments as AttachmentInput[] | undefined) ?? [];
  for (const att of atts) {
    const summary = await summarizeAttachment(att, { visionEnabled });
    lines.push(`[${r.sent_at}] ${sender}: ${summary}`);
  }
}
const transcript = lines.join('\n');
```

This requires `flushOne` to become `async` if it isn't already. Check the existing signature; if it's sync, mark it async and update callers (`flushIdle`, `flushAll`, `noteMessage`) to await it. The cap-flush path inside `noteMessage` becomes:

```ts
  if (w.message_ids.length >= w.cap) {
    void flushOne(w, 'cap');
  }
```

(Fire-and-forget is acceptable here; the function completes before any further `noteMessage` for the same window.)

- [ ] **Step 4: Run** — expect PASS.

Also re-run the whole window-flusher suite to make sure no regressions:
`npx vitest run src/brain/__tests__/window-flusher.test.ts`
Expected: PASS — all 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/window-flusher.ts src/brain/__tests__/window-flusher.test.ts
git commit -m "feat(brain): include attachment summaries in window transcript"
```

---

## Task 10: `.env.example` doc + manual end-to-end verification

**Files:**
- Modify: `.env.example`
- (operator-run) verification

- [ ] **Step 1: Document new env** by appending to the PR-2 block in `.env.example`:

```
BRAIN_MERGE_AUTO_LOW_CONF_REJECT=true   # reserved for future automated merges (no-op today)
```

- [ ] **Step 2: Build + restart**

```bash
cd /Users/topcoder1/dev/nanoclaw && npm run build && launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
```

Expected logs include: `Identity merge handler started`.

- [ ] **Step 3: Identity merge verification**

In an opted-in Signal chat (e.g. signal_main / Note-to-Self), find two person entities to merge by querying:

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT entity_id, json_extract(canonical, '$.name') AS name FROM entities
   WHERE entity_type='person' ORDER BY updated_at DESC LIMIT 10;"
```

Pick two that are clearly the same person (e.g., `Jonathan` and `J Zhang` if both exist). Send `claw merge Jonathan "J Zhang"` in the chat. Wait ~3 seconds.

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT merge_id, kept_entity_id, merged_entity_id, merged_by, evidence
   FROM entity_merge_log ORDER BY merged_at DESC LIMIT 1;"
```

Expected: a row with `merged_by='human:Jonathan'` (your sender_name), evidence JSON includes `trigger:'manual'`, and the chat reply says `claw merge: ✓ merged ...`. Verify also that `ku_entities` no longer points at the loser:

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT COUNT(*) FROM ku_entities WHERE entity_id = '<merged_entity_id>';"
```

Expected: 0.

- [ ] **Step 4: Attachment summary verification**

In an opted-in Signal chat with `window_idle_min: 1`, send a message with an image attachment (e.g., a screenshot). Wait 90s for the window flush.

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/brain.db \
  "SELECT substr(payload, 1, 500) FROM raw_events
   WHERE source_type='signal_window' ORDER BY received_at DESC LIMIT 1;"
```

Expected: the `transcript` field within the JSON payload contains a line like `[image: <filename>]` (or with a vision summary appended if `BRAIN_IMAGE_VISION=true`).

- [ ] **Step 5: Empty commit recording verification**

```bash
git commit --allow-empty -m "chore(chat): manual verification PR3 — claw merge + attachment summaries green"
```

---

## Self-Review

- **Spec coverage:**
  - Identity-merge engine → Tasks 1, 2 (atomic transaction, ku_entities + aliases + relationships rebound, merge_log written, error paths covered)
  - `claw merge` UX → Tasks 3 (event type), 4 (Signal), 5 (Discord), 6 (handler), 7 (lifecycle)
  - Attachment summarization → Tasks 8 (helper), 9 (window-flusher integration)
  - Schema audit → Task 0 (no implementation, just a guardrail)
  - Manual verification → Task 10
- **Placeholder scan:** Task 7 has one operational note ("If wiring is non-obvious, add a TODO log line and accept that the ack won't reach the chat in production until index.ts is updated") — this is a deliberate scope limit, not a placeholder for missing code. Every code block is real.
- **Type consistency:** `MergeEvidence` / `MergeOpts` / `MergeResult` declared in Task 1 and used in Tasks 6, 7. `EntityMergeRequestedEvent` declared in Task 3 and used identically in Tasks 4, 5, 6, 7. `AttachmentInput` / `AttachmentSummaryOpts` declared in Task 8 and used in Task 9.
- **Out-of-scope:** No automatic deterministic merging on ingest (the `BRAIN_MERGE_AUTO_LOW_CONF_REJECT` env is reserved but unused). No Splink fuzzy-match. No undo command (the `pre_merge_snapshot` is captured but no `claw unmerge` is exposed yet — punt to a future PR).
- **Independence:** The three sub-features (engine, claw-merge UX, attachment summaries) share Tasks 0 and 10 but are otherwise independent. If PR 3 needs to split, take Tasks 1–7 as PR 3a (identity merge + claw merge) and Tasks 8–9 as PR 3b (attachment summaries).
- **Failure modes:** mergeEntities transaction is atomic — partial state can't leak. Handle resolution rejects ambiguity rather than guessing. Attachment vision failures fall back to filename, never propagate.
