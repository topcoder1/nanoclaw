# Auto-Merge for Duplicate Entities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect duplicate person entities in the brain DB and either auto-merge them silently (high-confidence: same email / phone / signal_uuid / discord_snowflake / whatsapp_jid) or surface them as chat suggestions the operator can confirm or reject (medium-confidence: same canonical name).

**Architecture:** A nightly batch sweep (default 02:00 local) runs deterministic SQL classifiers over the `entities` and `entity_aliases` tables, calls the existing `mergeEntities()` for high-confidence pairs, and writes medium-confidence pairs to a new `entity_merge_suggestions` table while emitting a new `entity.merge.suggested` event. The existing `identity-merge-handler` subscribes and formats chat suggestions; a new `claw merge-reject` command writes permanent rows to a new `entity_merge_suppressions` table that the next sweep consults.

**Tech Stack:** TypeScript, better-sqlite3, vitest, the existing `eventBus`, and the existing `mergeEntities` / `unmergeEntities` / `setIdentityMergeReply` from PRs 45/47/53.

**Spec:** [docs/superpowers/specs/2026-04-28-auto-merge-design.md](../specs/2026-04-28-auto-merge-design.md)

---

## File Structure

| File | Responsibility | Status |
| ---- | -------------- | ------ |
| `src/brain/auto-merge.ts` | Pure classifier + sweep orchestrator + scheduler entry point | new |
| `src/brain/__tests__/auto-merge.test.ts` | Classifier, sweep, idempotency, dry-run, env-gate tests | new |
| `src/brain/schema.sql` | `entity_merge_suggestions`, `entity_merge_suppressions` tables | edit |
| `src/events.ts` | `entity.merge.suggested`, `entity.merge.reject.requested` event types | edit |
| `src/brain/identity-merge.ts` | `mergeEntities()` lifecycle hook (mark suggestions accepted) | edit |
| `src/brain/identity-merge-handler.ts` | `entity.merge.suggested` formatter + `claw merge-reject` handler + auto-suppress on unmerge of `auto:high` | edit |
| `src/brain/__tests__/identity-merge-handler.test.ts` | New cases: suggestion formatter, merge-reject handler, auto-suppression | edit |
| `src/channels/signal.ts` | `claw merge-reject` trigger BEFORE `claw merge` | edit |
| `src/channels/discord.ts` | `claw merge-reject` trigger BEFORE `claw merge` | edit |
| `src/channels/signal.test.ts` | New `claw merge-reject` parsing case | edit |
| `src/channels/discord.test.ts` | New `claw merge-reject` parsing case | edit |
| `src/index.ts` | Wire `startAutoMergeSchedule` at startup | edit |
| `.env.example` | 5 new vars, drop `BRAIN_MERGE_AUTO_LOW_CONF_REJECT` | edit |

---

## Critical implementation note: trigger ordering

The existing `claw merge` regex in [src/channels/signal.ts:331](../../../src/channels/signal.ts) and [src/channels/discord.ts:66](../../../src/channels/discord.ts) is `^claw\s+merge\b\s*(.+)$`. The `\b` word-boundary matches between `e` and `-`, so **`claw merge-reject a b` would currently match the merge regex** (capturing `-reject a b` as group 1 and warning about a 3-token args parse).

**Therefore** — every place we add a `claw merge-reject` matcher, it MUST appear in the source BEFORE the existing `claw merge` matcher. Tasks 16a and 16b enforce this with the test `claw merge-reject does NOT emit entity.merge.requested`.

---

## Task 1: Schema additions

**Files:**
- Modify: `src/brain/schema.sql` (append after the existing `entity_merge_log` table on line 58)
- Test: `src/brain/__tests__/auto-merge.test.ts` (new file, schema-presence test only in this task)

- [ ] **Step 1: Write the failing test**

Create `src/brain/__tests__/auto-merge.test.ts`:

```typescript
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-auto-merge-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates entity_merge_suggestions and entity_merge_suppressions', () => {
    const db = getBrainDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('entity_merge_suggestions','entity_merge_suppressions')`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'entity_merge_suggestions',
      'entity_merge_suppressions',
    ]);
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index'
         AND name='idx_entity_merge_suggestions_status'`,
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_entity_merge_suggestions_status');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts`
Expected: FAIL with `expect(received).toEqual(expected)` showing empty array (tables don't exist).

- [ ] **Step 3: Edit `src/brain/schema.sql`**

Append immediately after the existing `entity_merge_log` block (after line 58):

```sql

-- 5.1.x Auto-merge suggestion + suppression (2026-04-28)
CREATE TABLE IF NOT EXISTS entity_merge_suggestions (
  suggestion_id TEXT PRIMARY KEY,           -- ULID
  entity_id_a   TEXT NOT NULL,              -- lex-smaller of the two ids
  entity_id_b   TEXT NOT NULL,              -- lex-larger
  confidence    REAL NOT NULL,
  reason_code   TEXT NOT NULL,              -- 'name_exact', 'phone_normalized', etc.
  evidence_json TEXT NOT NULL,              -- JSON: {fieldsMatched, canonicalA, canonicalB}
  suggested_at  INTEGER NOT NULL,           -- unix ms
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  status_at     INTEGER,
  UNIQUE (entity_id_a, entity_id_b)
);
CREATE INDEX IF NOT EXISTS idx_entity_merge_suggestions_status
  ON entity_merge_suggestions(status, suggested_at);

CREATE TABLE IF NOT EXISTS entity_merge_suppressions (
  entity_id_a      TEXT NOT NULL,           -- lex-smaller
  entity_id_b      TEXT NOT NULL,           -- lex-larger
  suppressed_until INTEGER,                 -- unix ms; NULL = permanent
  reason           TEXT,                    -- 'operator_rejected' | 'unmerged_by_operator'
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (entity_id_a, entity_id_b)
);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/schema.sql src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): schema for auto-merge suggestions and suppressions"
```

---

## Task 2: Add `entity.merge.suggested` event type

**Files:**
- Modify: `src/events.ts` (add interface near line 838 alongside other entity-merge events; add to EventMap near line 912)

- [ ] **Step 1: Edit `src/events.ts` — add interface after `EntityUnmergeRequestedEvent`**

After the closing `}` of `EntityUnmergeRequestedEvent` (around line 838) and before `// --- Event type map ---`:

```typescript
/**
 * Emitted by the auto-merge sweep when it finds a medium-confidence duplicate
 * pair (same canonical name, same entity_type, no conflicting hard identifier).
 * The brain-side handler formats a chat suggestion via setIdentityMergeReply
 * so the operator can confirm with `claw merge` or suppress with
 * `claw merge-reject`.
 */
export interface EntityMergeSuggestedEvent extends NanoClawEvent {
  type: 'entity.merge.suggested';
  suggestion_id: string;
  entity_id_a: string;          // lex-smaller
  entity_id_b: string;          // lex-larger
  confidence: number;
  reason_code: 'name_exact' | string;
  evidence: {
    fields_matched: string[];
    canonical_a: Record<string, unknown>;
    canonical_b: Record<string, unknown>;
  };
}

/**
 * Emitted when an operator types `claw merge-reject <a> <b>` in an opted-in
 * chat. The brain-side handler resolves both handles, writes a permanent row
 * to entity_merge_suppressions, and updates any pending suggestion to status
 * `rejected`.
 */
export interface EntityMergeRejectRequestedEvent extends NanoClawEvent {
  type: 'entity.merge.reject.requested';
  source: 'discord' | 'signal';
  platform: 'discord' | 'signal';
  chat_id: string;
  requested_by_handle: string;
  handle_a: string;
  handle_b: string;
}
```

- [ ] **Step 2: Edit `src/events.ts` — add to EventMap (around line 912)**

Find the line `'entity.unmerge.requested': EntityUnmergeRequestedEvent;` and add directly after it:

```typescript
  'entity.merge.suggested': EntityMergeSuggestedEvent;
  'entity.merge.reject.requested': EntityMergeRejectRequestedEvent;
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): add entity.merge.suggested and entity.merge.reject.requested"
```

---

## Task 3: Lex-ordering helper + ULID re-use

**Files:**
- Create: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

Append to `src/brain/__tests__/auto-merge.test.ts` (above existing `describe('schema')` is fine, but conventionally put it below):

```typescript
import { lexOrdered } from '../auto-merge.js';

describe('lexOrdered', () => {
  it('returns smaller-first regardless of input order', () => {
    expect(lexOrdered('b', 'a')).toEqual(['a', 'b']);
    expect(lexOrdered('a', 'b')).toEqual(['a', 'b']);
  });
  it('rejects equal inputs', () => {
    expect(() => lexOrdered('x', 'x')).toThrow(/equal/i);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t lexOrdered`
Expected: FAIL with module-not-found for `../auto-merge.js`.

- [ ] **Step 3: Create `src/brain/auto-merge.ts`**

```typescript
/**
 * Auto-merge engine. Nightly sweep that finds duplicate entities by
 * deterministic SQL rules and either silently merges them (high confidence)
 * or persists chat suggestions for operator review (medium confidence).
 *
 * Spec: docs/superpowers/specs/2026-04-28-auto-merge-design.md
 */

/**
 * Return the two entity ids in lex-smaller-first order. Throws if equal —
 * callers should never construct a pair from the same id.
 */
export function lexOrdered(a: string, b: string): [string, string] {
  if (a === b) {
    throw new Error(`lexOrdered: refusing equal pair ${a}`);
  }
  return a < b ? [a, b] : [b, a];
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t lexOrdered`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): auto-merge lexOrdered helper"
```

---

## Task 4: Phone normalization helper

**Why:** Hard-identifier matching for `phone` requires comparing E.164 forms. `+1 (626) 348-3472`, `16263483472`, and `+16263483472` should all match. We do this in TypeScript (not SQL) because `entity_aliases.field_value` may be stored in any of these forms historically.

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { normalizePhone } from '../auto-merge.js';

describe('normalizePhone', () => {
  it('strips formatting and returns digits-only with leading +', () => {
    expect(normalizePhone('+1 (626) 348-3472')).toBe('+16263483472');
    expect(normalizePhone('16263483472')).toBe('+16263483472');
    expect(normalizePhone('+16263483472')).toBe('+16263483472');
    expect(normalizePhone('  626-348-3472  ')).toBe('+6263483472');
  });
  it('returns null for empty / non-numeric input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t normalizePhone`
Expected: FAIL with `normalizePhone is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
/**
 * Normalize a phone string to E.164-ish form. Strips all non-digit chars
 * (except a leading `+`), then re-prefixes `+` if missing. Returns null
 * if no digits remain or the input lacks any digit characters at all.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasDigits = /\d/.test(trimmed);
  if (!hasDigits) return null;
  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  // If the original started with '+' OR begins with a country code (11 digits
  // starting with 1 for NANP), keep it. Otherwise also prefix '+' so all forms
  // collapse — the test fixtures show '16263483472' and '+16263483472' must
  // collide.
  if (startsWithPlus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t normalizePhone`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): normalizePhone helper for hard-identifier matching"
```

---

## Task 5: High-confidence classifier (hard-identifier match)

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { findHighConfidenceCandidates } from '../auto-merge.js';

function seedPerson(db: any, id: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`,
  ).run(id, JSON.stringify({ name }), '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z');
}
function seedAlias(db: any, aliasId: string, entityId: string, field: string, value: string): void {
  db.prepare(
    `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
     VALUES (?, ?, 'test', ?, ?, '2026-04-28T00:00:00Z', 1.0)`,
  ).run(aliasId, entityId, field, value);
}

describe('findHighConfidenceCandidates', () => {
  it('returns a pair when two entities share an email (case-insensitive)', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice W');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'Alice@Example.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'alice@example.com');

    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].entity_id_a).toBe('e-aaa');
    expect(pairs[0].entity_id_b).toBe('e-bbb');
    expect(pairs[0].reason_code).toBe('email_exact');
    expect(pairs[0].fields_matched).toContain('email');
  });

  it('returns a pair when two entities share a normalized phone', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Bob');
    seedPerson(db, 'e-bbb', 'Bob');
    seedAlias(db, 'a1', 'e-aaa', 'phone', '+1 (626) 348-3472');
    seedAlias(db, 'a2', 'e-bbb', 'phone', '16263483472');

    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason_code).toBe('phone_normalized');
  });

  it('returns no pair when entity_type differs', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-p1', 'X');
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('e-c1', 'company', '{"name":"X"}', '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z')`,
    ).run();
    seedAlias(db, 'a1', 'e-p1', 'email', 'x@x.com');
    seedAlias(db, 'a2', 'e-c1', 'email', 'x@x.com');
    expect(findHighConfidenceCandidates(db)).toHaveLength(0);
  });

  it('returns no pair when only one entity has the alias', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-1', 'Y');
    seedPerson(db, 'e-2', 'Z');
    seedAlias(db, 'a1', 'e-1', 'email', 'y@y.com');
    expect(findHighConfidenceCandidates(db)).toHaveLength(0);
  });

  it('deduplicates pairs across multiple matched fields', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');
    seedAlias(db, 'a3', 'e-aaa', 'phone', '+15550001111');
    seedAlias(db, 'a4', 'e-bbb', 'phone', '+15550001111');
    const pairs = findHighConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fields_matched.sort()).toEqual(['email', 'phone']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t findHighConfidenceCandidates`
Expected: FAIL with `findHighConfidenceCandidates is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
import type Database from 'better-sqlite3';

export interface HighConfidencePair {
  entity_id_a: string;          // lex-smaller
  entity_id_b: string;
  reason_code: 'email_exact' | 'phone_normalized' | 'signal_uuid_exact'
    | 'discord_snowflake_exact' | 'whatsapp_jid_exact';
  fields_matched: string[];     // e.g. ['email','phone']
  confidence: 1.0;
}

const HARD_IDENTIFIER_FIELDS: ReadonlyArray<{
  field: string;
  reasonCode: HighConfidencePair['reason_code'];
  normalize: (raw: string) => string | null;
}> = [
  { field: 'email', reasonCode: 'email_exact', normalize: (r) => r.trim().toLowerCase() || null },
  { field: 'phone', reasonCode: 'phone_normalized', normalize: normalizePhone },
  { field: 'signal_uuid', reasonCode: 'signal_uuid_exact', normalize: (r) => r.trim().toLowerCase() || null },
  { field: 'discord_snowflake', reasonCode: 'discord_snowflake_exact', normalize: (r) => r.trim() || null },
  { field: 'whatsapp_jid', reasonCode: 'whatsapp_jid_exact', normalize: (r) => r.trim().toLowerCase() || null },
];

/**
 * Find every (a, b) pair of person entities that share a normalized value
 * for any hard-identifier field. Returned pairs are lex-ordered and
 * deduplicated across fields — a pair matched by both email AND phone
 * appears once with both names in `fields_matched`.
 */
export function findHighConfidenceCandidates(
  db: Database.Database,
): HighConfidencePair[] {
  // Gather: for each hard-id field, fetch all (entity_id, normalized_value)
  // tuples for entities of the same type. Then group by (type, field, value)
  // to find collisions. Doing the normalization in JS is necessary because
  // SQLite has no built-in phone-canonicalization.
  type Row = { entity_id: string; entity_type: string; field_name: string; field_value: string };
  const rows = db
    .prepare(
      `SELECT a.entity_id, e.entity_type, a.field_name, a.field_value
         FROM entity_aliases a
         JOIN entities e ON e.entity_id = a.entity_id
        WHERE a.field_name IN (${HARD_IDENTIFIER_FIELDS.map(() => '?').join(',')})`,
    )
    .all(...HARD_IDENTIFIER_FIELDS.map((f) => f.field)) as Row[];

  // Map: (entity_type|field|normalized_value) → Set<entity_id>
  const buckets = new Map<string, Set<string>>();
  // Also remember which fields each pair matched on.
  const pairFields = new Map<string, Set<string>>();
  const pairReasons = new Map<string, HighConfidencePair['reason_code']>();

  for (const r of rows) {
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === r.field_name);
    if (!cfg) continue;
    const norm = cfg.normalize(r.field_value);
    if (!norm) continue;
    const key = `${r.entity_type}|${r.field_name}|${norm}`;
    const set = buckets.get(key) ?? new Set();
    set.add(r.entity_id);
    buckets.set(key, set);
  }

  for (const [key, ids] of buckets) {
    if (ids.size < 2) continue;
    const fieldName = key.split('|')[1];
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === fieldName)!;
    const sorted = [...ids].sort();
    // Emit the (n choose 2) pairs.
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = lexOrdered(sorted[i], sorted[j]);
        const pairKey = `${a}|${b}`;
        const fields = pairFields.get(pairKey) ?? new Set();
        fields.add(fieldName);
        pairFields.set(pairKey, fields);
        // First-wins for reason_code: stable across runs because
        // HARD_IDENTIFIER_FIELDS is ordered.
        if (!pairReasons.has(pairKey)) {
          pairReasons.set(pairKey, cfg.reasonCode);
        }
      }
    }
  }

  const out: HighConfidencePair[] = [];
  for (const [pairKey, fields] of pairFields) {
    const [a, b] = pairKey.split('|');
    out.push({
      entity_id_a: a,
      entity_id_b: b,
      reason_code: pairReasons.get(pairKey)!,
      fields_matched: [...fields].sort(),
      confidence: 1.0,
    });
  }
  return out;
}
```

`normalizePhone` (defined in Task 4) lives in the same file and is therefore already in scope — no import needed.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t findHighConfidenceCandidates`
Expected: PASS for all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): high-confidence duplicate detector (hard-identifier match)"
```

---

## Task 6: Medium-confidence classifier (name-exact match with conflict short-circuit)

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { findMediumConfidenceCandidates } from '../auto-merge.js';

describe('findMediumConfidenceCandidates', () => {
  it('returns a pair for two entities with the same canonical name', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    const pairs = findMediumConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].entity_id_a).toBe('e-aaa');
    expect(pairs[0].entity_id_b).toBe('e-bbb');
    expect(pairs[0].reason_code).toBe('name_exact');
    expect(pairs[0].evidence.fields_matched).toEqual(['name']);
  });

  it('matches case-insensitively and trims whitespace', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', '  Jonathan ');
    seedPerson(db, 'e-bbb', 'JONATHAN');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(1);
  });

  it('does not match when the name is empty or missing', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', '');
    seedPerson(db, 'e-bbb', '');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('does not match when entity_type differs', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-p1', 'X');
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('e-c1', 'company', '{"name":"X"}', '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z')`,
    ).run();
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('short-circuits when entities have conflicting hard identifiers', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'jon1@x.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'jon2@x.com');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(0);
  });

  it('still matches when only one entity has a hard identifier (no conflict)', () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'jon@x.com');
    expect(findMediumConfidenceCandidates(db)).toHaveLength(1);
  });

  it('production-fixture regression: Jonathan × 2 surfaces as medium-conf', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('01KQ8X5WSYDVRM28ZA3PZCVTGH','person',
               '{"name":"Jonathan","signal_phone":"+16263483472"}',
               '2026-04-28T00:00:00Z','2026-04-28T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('01KQ9HHRDY5RYADT03SBQG07D6','person',
               '{"name":"Jonathan","signal_profile_name":"Jonathan"}',
               '2026-04-28T00:00:00Z','2026-04-28T00:00:00Z')`,
    ).run();
    const pairs = findMediumConfidenceCandidates(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason_code).toBe('name_exact');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t findMediumConfidenceCandidates`
Expected: FAIL with `findMediumConfidenceCandidates is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
export interface MediumConfidencePair {
  entity_id_a: string;          // lex-smaller
  entity_id_b: string;
  reason_code: 'name_exact';
  confidence: number;           // 0.5–0.8
  evidence: {
    fields_matched: string[];
    canonical_a: Record<string, unknown>;
    canonical_b: Record<string, unknown>;
  };
}

/**
 * Find every (a, b) pair of entities of the same type whose canonical name
 * matches case-insensitively after trim, EXCLUDING pairs that share a
 * hard-identifier field with conflicting values. The conflict short-circuit
 * is what protects us from merging two real people who happen to share a
 * common first name.
 */
export function findMediumConfidenceCandidates(
  db: Database.Database,
): MediumConfidencePair[] {
  type GroupRow = {
    entity_id: string;
    entity_type: string;
    name_norm: string;
    canonical: string;
  };
  // Group by lower(trim(name)) within each entity_type.
  const rows = db
    .prepare(
      `SELECT entity_id, entity_type,
              LOWER(TRIM(json_extract(canonical, '$.name'))) AS name_norm,
              canonical
         FROM entities
        WHERE json_extract(canonical, '$.name') IS NOT NULL
          AND TRIM(json_extract(canonical, '$.name')) != ''`,
    )
    .all() as GroupRow[];

  // Bucket by (entity_type, name_norm).
  const buckets = new Map<string, GroupRow[]>();
  for (const r of rows) {
    const key = `${r.entity_type}|${r.name_norm}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  // For each bucket of size >= 2, emit pairs (i, j) and apply the
  // conflicting-identifier short-circuit.
  const out: MediumConfidencePair[] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ri = list[i];
        const rj = list[j];
        if (hasConflictingIdentifier(db, ri.entity_id, rj.entity_id)) continue;
        const [a, b] = lexOrdered(ri.entity_id, rj.entity_id);
        const canonA = a === ri.entity_id ? safeJson(ri.canonical) : safeJson(rj.canonical);
        const canonB = a === ri.entity_id ? safeJson(rj.canonical) : safeJson(ri.canonical);
        out.push({
          entity_id_a: a,
          entity_id_b: b,
          reason_code: 'name_exact',
          confidence: 0.6,
          evidence: {
            fields_matched: ['name'],
            canonical_a: canonA,
            canonical_b: canonB,
          },
        });
      }
    }
  }
  return out;
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Returns true if entityA and entityB both have an alias for the same
 * hard-identifier field but with different normalized values. Two
 * entities with the same hard-id field-name but only ONE side populated
 * are NOT a conflict — only the both-populated-and-different case.
 */
function hasConflictingIdentifier(
  db: Database.Database,
  entityA: string,
  entityB: string,
): boolean {
  type Row = { entity_id: string; field_name: string; field_value: string };
  const rows = db
    .prepare(
      `SELECT entity_id, field_name, field_value
         FROM entity_aliases
        WHERE entity_id IN (?, ?)
          AND field_name IN (${HARD_IDENTIFIER_FIELDS.map(() => '?').join(',')})`,
    )
    .all(entityA, entityB, ...HARD_IDENTIFIER_FIELDS.map((f) => f.field)) as Row[];

  // For each field, collect normalized values per entity.
  const byField = new Map<string, { a: Set<string>; b: Set<string> }>();
  for (const r of rows) {
    const cfg = HARD_IDENTIFIER_FIELDS.find((f) => f.field === r.field_name);
    if (!cfg) continue;
    const norm = cfg.normalize(r.field_value);
    if (!norm) continue;
    const slot = byField.get(r.field_name) ?? { a: new Set(), b: new Set() };
    if (r.entity_id === entityA) slot.a.add(norm);
    else slot.b.add(norm);
    byField.set(r.field_name, slot);
  }
  for (const { a, b } of byField.values()) {
    if (a.size === 0 || b.size === 0) continue;     // not both populated
    // Conflict iff there is no overlap.
    let overlap = false;
    for (const v of a) {
      if (b.has(v)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t findMediumConfidenceCandidates`
Expected: PASS for all seven cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): medium-confidence duplicate detector with conflict short-circuit"
```

---

## Task 7: Suppression filter

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { isSuppressed } from '../auto-merge.js';

describe('isSuppressed', () => {
  it('returns true when a permanent suppression row exists', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entity_merge_suppressions (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES ('e-aaa','e-bbb', NULL, 'operator_rejected', ?)`,
    ).run(Date.now());
    expect(isSuppressed(db, 'e-aaa', 'e-bbb')).toBe(true);
    expect(isSuppressed(db, 'e-bbb', 'e-aaa')).toBe(true);  // order-insensitive
  });
  it('returns false when no row exists', () => {
    const db = getBrainDb();
    expect(isSuppressed(db, 'e-x', 'e-y')).toBe(false);
  });
  it('returns false when a time-bounded suppression has expired', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entity_merge_suppressions (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES ('e-aaa','e-bbb', ?, 'operator_rejected', ?)`,
    ).run(Date.now() - 1000, Date.now() - 5000);
    expect(isSuppressed(db, 'e-aaa', 'e-bbb')).toBe(false);
  });
  it('returns true when a time-bounded suppression is still in the future', () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entity_merge_suppressions (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES ('e-aaa','e-bbb', ?, 'operator_rejected', ?)`,
    ).run(Date.now() + 60_000, Date.now());
    expect(isSuppressed(db, 'e-aaa', 'e-bbb')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t isSuppressed`
Expected: FAIL with `isSuppressed is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
/**
 * Returns true if the given pair has an active suppression row. A row is
 * active when `suppressed_until` is NULL (permanent) or > now.
 */
export function isSuppressed(
  db: Database.Database,
  entityA: string,
  entityB: string,
  nowMs: number = Date.now(),
): boolean {
  const [a, b] = lexOrdered(entityA, entityB);
  const row = db
    .prepare(
      `SELECT suppressed_until FROM entity_merge_suppressions
        WHERE entity_id_a = ? AND entity_id_b = ?`,
    )
    .get(a, b) as { suppressed_until: number | null } | undefined;
  if (!row) return false;
  if (row.suppressed_until == null) return true;
  return row.suppressed_until > nowMs;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t isSuppressed`
Expected: PASS for all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): isSuppressed check for auto-merge candidate filter"
```

---

## Task 8: `mergeEntities()` lifecycle hook — mark suggestions accepted

**Why:** When the operator runs `claw merge a b` (manual path) for a pair that already has a pending chat suggestion, the suggestion's status should flip to `accepted`. Without this hook, suggestions accumulate as `pending` forever and would be re-suggested by the next sweep (the suggestion-table UNIQUE constraint would block re-insert, but having stale `pending` rows is misleading).

**Files:**
- Modify: `src/brain/identity-merge.ts` (inside the `mergeEntities` transaction body, after the merge log INSERT around line 156)
- Test: `src/brain/__tests__/identity-merge.test.ts` (add a new case)

- [ ] **Step 1: Add the failing test**

Open `src/brain/__tests__/identity-merge.test.ts` and append a new test inside the existing `describe('mergeEntities', ...)` block:

```typescript
  it('marks any matching pending suggestion as accepted', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
       VALUES ('e-aaa','person','{"name":"X"}','2026-04-28T00:00:00Z','2026-04-28T00:00:00Z'),
              ('e-bbb','person','{"name":"X"}','2026-04-28T00:00:00Z','2026-04-28T00:00:00Z')`,
    ).run();
    // Pre-seed a pending suggestion (lex-ordered).
    db.prepare(
      `INSERT INTO entity_merge_suggestions
         (suggestion_id, entity_id_a, entity_id_b, confidence, reason_code,
          evidence_json, suggested_at, status)
       VALUES ('s1','e-aaa','e-bbb',0.6,'name_exact','{}',?,'pending')`,
    ).run(Date.now());

    await mergeEntities('e-aaa', 'e-bbb', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:test',
      db,
    });

    const row = db
      .prepare(`SELECT status, status_at FROM entity_merge_suggestions WHERE suggestion_id = 's1'`)
      .get() as { status: string; status_at: number | null };
    expect(row.status).toBe('accepted');
    expect(row.status_at).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/identity-merge.test.ts -t "marks any matching pending suggestion"`
Expected: FAIL — `expect(row.status).toBe('accepted')` because we never UPDATE.

- [ ] **Step 3: Edit `src/brain/identity-merge.ts`**

Inside the transaction body of `mergeEntities`, after step 5 (the merge_log INSERT) and before the closing `})()` (around line 157), add step 6:

```typescript
    // 6. Lifecycle: mark any pending suggestion that matches this pair as
    //    accepted. The suggestions table is lex-ordered by (a, b), so we
    //    must lex-sort the inputs before the UPDATE.
    const [sa, sb] = keptEntityId < mergedEntityId
      ? [keptEntityId, mergedEntityId]
      : [mergedEntityId, keptEntityId];
    db.prepare(
      `UPDATE entity_merge_suggestions
          SET status = 'accepted', status_at = ?
        WHERE entity_id_a = ? AND entity_id_b = ? AND status = 'pending'`,
    ).run(Date.now(), sa, sb);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/identity-merge.test.ts -t "marks any matching pending suggestion"`
Expected: PASS.

- [ ] **Step 5: Verify the existing identity-merge tests still pass**

Run: `npx vitest run src/brain/__tests__/identity-merge.test.ts`
Expected: All PASS (including the new case).

- [ ] **Step 6: Commit**

```bash
git add src/brain/identity-merge.ts src/brain/__tests__/identity-merge.test.ts
git commit -m "feat(brain): mark matching merge-suggestion accepted on manual merge"
```

---

## Task 9: Sweep — high-confidence path

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { runAutoMergeSweep } from '../auto-merge.js';

describe('runAutoMergeSweep — high-confidence path', () => {
  it('merges high-confidence pairs and writes auto:high to merge_log', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice W');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');

    const result = await runAutoMergeSweep({ db, enabled: true });
    expect(result.high_conf_merged).toBe(1);

    const log = db
      .prepare(`SELECT merged_by, confidence FROM entity_merge_log LIMIT 1`)
      .get() as { merged_by: string; confidence: number };
    expect(log.merged_by).toBe('auto:high');
    expect(log.confidence).toBe(1.0);
  });

  it('skips suppressed pairs', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');
    db.prepare(
      `INSERT INTO entity_merge_suppressions (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES ('e-aaa','e-bbb', NULL, 'operator_rejected', ?)`,
    ).run(Date.now());

    const result = await runAutoMergeSweep({ db, enabled: true });
    expect(result.high_conf_merged).toBe(0);
    expect(result.suppressed_skipped).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "high-confidence path"`
Expected: FAIL — `runAutoMergeSweep is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
import { mergeEntities } from './identity-merge.js';
import { eventBus } from '../event-bus.js';
import { logger } from '../logger.js';
import { newId } from './ulid.js';
import { getBrainDb } from './db.js';

export interface AutoMergeSweepOpts {
  db?: Database.Database;
  enabled?: boolean;             // overrides BRAIN_MERGE_AUTO_ENABLED for tests
  dryRun?: boolean;              // overrides BRAIN_MERGE_AUTO_DRY_RUN for tests
  notifyChat?: boolean;          // overrides BRAIN_MERGE_AUTO_NOTIFY_CHAT for tests
  nowMs?: number;
}

export interface AutoMergeSweepResult {
  high_conf_merged: number;
  medium_conf_suggested: number;
  suppressed_skipped: number;
  duration_ms: number;
  dry_run: boolean;
}

/**
 * One sweep over the entities table. Merges every high-confidence pair
 * silently, persists every medium-confidence pair as a chat suggestion,
 * and emits `entity.merge.suggested` for each new suggestion.
 */
export async function runAutoMergeSweep(
  opts: AutoMergeSweepOpts = {},
): Promise<AutoMergeSweepResult> {
  const db = opts.db ?? getBrainDb();
  const enabled = opts.enabled ?? process.env.BRAIN_MERGE_AUTO_ENABLED === 'true';
  const dryRun = opts.dryRun ?? process.env.BRAIN_MERGE_AUTO_DRY_RUN === 'true';
  const notifyChat = opts.notifyChat ??
    (process.env.BRAIN_MERGE_AUTO_NOTIFY_CHAT ?? 'true') !== 'false';
  const nowMs = opts.nowMs ?? Date.now();
  const startedAt = nowMs;

  const result: AutoMergeSweepResult = {
    high_conf_merged: 0,
    medium_conf_suggested: 0,
    suppressed_skipped: 0,
    duration_ms: 0,
    dry_run: dryRun,
  };

  if (!enabled) {
    logger.debug('auto-merge: skipped (BRAIN_MERGE_AUTO_ENABLED=false)');
    return result;
  }

  // High-confidence: silent merge per pair.
  const highPairs = findHighConfidenceCandidates(db);
  for (const pair of highPairs) {
    if (isSuppressed(db, pair.entity_id_a, pair.entity_id_b, nowMs)) {
      result.suppressed_skipped += 1;
      continue;
    }
    if (dryRun) {
      logger.info({ pair }, 'auto-merge: would merge (dry-run, high-conf)');
      result.high_conf_merged += 1;
      continue;
    }
    try {
      await mergeEntities(pair.entity_id_a, pair.entity_id_b, {
        evidence: {
          trigger: 'deterministic',
          matched_field: pair.fields_matched[0] as MergeEvidenceField,
        },
        confidence: pair.confidence,
        mergedBy: 'auto:high',
        db,
      });
      result.high_conf_merged += 1;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          pair,
        },
        'auto-merge: high-conf merge failed',
      );
    }
  }

  // Medium-confidence path is added in Task 10.
  void notifyChat;
  void newId;
  void eventBus;

  result.duration_ms = Date.now() - startedAt;
  return result;
}

type MergeEvidenceField = 'email' | 'phone' | 'name' | 'slack_id' | 'signal_uuid';
```

Note: the `void notifyChat`, `void newId`, `void eventBus` are placeholders so TypeScript doesn't complain about unused imports between tasks. They are removed in Task 10.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "high-confidence path"`
Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): runAutoMergeSweep — high-confidence path"
```

---

## Task 10: Sweep — medium-confidence path

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
describe('runAutoMergeSweep — medium-confidence path', () => {
  it('persists a suggestion row and emits entity.merge.suggested', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');

    const events: Array<{ type: string; payload: unknown }> = [];
    const unsub = eventBus.on('entity.merge.suggested', (evt) => {
      events.push({ type: evt.type, payload: evt });
    });

    try {
      const result = await runAutoMergeSweep({ db, enabled: true });
      expect(result.medium_conf_suggested).toBe(1);
      const row = db
        .prepare(`SELECT * FROM entity_merge_suggestions LIMIT 1`)
        .get() as any;
      expect(row.entity_id_a).toBe('e-aaa');
      expect(row.entity_id_b).toBe('e-bbb');
      expect(row.reason_code).toBe('name_exact');
      expect(row.status).toBe('pending');
      expect(events).toHaveLength(1);
      expect((events[0].payload as any).suggestion_id).toBe(row.suggestion_id);
    } finally {
      unsub();
    }
  });

  it('does not emit a chat event when notifyChat=false', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');

    const events: unknown[] = [];
    const unsub = eventBus.on('entity.merge.suggested', (e) => events.push(e));
    try {
      await runAutoMergeSweep({ db, enabled: true, notifyChat: false });
      expect(events).toHaveLength(0);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM entity_merge_suggestions`)
        .get() as { n: number };
      expect(row.n).toBe(1);     // suggestion still persisted
    } finally {
      unsub();
    }
  });
});
```

(`eventBus` is already imported in test file — if not, add `import { eventBus } from '../../event-bus.js';` at the top.)

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "medium-confidence path"`
Expected: FAIL — `result.medium_conf_suggested` is undefined / 0.

- [ ] **Step 3: Edit `src/brain/auto-merge.ts`**

Replace the placeholder section in `runAutoMergeSweep` (the three `void` lines) with:

```typescript
  // Medium-confidence: persist suggestion + optionally emit event.
  const mediumPairs = findMediumConfidenceCandidates(db);
  for (const pair of mediumPairs) {
    if (isSuppressed(db, pair.entity_id_a, pair.entity_id_b, nowMs)) {
      result.suppressed_skipped += 1;
      continue;
    }
    if (dryRun) {
      logger.info({ pair }, 'auto-merge: would suggest (dry-run, medium-conf)');
      result.medium_conf_suggested += 1;
      continue;
    }

    const suggestionId = newId();
    let inserted = false;
    try {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO entity_merge_suggestions
             (suggestion_id, entity_id_a, entity_id_b, confidence, reason_code,
              evidence_json, suggested_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          suggestionId,
          pair.entity_id_a,
          pair.entity_id_b,
          pair.confidence,
          pair.reason_code,
          JSON.stringify(pair.evidence),
          nowMs,
        );
      inserted = info.changes === 1;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          pair,
        },
        'auto-merge: suggestion insert failed',
      );
      continue;
    }

    if (!inserted) {
      // UNIQUE conflict — a pending suggestion for this pair already exists.
      // Don't re-emit the event; the operator has already been told.
      continue;
    }

    result.medium_conf_suggested += 1;

    if (notifyChat) {
      eventBus.emit('entity.merge.suggested', {
        type: 'entity.merge.suggested',
        timestamp: nowMs,
        payload: {},
        suggestion_id: suggestionId,
        entity_id_a: pair.entity_id_a,
        entity_id_b: pair.entity_id_b,
        confidence: pair.confidence,
        reason_code: pair.reason_code,
        evidence: pair.evidence,
      });
    }
  }
```

Remove the three `void` placeholder lines.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "medium-confidence path"`
Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): runAutoMergeSweep — medium-confidence path with event emission"
```

---

## Task 11: Sweep — idempotency on re-run

**Files:**
- Test only: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
describe('runAutoMergeSweep — idempotency', () => {
  it('does not re-suggest the same pair on a second run', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Jonathan');
    seedPerson(db, 'e-bbb', 'Jonathan');

    const r1 = await runAutoMergeSweep({ db, enabled: true });
    expect(r1.medium_conf_suggested).toBe(1);

    const events: unknown[] = [];
    const unsub = eventBus.on('entity.merge.suggested', (e) => events.push(e));
    try {
      const r2 = await runAutoMergeSweep({ db, enabled: true });
      expect(r2.medium_conf_suggested).toBe(0);
      expect(events).toHaveLength(0);
    } finally {
      unsub();
    }

    // Still exactly one row.
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM entity_merge_suggestions`)
      .get() as { n: number };
    expect(cnt.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "idempotency"`
Expected: PASS — the UNIQUE constraint and `INSERT OR IGNORE` already handle this; this test locks the contract in.

- [ ] **Step 3: Commit**

```bash
git add src/brain/__tests__/auto-merge.test.ts
git commit -m "test(brain): auto-merge sweep idempotency on re-run"
```

---

## Task 12: Sweep — env-gate (BRAIN_MERGE_AUTO_ENABLED=false)

**Files:**
- Test only: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
describe('runAutoMergeSweep — env gate', () => {
  it('is a no-op when enabled=false', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');

    const result = await runAutoMergeSweep({ db, enabled: false });
    expect(result.high_conf_merged).toBe(0);
    expect(result.medium_conf_suggested).toBe(0);
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`)
      .get() as { n: number };
    expect(cnt.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "env gate"`
Expected: PASS — already implemented in Task 9 (the early `return` when `!enabled`).

- [ ] **Step 3: Commit**

```bash
git add src/brain/__tests__/auto-merge.test.ts
git commit -m "test(brain): auto-merge sweep is a no-op when disabled"
```

---

## Task 13: Sweep — dry-run mode

**Files:**
- Test only: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
describe('runAutoMergeSweep — dry-run', () => {
  it('reports counts but writes no rows when dryRun=true', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    seedAlias(db, 'a1', 'e-aaa', 'email', 'a@a.com');
    seedAlias(db, 'a2', 'e-bbb', 'email', 'a@a.com');
    seedPerson(db, 'e-ccc', 'Jonathan');
    seedPerson(db, 'e-ddd', 'Jonathan');

    const result = await runAutoMergeSweep({ db, enabled: true, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.high_conf_merged).toBe(1);
    expect(result.medium_conf_suggested).toBe(1);

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_suggestions`).get() as { n: number }).n,
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t "dry-run"`
Expected: PASS — already implemented in Tasks 9 and 10 (the `if (dryRun)` short-circuits).

- [ ] **Step 3: Commit**

```bash
git add src/brain/__tests__/auto-merge.test.ts
git commit -m "test(brain): auto-merge sweep dry-run writes nothing"
```

---

## Task 14: Auto-suppression on `claw unmerge` of an `auto:high` merge

**Why:** If the auto-merge sweep silently merged two entities and the operator subsequently runs `claw unmerge`, that's an explicit signal the auto-decision was wrong. The next sweep would re-merge the same pair under the same hard-id rule. We must write a permanent suppression so the operator's correction sticks.

**Files:**
- Modify: `src/brain/identity-merge-handler.ts` (inside `handleEntityUnmergeRequested`, after the successful unmerge call around line 219)
- Test: `src/brain/__tests__/identity-merge-handler.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
  it('writes a permanent suppression when unmerging an auto:high merge', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('al1','e-aaa','test','email','a@a.com','2026-04-28T00:00:00Z',1.0),
              ('al2','e-bbb','test','email','a@a.com','2026-04-28T00:00:00Z',1.0)`,
    ).run();

    // Simulate the auto-merge sweep merging this pair.
    const { runAutoMergeSweep } = await import('../auto-merge.js');
    await runAutoMergeSweep({ db, enabled: true });
    const log = db
      .prepare(`SELECT merge_id, merged_by FROM entity_merge_log LIMIT 1`)
      .get() as { merge_id: string; merged_by: string };
    expect(log.merged_by).toBe('auto:high');

    // Operator unmerges it.
    const replies: string[] = [];
    await handleEntityUnmergeRequested(
      {
        type: 'entity.unmerge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        merge_id_or_prefix: log.merge_id,
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );
    expect(replies[0]).toMatch(/rolled back/i);

    // Suppression must exist, permanent.
    const supp = db
      .prepare(
        `SELECT suppressed_until, reason FROM entity_merge_suppressions
          WHERE entity_id_a='e-aaa' AND entity_id_b='e-bbb'`,
      )
      .get() as { suppressed_until: number | null; reason: string } | undefined;
    expect(supp).toBeDefined();
    expect(supp!.suppressed_until).toBeNull();
    expect(supp!.reason).toBe('unmerged_by_operator');
  });

  it('does NOT write a suppression when unmerging a human-initiated merge', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaa', 'Alice');
    seedPerson(db, 'e-bbb', 'Alice');
    const { mergeEntities } = await import('../identity-merge.js');
    const merge = await mergeEntities('e-aaa', 'e-bbb', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });
    await handleEntityUnmergeRequested(
      {
        type: 'entity.unmerge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        merge_id_or_prefix: merge.merge_id,
      },
      { db, sendReply: async () => {} },
    );
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM entity_merge_suppressions`)
      .get() as { n: number };
    expect(cnt.n).toBe(0);
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "writes a permanent suppression"`
Expected: FAIL — no suppression row written.

- [ ] **Step 3: Edit `src/brain/identity-merge-handler.ts`**

Inside `handleEntityUnmergeRequested`, in the `try` block, after the successful `unmergeEntities` call and before `await reply(...)` (around line 220), add:

```typescript
    // Auto-suppress: if this merge was created by the auto-sweep, the
    // operator's unmerge is an explicit "this rule is wrong, don't try
    // again". Write a permanent suppression so the next sweep skips it.
    const wasAuto = await db
      .prepare(`SELECT merged_by FROM entity_merge_log WHERE merge_id = ?`)
      .get(row.merge_id) as { merged_by?: string } | undefined;
    // Note: by this point the unmerge has already DELETEd the merge_log row,
    // so we read the merged_by BEFORE calling unmergeEntities. Move the
    // read above the call.
```

Wait — that comment captures a real ordering problem. Restate the edit correctly:

**Replace** the body of the `try` block in `handleEntityUnmergeRequested` (currently lines 215–222):

```typescript
  try {
    // Read merged_by BEFORE unmerging — unmergeEntities deletes the row.
    const preLog = db
      .prepare(`SELECT merged_by FROM entity_merge_log WHERE merge_id = ?`)
      .get(row.merge_id) as { merged_by: string } | undefined;
    const wasAutoHigh = preLog?.merged_by?.startsWith('auto:') === true;

    const result = await unmergeEntities(row.merge_id, {
      db,
      force: evt.force ?? false,
    });

    if (wasAutoHigh) {
      const [a, b] = result.kept_entity_id < result.merged_entity_id
        ? [result.kept_entity_id, result.merged_entity_id]
        : [result.merged_entity_id, result.kept_entity_id];
      db.prepare(
        `INSERT OR IGNORE INTO entity_merge_suppressions
           (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
         VALUES (?, ?, NULL, 'unmerged_by_operator', ?)`,
      ).run(a, b, Date.now());
    }

    await reply(
      `claw unmerge: ✓ rolled back merge ${result.merge_id.slice(0, 6)}… — kept ${result.kept_entity_id.slice(0, 6)}…, restored ${result.merged_entity_id.slice(0, 6)}…`,
    );
  } catch (err) {
```

(The remainder of the catch block is unchanged.)

- [ ] **Step 4: Run the failing test and watch it pass**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "writes a permanent suppression"`
Expected: PASS.

- [ ] **Step 5: Run the negative test**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "does NOT write a suppression"`
Expected: PASS.

- [ ] **Step 6: Run the full handler test file to verify regressions**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/__tests__/identity-merge-handler.test.ts
git commit -m "feat(brain): auto-suppress entity pair when operator unmerges an auto:high merge"
```

---

## Task 14b: Extend `resolveHandle` to accept entity_id prefixes

**Why:** Task 15 formats chat suggestions as `claw merge 01KQ8X 01KQ9H` using 6-char ULID prefixes. The existing `resolveHandle` from PR 45 only matches `entity_aliases.field_value` and `canonical->>'name'` — it does not look up entities by id prefix. Without this extension, operators copy-pasting the suggested command get "handle not found". Adding entity_id-prefix lookup as a third resolution tier fixes the suggestion flow AND benefits the existing `claw merge` flow (operators can now address entities by short id directly).

**Files:**
- Modify: `src/brain/identity-merge-handler.ts` — extend `resolveHandle` (around line 31)
- Test: `src/brain/__tests__/identity-merge-handler.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
  it('claw merge resolves both handles via entity_id prefix', async () => {
    const db = getBrainDb();
    seedPerson(db, '01KQ8X5WSYDVRM28ZA3PZCVTGH', 'Alice');
    seedPerson(db, '01KQ9HHRDY5RYADT03SBQG07D6', 'Alice W');
    const replies: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: '01KQ8X',
        handle_b: '01KQ9H',
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );
    expect(replies[0]).toMatch(/merged/i);
    const log = db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('refuses an ambiguous entity_id prefix', async () => {
    const db = getBrainDb();
    seedPerson(db, '01KQ8XAA00000000000000', 'A');
    seedPerson(db, '01KQ8XBB00000000000000', 'B');
    seedPerson(db, '01KQ9HHHHH000000000000', 'C');
    const replies: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: '01KQ8X',
        handle_b: '01KQ9H',
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );
    expect(replies[0]).toMatch(/ambiguous/i);
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "entity_id prefix"`
Expected: FAIL — first test reports "not found" because `resolveHandle` does not look up by id prefix.

- [ ] **Step 3: Edit `src/brain/identity-merge-handler.ts`**

Inside `resolveHandle` (around line 31), after the `nameHits` block and before the dedup loop, add a third tier:

```typescript
  // 3. Entity-id prefix match (used by chat-suggestion replies, where the
  //    operator copy-pastes a short ULID prefix). Bounded to <=5 hits to
  //    prevent runaway results when an operator types a very short prefix.
  const prefixHits = db
    .prepare(
      `SELECT entity_id FROM entities
        WHERE entity_id LIKE ? || '%'
        LIMIT 5`,
    )
    .all(handle.trim()) as Array<{ entity_id: string }>;
```

Then in the existing dedup loop, add a third loop after the `nameHits` loop:

```typescript
  for (const r of prefixHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'id_prefix' });
      seen.add(r.entity_id);
    }
  }
```

Update the `ResolvedCandidate` type (around line 20):

```typescript
interface ResolvedCandidate {
  entity_id: string;
  reason: 'alias' | 'canonical_name' | 'id_prefix';
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "entity_id prefix"`
Expected: Both new tests PASS.

- [ ] **Step 5: Run the full handler test suite**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts`
Expected: All PASS — existing alias / canonical-name resolution still works.

- [ ] **Step 6: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/__tests__/identity-merge-handler.test.ts
git commit -m "feat(brain): resolveHandle accepts entity_id prefixes"
```

---

## Task 15: `entity.merge.suggested` chat formatter

**Files:**
- Modify: `src/brain/identity-merge-handler.ts` (add a new exported handler + bus subscription)
- Test: `src/brain/__tests__/identity-merge-handler.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { handleEntityMergeSuggested } from '../identity-merge-handler.js';

describe('handleEntityMergeSuggested', () => {
  it('formats a chat message with both abbreviated ids and the resolved name', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaaaaa', 'Jonathan');
    seedPerson(db, 'e-bbbbbb', 'Jonathan');
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('al1','e-aaaaaa','signal','signal_phone','+16263483472','2026-04-28T00:00:00Z',1.0),
              ('al2','e-bbbbbb','signal','signal_profile_name','Jonathan','2026-04-28T00:00:00Z',1.0)`,
    ).run();

    const replies: string[] = [];
    await handleEntityMergeSuggested(
      {
        type: 'entity.merge.suggested',
        timestamp: Date.now(),
        payload: {},
        suggestion_id: 's1',
        entity_id_a: 'e-aaaaaa',
        entity_id_b: 'e-bbbbbb',
        confidence: 0.6,
        reason_code: 'name_exact',
        evidence: {
          fields_matched: ['name'],
          canonical_a: { name: 'Jonathan', signal_phone: '+16263483472' },
          canonical_b: { name: 'Jonathan', signal_profile_name: 'Jonathan' },
        },
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/Possible duplicate/i);
    expect(replies[0]).toContain('e-aaaa');     // abbreviated id A
    expect(replies[0]).toContain('e-bbbb');     // abbreviated id B
    expect(replies[0]).toContain('Jonathan');
    expect(replies[0]).toContain('claw merge ');
    expect(replies[0]).toContain('claw merge-reject ');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "handleEntityMergeSuggested"`
Expected: FAIL — `handleEntityMergeSuggested is not exported`.

- [ ] **Step 3: Edit `src/brain/identity-merge-handler.ts`**

Add `EntityMergeSuggestedEvent` to the import block at the top:

```typescript
import type {
  EntityMergeRequestedEvent,
  EntityMergeSuggestedEvent,
  EntityUnmergeRequestedEvent,
} from '../events.js';
```

Add a new exported handler somewhere after `handleEntityUnmergeRequested` and before the `unsubMerge`/`unsubUnmerge` declarations:

```typescript
/**
 * Format a medium-confidence duplicate suggestion as a chat message and
 * send it via setIdentityMergeReply. The operator can accept by typing
 * `claw merge <a> <b>` or suppress with `claw merge-reject <a> <b>`.
 */
export async function handleEntityMergeSuggested(
  evt: EntityMergeSuggestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const reply = opts.sendReply ?? (async () => {});
  const a6 = evt.entity_id_a.slice(0, 6);
  const b6 = evt.entity_id_b.slice(0, 6);
  const nameA = (evt.evidence.canonical_a?.name as string | undefined) ?? '(unnamed)';
  const nameB = (evt.evidence.canonical_b?.name as string | undefined) ?? '(unnamed)';
  // Build a one-line "evidence tail" per side: pick the first non-name
  // canonical field for context. Falls back to empty.
  const tail = (canon: Record<string, unknown>): string => {
    for (const [k, v] of Object.entries(canon)) {
      if (k === 'name') continue;
      return ` — ${k}:${String(v)}`;
    }
    return '';
  };
  const text =
    `🔗 Possible duplicate (medium confidence)\n\n` +
    `A: ${nameA} (${a6}…)${tail(evt.evidence.canonical_a ?? {})}\n` +
    `B: ${nameB} (${b6}…)${tail(evt.evidence.canonical_b ?? {})}\n\n` +
    `Reply:\n` +
    `  claw merge ${a6} ${b6}        — confirm merge\n` +
    `  claw merge-reject ${a6} ${b6} — never suggest again`;
  await reply(text);
}
```

(The `opts.db` parameter is kept on the signature for symmetry but unused here — the formatter has all the info it needs in the event payload.)

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "handleEntityMergeSuggested"`
Expected: PASS.

- [ ] **Step 5: Wire the handler into `startIdentityMergeHandler`**

In the same file, find `startIdentityMergeHandler` (around line 270) and append a new subscription right after the `unsubUnmerge = eventBus.on(...)` block, before the `logger.info('Identity merge handler started')` line:

First, declare a third unsub at module scope (alongside `unsubMerge`/`unsubUnmerge`):

```typescript
let unsubSuggested: (() => void) | null = null;
```

Then inside the `if (unsubMerge || unsubUnmerge) return;` guard, change the condition to `if (unsubMerge || unsubUnmerge || unsubSuggested) return;`.

Then append:

```typescript
  unsubSuggested = eventBus.on('entity.merge.suggested', async (evt) => {
    try {
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          // Suggestions go to the main group's channel — they're not tied
          // to any specific chat_id. The channelReply signature requires
          // chat_id + platform; we use the literals 'main' / 'signal' as
          // a sentinel that the channel layer interprets as "default to
          // the main group". Index.ts wires this when registering.
          ? (text: string) => channelReply!('main', 'signal', text)
          : undefined);
      await handleEntityMergeSuggested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: suggestion handler error',
      );
    }
  });
```

Update `stopIdentityMergeHandler` to also clear `unsubSuggested`:

```typescript
  if (unsubSuggested) {
    unsubSuggested();
    unsubSuggested = null;
  }
```

- [ ] **Step 6: Run the full handler test file**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/__tests__/identity-merge-handler.test.ts
git commit -m "feat(brain): handler + chat formatter for entity.merge.suggested"
```

---

## Task 16a: Signal channel — `claw merge-reject` trigger

**CRITICAL: insert this block BEFORE the existing `claw merge` block** to avoid the regex collision noted at the top of this plan.

**Files:**
- Modify: `src/channels/signal.ts` (around line 330, before the existing `mergeMatch` block)
- Test: `src/channels/signal.test.ts` (add a new case alongside the existing `claw merge` parser test)

- [ ] **Step 1: Append the failing test**

In `src/channels/signal.test.ts`, immediately after the existing `claw merge text emits entity.merge.requested with parsed handles` test (around line 795–824), add:

```typescript
  it('claw merge-reject emits entity.merge.reject.requested and NOT entity.merge.requested', async () => {
    const opts = createInboundTestOpts();
    const env = make1to1Envelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'claw merge-reject e-aaaaaa e-bbbbbb',
        expiresInSeconds: 0,
        viewOnce: false,
      },
    });
    mockPollResponse(env);
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    const rejectEmits = mockEventBusEmit.mock.calls.filter(
      (c) => c[0] === 'entity.merge.reject.requested',
    );
    expect(rejectEmits).toHaveLength(1);
    expect(rejectEmits[0][1]).toMatchObject({
      type: 'entity.merge.reject.requested',
      platform: 'signal',
      handle_a: 'e-aaaaaa',
      handle_b: 'e-bbbbbb',
    });

    // Critical: must NOT also emit entity.merge.requested. The existing
    // `claw merge` regex would otherwise capture this body via \b matching.
    const mergeEmits = mockEventBusEmit.mock.calls.filter(
      (c) => c[0] === 'entity.merge.requested',
    );
    expect(mergeEmits).toHaveLength(0);

    await channel.disconnect();
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/channels/signal.test.ts -t "claw merge-reject"`
Expected: FAIL — `expect(calls).toContain('entity.merge.reject.requested')` because the existing `claw merge` regex captures the message and emits `entity.merge.requested` (or, if the args parse fails, emits nothing).

- [ ] **Step 3: Edit `src/channels/signal.ts`**

In the imports, add `EntityMergeRejectRequestedEvent` to the events-import line:

```typescript
import type {
  // ... existing names ...
  EntityMergeRejectRequestedEvent,
} from '../events.js';
```

Find the existing `// 4b. \`claw merge <a> <b>\` text trigger` block (around line 330). **Insert a new block immediately before it:**

```typescript
    // 4a-bis. `claw merge-reject <a> <b>` text trigger — operator-issued
    // suppression of a suggested merge. MUST come before the `claw merge`
    // matcher because `\b` would otherwise let `claw merge-reject ...`
    // fall into the merge handler.
    const rejectMatch = body.match(/^claw\s+merge-reject\b\s*(.+)$/i);
    if (rejectMatch) {
      const args = parseMergeArgs(rejectMatch[1].trim());
      if (args.length === 2) {
        eventBus.emit('entity.merge.reject.requested', {
          type: 'entity.merge.reject.requested',
          source: 'signal',
          timestamp: Date.now(),
          payload: {},
          platform: 'signal',
          chat_id: chatId,
          requested_by_handle: envelope.sourceName ?? sourceJid,
          handle_a: args[0],
          handle_b: args[1],
        } satisfies EntityMergeRejectRequestedEvent);
      } else {
        logger.warn(
          { body, parsed: args },
          'signal: claw merge-reject needs exactly two handles — ignoring',
        );
      }
      return;
    }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/channels/signal.test.ts -t "claw merge-reject"`
Expected: PASS.

- [ ] **Step 5: Run the full signal test file to verify the existing `claw merge` case is unaffected**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): claw merge-reject trigger emits entity.merge.reject.requested"
```

---

## Task 16b: Discord channel — `claw merge-reject` trigger

**Files:**
- Modify: `src/channels/discord.ts` (around line 65, before the existing `mergeMatch` block)
- Test: `src/channels/discord.test.ts`

- [ ] **Step 1: Append the failing test**

In `src/channels/discord.test.ts`, inside the existing `describe('MessageCreate claw merge text trigger', ...)` block (around line 1175), append:

```typescript
    it('claw merge-reject emits entity.merge.reject.requested and NOT entity.merge.requested', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        messageId: 'msg_reject',
        content: 'claw merge-reject e-aaaaaa e-bbbbbb',
      });
      await triggerMessage(msg);

      const rejectEmits = mockEventBusEmit.mock.calls.filter(
        (c) => c[0] === 'entity.merge.reject.requested',
      );
      expect(rejectEmits).toHaveLength(1);
      expect(rejectEmits[0][1]).toMatchObject({
        type: 'entity.merge.reject.requested',
        platform: 'discord',
        handle_a: 'e-aaaaaa',
        handle_b: 'e-bbbbbb',
      });

      const mergeEmits = mockEventBusEmit.mock.calls.filter(
        (c) => c[0] === 'entity.merge.requested',
      );
      expect(mergeEmits).toHaveLength(0);
    });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/channels/discord.test.ts -t "claw merge-reject"`
Expected: FAIL — the existing `claw merge` regex captures the body and emits `entity.merge.requested` (or warns about the 3-arg parse), so `entity.merge.reject.requested` count is 0.

- [ ] **Step 3: Edit `src/channels/discord.ts`**

Add `EntityMergeRejectRequestedEvent` to the events-import block.

Find the `// \`claw merge <a> <b>\` text trigger` block (around line 64). **Insert a new block immediately before it:**

```typescript
      // `claw merge-reject <a> <b>` text trigger. MUST come before the
      // `claw merge` matcher because `\b` would otherwise let
      // `claw merge-reject ...` fall into the merge handler.
      const rejectMatch = rawContent.match(/^claw\s+merge-reject\b\s*(.+)$/i);
      if (rejectMatch) {
        const args = parseMergeArgs(rejectMatch[1].trim());
        if (args.length === 2) {
          eventBus.emit('entity.merge.reject.requested', {
            type: 'entity.merge.reject.requested',
            source: 'discord',
            timestamp: Date.now(),
            payload: {},
            platform: 'discord',
            chat_id: message.channelId,
            requested_by_handle:
              message.member?.displayName ??
              message.author?.username ??
              'unknown',
            handle_a: args[0],
            handle_b: args[1],
          } satisfies EntityMergeRejectRequestedEvent);
        } else {
          logger.warn(
            { content: rawContent, parsed: args },
            'discord: claw merge-reject needs exactly two handles — ignoring',
          );
        }
        return;
      }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/channels/discord.test.ts -t "claw merge-reject"`
Expected: PASS.

- [ ] **Step 5: Run the full discord test file**

Run: `npx vitest run src/channels/discord.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): claw merge-reject trigger emits entity.merge.reject.requested"
```

---

## Task 17: `claw merge-reject` brain handler

**Files:**
- Modify: `src/brain/identity-merge-handler.ts` (new exported handler + bus subscription)
- Test: `src/brain/__tests__/identity-merge-handler.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { handleEntityMergeRejectRequested } from '../identity-merge-handler.js';

describe('handleEntityMergeRejectRequested', () => {
  it('writes a permanent suppression and updates pending suggestion to rejected', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaaaaa', 'Jonathan');
    seedPerson(db, 'e-bbbbbb', 'Jonathan');
    db.prepare(
      `INSERT INTO entity_merge_suggestions
         (suggestion_id, entity_id_a, entity_id_b, confidence, reason_code,
          evidence_json, suggested_at, status)
       VALUES ('s1','e-aaaaaa','e-bbbbbb',0.6,'name_exact','{}',?,'pending')`,
    ).run(Date.now());

    const replies: string[] = [];
    await handleEntityMergeRejectRequested(
      {
        type: 'entity.merge.reject.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'e-aaaaaa',
        handle_b: 'e-bbbbbb',
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );

    expect(replies[0]).toMatch(/suppressed/i);
    const supp = db
      .prepare(
        `SELECT suppressed_until, reason FROM entity_merge_suppressions
          WHERE entity_id_a='e-aaaaaa' AND entity_id_b='e-bbbbbb'`,
      )
      .get() as { suppressed_until: number | null; reason: string };
    expect(supp.suppressed_until).toBeNull();
    expect(supp.reason).toBe('operator_rejected');

    const sugg = db
      .prepare(`SELECT status FROM entity_merge_suggestions WHERE suggestion_id='s1'`)
      .get() as { status: string };
    expect(sugg.status).toBe('rejected');
  });

  it('still writes a suppression even when no pending suggestion exists', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaaaaa', 'X');
    seedPerson(db, 'e-bbbbbb', 'X');
    await handleEntityMergeRejectRequested(
      {
        type: 'entity.merge.reject.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'e-aaaaaa',
        handle_b: 'e-bbbbbb',
      },
      { db, sendReply: async () => {} },
    );
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM entity_merge_suppressions`)
      .get() as { n: number };
    expect(cnt.n).toBe(1);
  });

  it('refuses if a handle does not resolve', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-aaaaaa', 'X');
    const replies: string[] = [];
    await handleEntityMergeRejectRequested(
      {
        type: 'entity.merge.reject.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'e-aaaaaa',
        handle_b: 'nonexistent',
      },
      { db, sendReply: async (t) => { replies.push(t); } },
    );
    expect(replies[0]).toMatch(/not found/i);
    const cnt = db
      .prepare(`SELECT COUNT(*) AS n FROM entity_merge_suppressions`)
      .get() as { n: number };
    expect(cnt.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts -t "handleEntityMergeRejectRequested"`
Expected: FAIL — `handleEntityMergeRejectRequested is not exported`.

- [ ] **Step 3: Edit `src/brain/identity-merge-handler.ts`**

Add `EntityMergeRejectRequestedEvent` to the events import block.

The existing `resolveHandle` function must be reused — it's already defined as a module-private function at line 31. Since the new handler is in the same file, it can call `resolveHandle` directly.

Add a new exported handler somewhere after `handleEntityMergeSuggested`:

```typescript
/**
 * Handle `claw merge-reject <a> <b>`. Writes a permanent suppression row
 * for the pair and flips any pending suggestion to `rejected`. Whether or
 * not a suggestion existed, the suppression is written so the operator
 * can pre-empt a future match.
 */
export async function handleEntityMergeRejectRequested(
  evt: EntityMergeRejectRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const candA = resolveHandle(db, evt.handle_a);
  const candB = resolveHandle(db, evt.handle_b);
  if (candA.length === 0) {
    await reply(`claw merge-reject: handle '${evt.handle_a}' not found`);
    return;
  }
  if (candB.length === 0) {
    await reply(`claw merge-reject: handle '${evt.handle_b}' not found`);
    return;
  }
  if (candA.length > 1) {
    await reply(
      `claw merge-reject: handle '${evt.handle_a}' is ambiguous (${candA.length} matches)`,
    );
    return;
  }
  if (candB.length > 1) {
    await reply(
      `claw merge-reject: handle '${evt.handle_b}' is ambiguous (${candB.length} matches)`,
    );
    return;
  }

  const aId = candA[0].entity_id;
  const bId = candB[0].entity_id;
  if (aId === bId) {
    await reply(`claw merge-reject: '${evt.handle_a}' and '${evt.handle_b}' resolve to the same entity`);
    return;
  }
  const [a, b] = aId < bId ? [aId, bId] : [bId, aId];

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO entity_merge_suppressions
         (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES (?, ?, NULL, 'operator_rejected', ?)`,
    ).run(a, b, Date.now());

    db.prepare(
      `UPDATE entity_merge_suggestions
          SET status = 'rejected', status_at = ?
        WHERE entity_id_a = ? AND entity_id_b = ? AND status = 'pending'`,
    ).run(Date.now(), a, b);
  })();

  await reply(
    `claw merge-reject: suppressed ${a.slice(0, 6)}… ↔ ${b.slice(0, 6)}… — will not suggest again`,
  );
}
```

- [ ] **Step 4: Wire the bus subscription**

Add module-scope `let unsubReject: (() => void) | null = null;`.

Update the early-return guard in `startIdentityMergeHandler` to include `unsubReject`.

Inside `startIdentityMergeHandler`, after the `unsubSuggested` subscription, append:

```typescript
  unsubReject = eventBus.on('entity.merge.reject.requested', async (evt) => {
    try {
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          ? (text: string) => channelReply!(evt.chat_id, evt.platform, text)
          : undefined);
      await handleEntityMergeRejectRequested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: reject handler error',
      );
    }
  });
```

Update `stopIdentityMergeHandler` to clear `unsubReject` similarly.

- [ ] **Step 5: Run the test file**

Run: `npx vitest run src/brain/__tests__/identity-merge-handler.test.ts`
Expected: All PASS (the three new cases plus all prior cases).

- [ ] **Step 6: Commit**

```bash
git add src/brain/identity-merge-handler.ts src/brain/__tests__/identity-merge-handler.test.ts
git commit -m "feat(brain): handler for claw merge-reject — writes suppression and updates suggestion"
```

---

## Task 18: `startAutoMergeSchedule` — daily cron via setInterval

**Files:**
- Modify: `src/brain/auto-merge.ts`
- Test: `src/brain/__tests__/auto-merge.test.ts`

- [ ] **Step 1: Append the failing test**

```typescript
import { startAutoMergeSchedule } from '../auto-merge.js';

describe('startAutoMergeSchedule', () => {
  it('returns a stop function and runs the sweep on the configured interval', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const stop = startAutoMergeSchedule({
      intervalMs: 1000,
      runOnStart: true,
      run: async () => { calls.push(Date.now()); },
    });
    expect(calls).toHaveLength(1);   // runOnStart fired
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);   // stopped
    vi.useRealTimers();
  });

  it('skips runOnStart when runOnStart=false', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const stop = startAutoMergeSchedule({
      intervalMs: 1000,
      runOnStart: false,
      run: async () => { calls.push(Date.now()); },
    });
    expect(calls).toHaveLength(0);
    stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t startAutoMergeSchedule`
Expected: FAIL — `startAutoMergeSchedule is not exported`.

- [ ] **Step 3: Append to `src/brain/auto-merge.ts`**

```typescript
const DEFAULT_AUTO_MERGE_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 24h

export interface AutoMergeScheduleOpts {
  intervalMs?: number;
  runOnStart?: boolean;        // default: true (so first deploy doesn't wait 24h)
  run?: () => Promise<unknown>;  // injected for tests; default: runAutoMergeSweep()
}

/**
 * Run the auto-merge sweep on a fixed interval. Returns a stop function.
 * Errors from the sweep are caught and logged so a transient DB blip
 * doesn't crash the scheduler.
 */
export function startAutoMergeSchedule(
  opts: AutoMergeScheduleOpts = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_AUTO_MERGE_INTERVAL_MS;
  const run = opts.run ?? (() => runAutoMergeSweep());
  const tick = (): void => {
    void run().catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'auto-merge: sweep failed',
      ),
    );
  };
  if (opts.runOnStart !== false) tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/brain/__tests__/auto-merge.test.ts -t startAutoMergeSchedule`
Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add src/brain/auto-merge.ts src/brain/__tests__/auto-merge.test.ts
git commit -m "feat(brain): startAutoMergeSchedule — daily sweep with stop function"
```

---

## Task 19: Wire the schedule into `src/index.ts`

**Files:**
- Modify: `src/index.ts` (alongside the other `start*Schedule` calls around line 1390–1424)

- [ ] **Step 1: Edit `src/index.ts` — add the import**

Find the existing import line that imports from `./brain/weekly-digest.js` or similar (around line 130). Add a new import alongside:

```typescript
import { startAutoMergeSchedule } from './brain/auto-merge.js';
```

- [ ] **Step 2: Wire the schedule**

Find `const stopReflectionSched = startReflectionSchedule();` (around line 1424). Add directly after it:

```typescript
  // Brain auto-merge — nightly sweep over the entities table to detect
  // duplicate persons. Gated by BRAIN_MERGE_AUTO_ENABLED (default off).
  // Initial run on startup so a freshly-deployed env-var change is picked
  // up without waiting 24h.
  const stopAutoMergeSched = startAutoMergeSchedule();
```

Find the corresponding shutdown sequence (search for `stopReflectionSched(` — it should appear in a graceful shutdown handler). Add directly after it:

```typescript
  stopAutoMergeSched();
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run the full project test suite to confirm no regressions**

Run: `npm test` (or `npx vitest run`)
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire auto-merge nightly schedule"
```

---

## Task 20: `.env.example` updates

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Read the current `.env.example` to find the brain section**

Run: `grep -n "BRAIN_MERGE\|BRAIN_DIGEST" .env.example`
Expected: shows existing `BRAIN_MERGE_AUTO_LOW_CONF_REJECT` placeholder and adjacent brain vars.

- [ ] **Step 2: Edit `.env.example`**

Replace the `BRAIN_MERGE_AUTO_LOW_CONF_REJECT=...` line with the following block (keeping any leading comment lines that explain the brain section):

```bash
# --- Auto-merge (duplicate entity detection) ---
# Master switch. Off by default. When false, the sweep is a no-op.
BRAIN_MERGE_AUTO_ENABLED=false
# Minimum confidence for silent auto-merge. Default 1.0 = only hard-id matches.
BRAIN_MERGE_AUTO_HIGH_CONF_THRESHOLD=1.0
# Minimum confidence for chat suggestion. Default 0.5.
BRAIN_MERGE_AUTO_SUGGEST_THRESHOLD=0.5
# Dry-run mode: log would-merges and would-suggestions but write nothing.
BRAIN_MERGE_AUTO_DRY_RUN=false
# When false, suggestions are persisted to the suggestions table but no
# chat message is sent. Useful for "build up the table first, then turn on chat".
BRAIN_MERGE_AUTO_NOTIFY_CHAT=true
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: env vars for auto-merge feature"
```

---

## Task 21: Final verification

- [ ] **Step 1: Run the full test suite once more**

Run: `npm test`
Expected: All PASS.

- [ ] **Step 2: Run the type checker**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual smoke test (no commit)**

Set the env vars in a local `.env`:

```bash
BRAIN_MERGE_AUTO_ENABLED=true
BRAIN_MERGE_AUTO_DRY_RUN=true
```

Run the daemon (`npm run dev`). After startup, watch the logs for `auto-merge: would merge` or `auto-merge: would suggest` lines. The fixture in production (`Jonathan` × 2) should appear as a `would suggest`.

- [ ] **Step 4: If everything looks good, set dryRun=false in your local `.env` and restart**

Send `claw save Test merge target …` in a Signal NTS as a sanity check that the existing chat-ingest flow still works after the wiring change. Verify the daily sweep runs at 02:00 local (or hits the next scheduled fire after restart, since `runOnStart: true` is the default).

- [ ] **Step 5: Final commit (optional, only if any docs need updating)**

If the manual smoke surfaced a doc gap, edit it now and commit.

```bash
git status   # confirm clean working tree
```

---

## Self-Review

**1. Spec coverage check:**

| Spec section | Task |
| ------------ | ---- |
| Architecture diagram (sweep + handler + claw merge-reject) | 9, 10, 15, 17 |
| Confidence tiers — HIGH | 5 (classifier), 9 (sweep) |
| Confidence tiers — MEDIUM | 6 (classifier), 10 (sweep) |
| Confidence tiers — LOW | (deferred per spec — no task; sweep does not call low-tier) |
| Hard-identifier list | 5 (`HARD_IDENTIFIER_FIELDS` constant) |
| "Conflicting hard identifier" short-circuit | 6 (`hasConflictingIdentifier`) |
| Schema: `entity_merge_suggestions` | 1 |
| Schema: `entity_merge_suppressions` | 1 |
| Lex-ordering invariant | 3 (helper), 8/14/15/17 (call sites) |
| Entity-id prefix resolution for chat suggestions | 14b |
| `entity.merge.suggested` event | 2 (type), 10 (emit), 15 (handle) |
| `claw merge-reject` channel parsing | 16a (Signal), 16b (Discord) |
| `claw merge-reject` brain handler | 17 |
| `mergeEntities()` lifecycle hook | 8 |
| Auto-suppression on unmerge of `auto:high` | 14 |
| Env vars (5 in, 1 out) | 20 |
| Dry-run mode | 9, 10 (impl), 13 (test) |
| Idempotency on re-run | 11 |
| Backfill via first sweep | (no dedicated task — first run IS the backfill, by design) |
| Metrics (counters + duration) | 9, 10 (returned in `AutoMergeSweepResult`); detailed metrics-module wiring deferred to a follow-up |
| Testing layers (1) classifier (2) sweep (3) handler | 5/6/7 (1), 9/10/11/12/13 (2), 15/17 (3) |
| Schedule (`startAutoMergeSchedule`) | 18, 19 (wire) |

Missing: a dedicated metrics-module task (the spec lists six counters/histograms). The sweep does report counts in its return value, which is sufficient for v1; the spec's metrics integration can be picked up in a small follow-up after this lands. Adding it as a v1 task would expand scope without functional benefit. **Decision: defer to follow-up; not in this plan.**

**2. Placeholder scan:** None of the No-Placeholder patterns appear. Every code step shows the actual code. The "Similar to Task N" pattern is avoided.

**3. Type consistency:**
- `lexOrdered` returns `[string, string]` — used identically in Tasks 6, 7, 8, 14, 17.
- `HighConfidencePair.fields_matched: string[]` — same shape used in test assertions.
- `MediumConfidencePair.evidence` shape matches `EntityMergeSuggestedEvent.evidence` shape in `src/events.ts`.
- `runAutoMergeSweep` opts: `{ db, enabled, dryRun, notifyChat, nowMs }` — used identically in tests across Tasks 9–13.
- `AutoMergeSweepResult` field names (`high_conf_merged`, `medium_conf_suggested`, `suppressed_skipped`) — used identically in tests.

**4. Ambiguity check:**
- Trigger ordering between `claw merge-reject` and `claw merge` is called out at the top of the plan AND in the in-task comment AND tested in 16a/16b.
- Lex-ordering applies to BOTH new tables, called out in Task 1 schema comments and enforced in helper.
- Suppression filter applies to BOTH high- and medium-tier candidates — encoded in Task 9's loop and Task 10's loop separately. Test in Task 9 covers the high-tier case explicitly.
