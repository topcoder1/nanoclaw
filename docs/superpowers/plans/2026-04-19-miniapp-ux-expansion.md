# Mini-App UX Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the email mini-app with canned reply chips, triage actions (Snooze / Unsubscribe / Mute thread), classification-driven button layout, and user-initiated agent drafting (Quick + with prompt).

**Architecture:** Backend-first: add DB tables + detection heuristics + per-action services (mute filter, snooze scheduler, unsubscribe executor). Then swap the static email-full button row for a classification-aware template. Canned chips and Draft-with-AI reuse the existing `PendingSendRegistry` and `spawnAgentContainer` infrastructure respectively. All new routes follow the uniform `{ ok, error?, code? }` response shape.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest, existing Gmail channel, existing event-bus, existing agent container runner.

**Spec:** [docs/superpowers/specs/2026-04-19-miniapp-ux-expansion-design.md](../specs/2026-04-19-miniapp-ux-expansion-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `migrations/2026-04-19-ux-expansion.sql` | Tables + columns + CHECK updates |
| `src/triage/sender-kind.ts` | Bot/human + transactional classification (pure) |
| `src/triage/mute-filter.ts` | SSE intake filter + cascade-resolve helper |
| `src/triage/snooze-scheduler.ts` | 60s wake-tick loop |
| `src/triage/unsubscribe-executor.ts` | Header parse + method picker + exec |
| `src/mini-app/actions.ts` | Action route handlers (mounted in server.ts) |
| `src/mini-app/templates/action-row.ts` | Classification-aware button row renderer |
| `src/triage/__tests__/sender-kind.test.ts` | |
| `src/triage/__tests__/mute-filter.test.ts` | |
| `src/triage/__tests__/snooze-scheduler.test.ts` | |
| `src/triage/__tests__/unsubscribe-executor.test.ts` | |
| `src/__tests__/mini-app-actions.test.ts` | Route tests |
| `src/__tests__/miniapp-ux-expansion-integration.test.ts` | End-to-end |

### Modified files

| Path | Change |
|---|---|
| `src/mini-app/server.ts` | Wire `actions.ts` routes |
| `src/mini-app/templates/email-full.ts` | Swap static row for `renderActionRow()` |
| `src/email-sse.ts` | Call `muteFilter`, populate `sender_kind` + `subtype` |
| `src/tracked-items.ts` | Add `sender_kind`, `subtype` columns + types |
| `src/index.ts` | Start `startSnoozeScheduler` alongside reconcilers |
| `src/gmail-ops.ts` | Add `sendEmail` method on `GmailOps` + `GmailOpsProvider` |
| `src/channels/gmail.ts` | Implement `sendEmail` via `gmail.users.messages.send` |
| `scripts/qa/invariants.ts` | Register `muted-threads-never-visible` |

---

## Phase 1 — Database migrations

### Task 1: Add tables, columns, and CHECK updates

**Files:**
- Create: `migrations/2026-04-19-ux-expansion.sql`
- Modify: `src/db.ts` (register the migration in the runner)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/migrations-2026-04-19.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

describe('2026-04-19 ux expansion migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'migrations', '2026-04-19-ux-expansion.sql'),
    'utf8',
  );

  function seed() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY,
        source TEXT,
        state TEXT CHECK (state IN ('pending','pushed','held','queued','resolved','dropped','ignore')),
        queue TEXT,
        classification TEXT,
        thread_id TEXT,
        detected_at INTEGER,
        resolved_at INTEGER,
        resolution_method TEXT,
        metadata TEXT
      );
    `);
    return db;
  }

  it('creates muted_threads table with expected columns', () => {
    const db = seed();
    db.exec(sql);
    const cols = db.prepare("PRAGMA table_info('muted_threads')").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['account', 'muted_at', 'reason', 'thread_id']);
    const pk = cols.find((c) => c.name === 'thread_id');
    expect(pk?.pk).toBe(1);
  });

  it('creates snoozed_items table', () => {
    const db = seed();
    db.exec(sql);
    const cols = db
      .prepare("PRAGMA table_info('snoozed_items')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'item_id',
      'original_queue',
      'original_state',
      'snoozed_at',
      'wake_at',
    ]);
  });

  it('creates unsubscribe_log table', () => {
    const db = seed();
    db.exec(sql);
    const cols = db
      .prepare("PRAGMA table_info('unsubscribe_log')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'attempted_at',
      'error',
      'id',
      'item_id',
      'method',
      'status',
      'url',
    ]);
  });

  it('adds sender_kind and subtype columns to tracked_items', () => {
    const db = seed();
    db.exec(sql);
    const cols = db
      .prepare("PRAGMA table_info('tracked_items')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('sender_kind');
    expect(names).toContain('subtype');
  });

  it('allows state=snoozed in tracked_items CHECK constraint', () => {
    const db = seed();
    db.exec(sql);
    expect(() =>
      db
        .prepare(
          'INSERT INTO tracked_items (id, state) VALUES (?, ?)',
        )
        .run('t1', 'snoozed'),
    ).not.toThrow();
  });

  it('snooze row FK cascades when tracked_items row deleted', () => {
    const db = seed();
    db.exec(sql);
    db.prepare('INSERT INTO tracked_items (id, state) VALUES (?, ?)').run(
      't1',
      'snoozed',
    );
    db.prepare(
      'INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state) VALUES (?, ?, ?, ?)',
    ).run('t1', Date.now(), Date.now() + 3600_000, 'pushed');
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM tracked_items WHERE id = ?').run('t1');
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM snoozed_items')
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/migrations-2026-04-19.test.ts`
Expected: FAIL — file `migrations/2026-04-19-ux-expansion.sql` not found.

- [ ] **Step 3: Create the migration file**

Create `migrations/2026-04-19-ux-expansion.sql`:

```sql
-- Mini-app UX expansion: mute threads, snooze, unsubscribe log, sender heuristics

-- tracked_items CHECK update: add 'snoozed' to the allowlist.
-- SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we rebuild.
-- Guard: if the column ever diverges, this migration will need revisiting.
CREATE TABLE tracked_items_new (
  id TEXT PRIMARY KEY,
  source TEXT,
  source_id TEXT,
  group_name TEXT,
  state TEXT CHECK (state IN (
    'pending','pushed','held','queued','resolved','dropped','ignore','snoozed'
  )),
  queue TEXT,
  classification TEXT,
  subtype TEXT,
  sender_kind TEXT CHECK (sender_kind IN ('human','bot','unknown') OR sender_kind IS NULL),
  title TEXT,
  thread_id TEXT,
  detected_at INTEGER,
  resolved_at INTEGER,
  resolution_method TEXT,
  action_intent TEXT,
  metadata TEXT
);
INSERT INTO tracked_items_new (
  id, source, source_id, group_name, state, queue, classification,
  title, thread_id, detected_at, resolved_at, resolution_method,
  action_intent, metadata
)
SELECT
  id, source, source_id, group_name, state, queue, classification,
  title, thread_id, detected_at, resolved_at, resolution_method,
  action_intent, metadata
FROM tracked_items;
DROP TABLE tracked_items;
ALTER TABLE tracked_items_new RENAME TO tracked_items;

CREATE INDEX IF NOT EXISTS idx_tracked_items_state ON tracked_items(state);
CREATE INDEX IF NOT EXISTS idx_tracked_items_thread_id ON tracked_items(thread_id);

CREATE TABLE muted_threads (
  thread_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE snoozed_items (
  item_id TEXT PRIMARY KEY,
  snoozed_at INTEGER NOT NULL,
  wake_at INTEGER NOT NULL,
  original_state TEXT NOT NULL,
  original_queue TEXT,
  FOREIGN KEY (item_id) REFERENCES tracked_items(id) ON DELETE CASCADE
);
CREATE INDEX idx_snoozed_wake ON snoozed_items(wake_at);

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

**Important:** existing `src/db.ts` has other columns on `tracked_items` not shown in the test's minimal seed (e.g. the full schema is richer). The migration's `INSERT … SELECT` must copy every column that actually exists in prod. Before writing the final migration, run:

```
sqlite3 /Users/topcoder1/dev/nanoclaw/store/messages.db ".schema tracked_items"
```

and pad the `INSERT … SELECT` column list to match exactly. The test's minimal schema is just enough to exercise the migration logic.

- [ ] **Step 4: Register migration in `src/db.ts`**

Read `src/db.ts` to find the existing migrations array. Add an entry following the project's convention (usually a list of `{ id, sql }` objects or a switch on filenames). Example pattern:

```ts
// In src/db.ts — locate the migrations registry and append:
{
  id: '2026-04-19-ux-expansion',
  sql: fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-04-19-ux-expansion.sql'),
    'utf8',
  ),
}
```

If the repo uses a different migration mechanism (e.g. per-file globs in `migrations/`), follow that pattern exactly — grep `src/db.ts` for `migration` to confirm before writing.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/migrations-2026-04-19.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `npx vitest run 2>&1 | tail -20`
Expected: All previously passing tests still pass. If `tracked_items.ts` or any consumer references `subtype` / `sender_kind` already — they shouldn't — those files will need updating here; otherwise no regressions.

- [ ] **Step 7: Commit**

```bash
git add migrations/2026-04-19-ux-expansion.sql src/db.ts src/__tests__/migrations-2026-04-19.test.ts
git commit -m "feat(db): migration for mute/snooze/unsubscribe + sender heuristics

Add muted_threads, snoozed_items, unsubscribe_log tables. Add
sender_kind + subtype columns to tracked_items with CHECK. Extend
state CHECK to allow 'snoozed'. FK on snoozed_items cascades on
tracked_items delete.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 1"
```

---

## Phase 2 — Sender/subtype detection

### Task 2: Pure classification helpers

**Files:**
- Create: `src/triage/sender-kind.ts`
- Test: `src/triage/__tests__/sender-kind.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/triage/__tests__/sender-kind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifySender, classifySubtype } from '../sender-kind.js';

describe('classifySender', () => {
  it('returns bot when List-Unsubscribe header present', () => {
    expect(
      classifySender({
        from: 'someone@example.com',
        headers: { 'List-Unsubscribe': '<https://unsub>' },
      }),
    ).toBe('bot');
  });

  it('returns bot when List-Id present', () => {
    expect(
      classifySender({
        from: 'newsletter@mailchimp.com',
        headers: { 'List-Id': '<x.list>' },
      }),
    ).toBe('bot');
  });

  it('returns bot when Precedence: bulk', () => {
    expect(
      classifySender({
        from: 'notifications@x.com',
        headers: { Precedence: 'bulk' },
      }),
    ).toBe('bot');
  });

  it('returns bot when From local-part is a no-reply variant', () => {
    expect(classifySender({ from: 'no-reply@stripe.com', headers: {} })).toBe('bot');
    expect(classifySender({ from: 'noreply@apple.com', headers: {} })).toBe('bot');
    expect(classifySender({ from: 'do-not-reply@bank.com', headers: {} })).toBe('bot');
    expect(classifySender({ from: 'notifications@github.com', headers: {} })).toBe('bot');
  });

  it('returns bot when sender domain matches known ESP', () => {
    expect(classifySender({ from: 'x@mail.mailchimp.com', headers: {} })).toBe('bot');
    expect(classifySender({ from: 'bounce@amazonses.com', headers: {} })).toBe('bot');
  });

  it('returns human for an ordinary personal address with no bot signals', () => {
    expect(
      classifySender({ from: 'jane@personal.com', headers: {} }),
    ).toBe('human');
  });

  it('returns human when inconclusive (fail-open)', () => {
    expect(
      classifySender({ from: 'contact@somecompany.com', headers: {} }),
    ).toBe('human');
  });
});

describe('classifySubtype', () => {
  it('returns transactional for Stripe verification code', () => {
    expect(
      classifySubtype({
        from: 'noreply@stripe.com',
        gmailCategory: 'CATEGORY_UPDATES',
        subject: 'Your Stripe verification code',
        body: 'Your verification code is 123456',
      }),
    ).toBe('transactional');
  });

  it('returns transactional for Apple receipt', () => {
    expect(
      classifySubtype({
        from: 'no_reply@email.apple.com',
        gmailCategory: 'CATEGORY_UPDATES',
        subject: 'Your receipt from Apple',
        body: 'your receipt',
      }),
    ).toBe('transactional');
  });

  it('returns null for newsletter (promotional, not transactional)', () => {
    expect(
      classifySubtype({
        from: 'news@mailchimp.com',
        gmailCategory: 'CATEGORY_PROMOTIONS',
        subject: 'Weekly roundup',
        body: 'Our top stories this week',
      }),
    ).toBe(null);
  });

  it('returns null for human email', () => {
    expect(
      classifySubtype({
        from: 'jane@personal.com',
        gmailCategory: null,
        subject: 'Lunch tomorrow?',
        body: 'Want to grab lunch?',
      }),
    ).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage/__tests__/sender-kind.test.ts`
Expected: FAIL — `../sender-kind.js` not resolvable.

- [ ] **Step 3: Implement `sender-kind.ts`**

Create `src/triage/sender-kind.ts`:

```ts
export type SenderKind = 'human' | 'bot' | 'unknown';
export type Subtype = 'transactional' | null;

export interface SenderInput {
  from: string;
  headers: Record<string, string>;
}

export interface SubtypeInput {
  from: string;
  gmailCategory: string | null;
  subject: string;
  body: string;
}

const BOT_LOCALPART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|bounce|bounces|notification[s]?|notify|info|support|alert[s]?|team|mailer[-_]daemon|postmaster|hello|news(?:letter)?)$/i;

const BOT_DOMAINS = [
  /(^|\.)mailchimp\.com$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)amazonses\.com$/i,
  /(^|\.)mailgun\.org$/i,
  /(^|\.)postmark(?:app)?\.com$/i,
  /(^|\.)klaviyo\.com$/i,
  /(^|\.)hubspotemail\.net$/i,
];

export function classifySender(input: SenderInput): SenderKind {
  const headers = normalizeHeaders(input.headers);
  if (headers['list-unsubscribe']) return 'bot';
  if (headers['list-id']) return 'bot';
  if ((headers.precedence || '').toLowerCase() === 'bulk') return 'bot';

  const email = (input.from || '').toLowerCase();
  const at = email.indexOf('@');
  if (at === -1) return 'unknown';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (BOT_LOCALPART.test(local)) return 'bot';
  for (const re of BOT_DOMAINS) if (re.test(domain)) return 'bot';

  return 'human';
}

const TRANSACTIONAL_DOMAINS = [
  /(^|\.)stripe\.com$/i,
  /(^|\.)square(?:up)?\.com$/i,
  /(^|\.)apple\.com$/i,
  /(^|\.)amazon\.com$/i,
  /(^|\.)shopify\.com$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)intuit\.com$/i,
  /(^|\.)chase\.com$/i,
];

const TRANSACTIONAL_KEYWORDS = [
  /verification code/i,
  /one[- ]?time code/i,
  /\b2fa\b/i,
  /your receipt/i,
  /order confirmation/i,
  /payment received/i,
  /\btransaction\b/i,
  /\binvoice\b/i,
];

export function classifySubtype(input: SubtypeInput): Subtype {
  let signals = 0;
  const cat = input.gmailCategory || '';
  if (cat === 'CATEGORY_UPDATES') signals += 1;
  // Deliberately NOT counting CATEGORY_PROMOTIONS here — promotions are
  // marketing, not transactional. Newsletters hit that category too.

  const email = (input.from || '').toLowerCase();
  const at = email.indexOf('@');
  const domain = at === -1 ? '' : email.slice(at + 1);
  for (const re of TRANSACTIONAL_DOMAINS) {
    if (re.test(domain)) {
      signals += 1;
      break;
    }
  }

  const haystack = `${input.subject || ''}\n${input.body || ''}`;
  for (const re of TRANSACTIONAL_KEYWORDS) {
    if (re.test(haystack)) {
      signals += 1;
      break;
    }
  }

  return signals >= 2 ? 'transactional' : null;
}

function normalizeHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw || {})) out[k.toLowerCase()] = raw[k];
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/triage/__tests__/sender-kind.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/triage/sender-kind.ts src/triage/__tests__/sender-kind.test.ts
git commit -m "feat(triage): classifySender and classifySubtype helpers

Pure functions for classifying email sender (human/bot) and subtype
(transactional). Used by the SSE intake path to populate the new
tracked_items columns and by the mini-app template to select the
right button row.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 2"
```

---

## Phase 3 — Mute thread

### Task 3: Mute filter + cascade-resolve helper

**Files:**
- Create: `src/triage/mute-filter.ts`
- Test: `src/triage/__tests__/mute-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/triage/__tests__/mute-filter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { isThreadMuted, muteThread, unmuteThread } from '../mute-filter.js';

describe('mute-filter', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        muted_at INTEGER NOT NULL,
        reason TEXT
      );
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT,
        resolution_method TEXT, resolved_at INTEGER
      );
    `);
  });

  it('isThreadMuted returns false for unmuted thread', () => {
    expect(isThreadMuted(db, 'thread-abc')).toBe(false);
  });

  it('muteThread inserts a muted_threads row and cascade-resolves tracked_items', () => {
    db.prepare(
      'INSERT INTO tracked_items (id, thread_id, state) VALUES (?, ?, ?)',
    ).run('i1', 'thread-abc', 'pushed');
    db.prepare(
      'INSERT INTO tracked_items (id, thread_id, state) VALUES (?, ?, ?)',
    ).run('i2', 'thread-abc', 'queued');

    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });

    expect(isThreadMuted(db, 'thread-abc')).toBe(true);
    const rows = db
      .prepare('SELECT id, state, resolution_method FROM tracked_items')
      .all() as Array<{ id: string; state: string; resolution_method: string }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'i1', state: 'resolved', resolution_method: 'mute:retroactive' },
        { id: 'i2', state: 'resolved', resolution_method: 'mute:retroactive' },
      ]),
    );
  });

  it('muteThread is idempotent — second call on same thread is a no-op', () => {
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    const first = db
      .prepare('SELECT muted_at FROM muted_threads WHERE thread_id=?')
      .get('thread-abc') as { muted_at: number };
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    const second = db
      .prepare('SELECT muted_at FROM muted_threads WHERE thread_id=?')
      .get('thread-abc') as { muted_at: number };
    expect(second.muted_at).toBe(first.muted_at);
  });

  it('unmuteThread deletes the row and returns true if it existed', () => {
    muteThread(db, { threadId: 'thread-abc', account: 'alice@example.com' });
    expect(unmuteThread(db, 'thread-abc')).toBe(true);
    expect(isThreadMuted(db, 'thread-abc')).toBe(false);
  });

  it('unmuteThread returns false when no such row', () => {
    expect(unmuteThread(db, 'unknown')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage/__tests__/mute-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mute-filter.ts`**

Create `src/triage/mute-filter.ts`:

```ts
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

export interface MuteInput {
  threadId: string;
  account: string;
  reason?: string;
}

export function isThreadMuted(
  db: Database.Database,
  threadId: string,
): boolean {
  try {
    const row = db
      .prepare('SELECT 1 FROM muted_threads WHERE thread_id = ?')
      .get(threadId);
    return !!row;
  } catch (err) {
    // Fail open: a DB blip must not silently drop inbound email.
    logger.error(
      { err, threadId, component: 'mute-filter' },
      'isThreadMuted errored — allowing intake to proceed',
    );
    return false;
  }
}

export function muteThread(
  db: Database.Database,
  input: MuteInput,
): { muted: boolean; cascaded: number } {
  const now = Date.now();
  // Idempotent: INSERT OR IGNORE keeps the original muted_at intact.
  db.prepare(
    `INSERT OR IGNORE INTO muted_threads (thread_id, account, muted_at, reason)
     VALUES (?, ?, ?, ?)`,
  ).run(input.threadId, input.account, now, input.reason ?? null);

  const res = db
    .prepare(
      `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'mute:retroactive',
             resolved_at = ?
       WHERE thread_id = ? AND state != 'resolved'`,
    )
    .run(now, input.threadId);

  return { muted: true, cascaded: res.changes };
}

export function unmuteThread(
  db: Database.Database,
  threadId: string,
): boolean {
  const res = db
    .prepare('DELETE FROM muted_threads WHERE thread_id = ?')
    .run(threadId);
  return res.changes > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/triage/__tests__/mute-filter.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/triage/mute-filter.ts src/triage/__tests__/mute-filter.test.ts
git commit -m "feat(triage): mute-filter helpers — isThreadMuted, muteThread, unmuteThread

Pure helpers over muted_threads. muteThread cascade-resolves existing
tracked_items. isThreadMuted fails open on DB error to prevent a blip
from silently dropping inbound email.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 3"
```

### Task 4: Hook mute-filter into SSE intake

**Files:**
- Modify: `src/email-sse.ts` (locate the tracked_items INSERT path; add filter call before insert)

- [ ] **Step 1: Write the failing test**

Add to `src/triage/__tests__/mute-filter.test.ts`:

```ts
import { processIncomingEmail } from '../../email-sse.js';

describe('processIncomingEmail mute integration', () => {
  it('skips tracked_items insert and archives Gmail when thread is muted', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY, account TEXT NOT NULL,
        muted_at INTEGER NOT NULL, reason TEXT
      );
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT,
        resolution_method TEXT, resolved_at INTEGER
      );
      INSERT INTO muted_threads (thread_id, account, muted_at)
      VALUES ('muted-thread', 'alice@example.com', 1000);
    `);
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const gmailOps = { archiveThread } as any;

    const result = await processIncomingEmail({
      db,
      gmailOps,
      event: {
        threadId: 'muted-thread',
        account: 'alice@example.com',
        messageId: 'msg-1',
        subject: 'anything',
        from: 'x@y',
        headers: {},
        body: '',
      },
    });

    expect(result.action).toBe('muted_skip');
    expect(archiveThread).toHaveBeenCalledWith('alice@example.com', 'muted-thread');
    const count = db.prepare('SELECT COUNT(*) AS n FROM tracked_items').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage/__tests__/mute-filter.test.ts`
Expected: FAIL — `processIncomingEmail` missing or doesn't support `muted_skip` path.

- [ ] **Step 3: Modify `src/email-sse.ts` to wire the filter**

First read `src/email-sse.ts` to find the existing tracked_items INSERT point. The hook should fire before any INSERT happens:

```ts
// At the top:
import { isThreadMuted } from './triage/mute-filter.js';
import { classifySender, classifySubtype } from './triage/sender-kind.js';

// Inside the event-handling function (name may vary — grep for 'tracked_items'
// INSERT or 'Email trigger written'). Insert the mute check as the first
// action after the threadId is known:
if (isThreadMuted(opts.db, event.threadId)) {
  logger.info(
    { thread_id: event.threadId, component: 'triage', event: 'muted_skip' },
    'Muted thread — skipping intake',
  );
  try {
    await opts.gmailOps.archiveThread(event.account, event.threadId);
  } catch (err) {
    logger.error(
      { err, thread_id: event.threadId, component: 'triage' },
      'Muted thread archive failed — left in inbox',
    );
  }
  return { action: 'muted_skip' };
}

// Then, when inserting tracked_items, add sender_kind + subtype columns:
const sender_kind = classifySender({ from: event.from, headers: event.headers });
const subtype = classifySubtype({
  from: event.from,
  gmailCategory: event.gmailCategory ?? null,
  subject: event.subject,
  body: event.body,
});

// Extend the existing INSERT with these two columns.
```

If `src/email-sse.ts` doesn't already export a testable `processIncomingEmail` function, refactor the SSE handler to call it. This is a judgment call — if the existing structure is opaque, create a thin wrapper and test that. Do not rewrite the SSE plumbing for testability reasons — wrap it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/triage/__tests__/mute-filter.test.ts`
Expected: All mute-filter tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run 2>&1 | tail -10`
Expected: No regressions. Pay attention to any existing `email-sse.test.ts` — it may need a minor update to include the new columns in its schema.

- [ ] **Step 6: Commit**

```bash
git add src/email-sse.ts src/triage/__tests__/mute-filter.test.ts
git commit -m "feat(triage): wire mute-filter + sender/subtype into SSE intake

Before writing a new tracked_items row, check muted_threads. If
matched, skip the insert, archive the thread in Gmail, log, return.
Also populate sender_kind + subtype columns on insert for classification-
aware rendering downstream.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 3"
```

### Task 5: Mute route handlers

**Files:**
- Create: `src/mini-app/actions.ts`
- Modify: `src/mini-app/server.ts` (mount the actions router)
- Test: `src/__tests__/mini-app-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mini-app-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createMiniAppServer } from '../mini-app/server.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracked_items (
      id TEXT PRIMARY KEY, source TEXT, state TEXT, queue TEXT,
      classification TEXT, subtype TEXT, sender_kind TEXT,
      title TEXT, thread_id TEXT, detected_at INTEGER,
      resolved_at INTEGER, resolution_method TEXT, metadata TEXT
    );
    CREATE TABLE muted_threads (
      thread_id TEXT PRIMARY KEY, account TEXT NOT NULL,
      muted_at INTEGER NOT NULL, reason TEXT
    );
    CREATE TABLE snoozed_items (
      item_id TEXT PRIMARY KEY, snoozed_at INTEGER NOT NULL,
      wake_at INTEGER NOT NULL, original_state TEXT NOT NULL,
      original_queue TEXT
    );
    CREATE TABLE unsubscribe_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL,
      method TEXT NOT NULL, url TEXT, status INTEGER, error TEXT,
      attempted_at INTEGER NOT NULL
    );
    CREATE TABLE draft_originals (
      draft_id TEXT PRIMARY KEY, account TEXT,
      original_body TEXT, enriched_at TEXT, expires_at TEXT
    );
  `);
  return db;
}

function seedItem(
  db: Database.Database,
  id: string,
  threadId: string,
  account: string,
) {
  db.prepare(
    `INSERT INTO tracked_items (id, source, state, queue, classification,
      thread_id, detected_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'gmail',
    'pushed',
    'attention',
    'digest',
    threadId,
    Date.now(),
    JSON.stringify({ account }),
  );
}

describe('mini-app actions — mute', () => {
  let db: Database.Database;
  let gmailOps: any;

  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn(),
      getMessageMeta: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getDraftReplyContext: vi.fn(),
      sendDraft: vi.fn(),
      sendEmail: vi.fn(),
    };
  });

  it('POST /api/email/:id/mute inserts row, cascade-resolves, archives', async () => {
    seedItem(db, 'item-1', 'thread-xyz', 'alice@example.com');
    seedItem(db, 'item-2', 'thread-xyz', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });

    const res = await request(app).post('/api/email/item-1/mute').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const muted = db
      .prepare('SELECT account FROM muted_threads WHERE thread_id=?')
      .get('thread-xyz') as { account: string };
    expect(muted.account).toBe('alice@example.com');
    expect(gmailOps.archiveThread).toHaveBeenCalledWith(
      'alice@example.com',
      'thread-xyz',
    );
    const resolved = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tracked_items WHERE thread_id=? AND state='resolved'",
      )
      .get('thread-xyz') as { n: number };
    expect(resolved.n).toBe(2);
  });

  it('POST /api/email/:id/mute returns 404 when item missing', async () => {
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).post('/api/email/does-not-exist/mute');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: expect.any(String),
      code: 'ITEM_NOT_FOUND',
    });
  });

  it('DELETE /api/email/:id/mute removes row', async () => {
    seedItem(db, 'item-1', 'thread-xyz', 'alice@example.com');
    db.prepare(
      `INSERT INTO muted_threads (thread_id, account, muted_at) VALUES (?, ?, ?)`,
    ).run('thread-xyz', 'alice@example.com', Date.now());

    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).delete('/api/email/item-1/mute');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM muted_threads')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts`
Expected: FAIL — routes not mounted.

- [ ] **Step 3: Create `src/mini-app/actions.ts`**

```ts
import express from 'express';
import type Database from 'better-sqlite3';
import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';
import { muteThread, unmuteThread } from '../triage/mute-filter.js';

export interface ActionDeps {
  db: Database.Database;
  gmailOps?: GmailOps;
}

export function createActionsRouter(deps: ActionDeps): express.Router {
  const router = express.Router();

  function lookupItem(id: string):
    | { id: string; thread_id: string | null; account: string | null }
    | null {
    const row = deps.db
      .prepare(
        'SELECT id, thread_id, metadata FROM tracked_items WHERE id = ?',
      )
      .get(id) as
      | { id: string; thread_id: string | null; metadata: string | null }
      | undefined;
    if (!row) return null;
    let account: string | null = null;
    if (row.metadata) {
      try {
        account = (JSON.parse(row.metadata) as { account?: string }).account ?? null;
      } catch {
        logger.debug(
          { id, component: 'mini-app-actions' },
          'metadata JSON.parse failed',
        );
      }
    }
    return { id: row.id, thread_id: row.thread_id, account };
  }

  router.post('/api/email/:id/mute', async (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id || !item.account) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found or missing thread/account',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    muteThread(deps.db, {
      threadId: item.thread_id,
      account: item.account,
    });
    if (deps.gmailOps) {
      try {
        await deps.gmailOps.archiveThread(item.account, item.thread_id);
      } catch (err) {
        logger.error(
          { err, id: req.params.id, component: 'mini-app-actions' },
          'Mute archive failed',
        );
      }
    }
    res.json({ ok: true });
  });

  router.delete('/api/email/:id/mute', (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    unmuteThread(deps.db, item.thread_id);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Mount router in `src/mini-app/server.ts`**

Near the top:

```ts
import { createActionsRouter } from './actions.js';
```

In `createMiniAppServer`, after `app.use(express.json())`:

```ts
app.use(createActionsRouter({ db: opts.db, gmailOps: opts.gmailOps }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mini-app/actions.ts src/mini-app/server.ts src/__tests__/mini-app-actions.test.ts
git commit -m "feat(mini-app): mute / unmute routes

POST /api/email/:id/mute inserts muted_threads row, cascade-resolves
all open tracked_items in the thread, archives on Gmail. DELETE
removes the mute.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 3"
```

### Task 6: Muted-threads-never-visible invariant

**Files:**
- Modify: `scripts/qa/invariants.ts` (add new predicate)
- Test: `src/__tests__/invariants-runtime-proof.test.ts` (extend)

- [ ] **Step 1: Find the invariant registration spot**

Read `scripts/qa/invariants.ts` and `scripts/qa/invariant-predicates.ts`. Note how existing predicates register.

- [ ] **Step 2: Write the failing test**

Add to `src/__tests__/invariants-runtime-proof.test.ts` (file already exists with this structure):

```ts
describe('muted-threads-never-visible', () => {
  it('muted thread_id with non-resolved tracked_item is flagged', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT
      );
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY, account TEXT, muted_at INTEGER
      );
      INSERT INTO tracked_items (id, thread_id, state)
        VALUES ('bad', 'T1', 'pushed');
      INSERT INTO muted_threads (thread_id, account, muted_at)
        VALUES ('T1', 'x', 1000);
    `);
    // Import the predicate from invariants-predicates.ts
    // Predicate name: mutedThreadsNeverVisible (or the name you choose)
    const { mutedThreadsNeverVisible } = require('../../scripts/qa/invariant-predicates.js');
    const result = mutedThreadsNeverVisible(db);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].id).toBe('bad');
  });

  it('passes when all muted-thread tracked_items are resolved', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT
      );
      CREATE TABLE muted_threads (
        thread_id TEXT PRIMARY KEY, account TEXT, muted_at INTEGER
      );
      INSERT INTO tracked_items (id, thread_id, state)
        VALUES ('ok', 'T1', 'resolved');
      INSERT INTO muted_threads (thread_id, account, muted_at)
        VALUES ('T1', 'x', 1000);
    `);
    const { mutedThreadsNeverVisible } = require('../../scripts/qa/invariant-predicates.js');
    expect(mutedThreadsNeverVisible(db).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/invariants-runtime-proof.test.ts -t muted-threads-never-visible`
Expected: FAIL — predicate not exported.

- [ ] **Step 4: Add the predicate**

In `scripts/qa/invariant-predicates.ts` — add:

```ts
export function mutedThreadsNeverVisible(
  db: Database.Database,
): { ok: boolean; violations: Array<{ id: string; thread_id: string }> } {
  const rows = db
    .prepare(
      `SELECT ti.id, ti.thread_id
         FROM tracked_items ti
         JOIN muted_threads m ON m.thread_id = ti.thread_id
        WHERE ti.state != 'resolved'`,
    )
    .all() as Array<{ id: string; thread_id: string }>;
  return { ok: rows.length === 0, violations: rows };
}
```

In `scripts/qa/invariants.ts` — register it alongside other invariants. Read the file to confirm the exact registration pattern.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/invariants-runtime-proof.test.ts -t muted-threads-never-visible`
Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/qa/invariants.ts scripts/qa/invariant-predicates.ts src/__tests__/invariants-runtime-proof.test.ts
git commit -m "test(qa): add muted-threads-never-visible invariant

Asserts no tracked_items row is both unresolved and in a muted thread.
Runs in the QA invariants suite alongside the existing predicates.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 3"
```

---

## Phase 4 — Snooze

### Task 7: Snooze scheduler

**Files:**
- Create: `src/triage/snooze-scheduler.ts`
- Test: `src/triage/__tests__/snooze-scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/triage/__tests__/snooze-scheduler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { startSnoozeScheduler } from '../snooze-scheduler.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracked_items (
      id TEXT PRIMARY KEY, state TEXT, queue TEXT, title TEXT
    );
    CREATE TABLE snoozed_items (
      item_id TEXT PRIMARY KEY, snoozed_at INTEGER NOT NULL,
      wake_at INTEGER NOT NULL, original_state TEXT NOT NULL,
      original_queue TEXT
    );
  `);
  return db;
}

describe('snooze-scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tick restores state + emits event when wake_at has passed', async () => {
    const db = freshDb();
    const bus = new EventEmitter();
    const emitted: any[] = [];
    bus.on('email.snooze.waked', (e) => emitted.push(e));

    db.prepare(
      "INSERT INTO tracked_items (id, state, queue, title) VALUES (?,?,?,?)",
    ).run('i1', 'snoozed', null, 'Payroll');
    const past = Date.now() - 1000;
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
       VALUES (?,?,?,?,?)`,
    ).run('i1', past - 1000, past, 'pushed', 'attention');

    const stop = startSnoozeScheduler({ db, eventBus: bus as any, intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(60_000);

    const item = db.prepare('SELECT state, queue FROM tracked_items WHERE id=?').get('i1') as
      | { state: string; queue: string | null }
      | undefined;
    expect(item).toEqual({ state: 'pushed', queue: 'attention' });
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM snoozed_items').get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ itemId: 'i1', subject: 'Payroll' });

    stop();
  });

  it('future wake_at is skipped', async () => {
    const db = freshDb();
    const bus = new EventEmitter();
    db.prepare(
      "INSERT INTO tracked_items (id, state) VALUES (?,?)",
    ).run('i1', 'snoozed');
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state)
       VALUES (?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 3600_000, 'pushed');

    const stop = startSnoozeScheduler({ db, eventBus: bus as any, intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(60_000);

    const item = db.prepare('SELECT state FROM tracked_items WHERE id=?').get('i1') as { state: string };
    expect(item.state).toBe('snoozed');
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM snoozed_items').get() as { n: number };
    expect(remaining.n).toBe(1);

    stop();
  });

  it('stop() halts further ticks', async () => {
    const db = freshDb();
    const bus = new EventEmitter();
    const emitted: any[] = [];
    bus.on('email.snooze.waked', (e) => emitted.push(e));
    db.prepare("INSERT INTO tracked_items (id, state) VALUES (?,?)").run('i1', 'snoozed');
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state) VALUES (?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 30_000, 'pushed');

    const stop = startSnoozeScheduler({ db, eventBus: bus as any, intervalMs: 60000 });
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emitted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage/__tests__/snooze-scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `snooze-scheduler.ts`**

```ts
import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import { logger } from '../logger.js';

export interface SnoozeSchedulerOpts {
  db: Database.Database;
  eventBus: EventBus;
  intervalMs?: number;
}

export function startSnoozeScheduler(opts: SnoozeSchedulerOpts): () => void {
  const interval = opts.intervalMs ?? 60_000;

  function tick(): void {
    const now = Date.now();
    const ready = opts.db
      .prepare(
        `SELECT s.item_id, s.original_state, s.original_queue, ti.title
           FROM snoozed_items s
           LEFT JOIN tracked_items ti ON ti.id = s.item_id
          WHERE s.wake_at <= ?`,
      )
      .all(now) as Array<{
      item_id: string;
      original_state: string;
      original_queue: string | null;
      title: string | null;
    }>;

    for (const row of ready) {
      try {
        const restore = opts.db.prepare(
          `UPDATE tracked_items SET state = ?, queue = ? WHERE id = ?`,
        );
        const remove = opts.db.prepare(
          `DELETE FROM snoozed_items WHERE item_id = ?`,
        );
        opts.db.transaction(() => {
          restore.run(row.original_state, row.original_queue, row.item_id);
          remove.run(row.item_id);
        })();
        opts.eventBus.emit('email.snooze.waked', {
          type: 'email.snooze.waked',
          source: 'snooze-scheduler',
          timestamp: now,
          payload: {
            itemId: row.item_id,
            subject: row.title ?? '(no subject)',
          },
        });
        logger.info(
          { itemId: row.item_id, component: 'snooze-scheduler' },
          'Snooze waked',
        );
      } catch (err) {
        logger.error(
          { err, itemId: row.item_id, component: 'snooze-scheduler' },
          'Snooze wake failed',
        );
      }
    }
  }

  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/triage/__tests__/snooze-scheduler.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Start the scheduler in `src/index.ts`**

Near the existing `startGmailReconciler` call:

```ts
import { startSnoozeScheduler } from './triage/snooze-scheduler.js';

const stopSnooze = startSnoozeScheduler({ db: getDb(), eventBus });
logger.info('Snooze scheduler started');

// ...during shutdown (SIGTERM/SIGINT handler):
stopSnooze();
```

- [ ] **Step 6: Add a push-manager subscriber for `email.snooze.waked`**

In `src/index.ts` near the existing `eventBus.on('email.draft.enriched', ...)` block, add:

```ts
eventBus.on('email.snooze.waked', (event) => {
  if (!mainGroupEntry) return;
  const [mainJid] = mainGroupEntry;
  const channel = findChannel(channels, mainJid);
  const text = `⏰ Reminder: ${event.payload.subject}`;
  channel?.sendText(mainJid, text).catch((err) =>
    logger.error({ err }, 'Failed to post snooze wake notification'),
  );
});
```

- [ ] **Step 7: Commit**

```bash
git add src/triage/snooze-scheduler.ts src/triage/__tests__/snooze-scheduler.test.ts src/index.ts
git commit -m "feat(triage): snooze scheduler + Telegram wake notification

60s tick wakes snoozed items whose wake_at has passed: restores
tracked_items.state/queue, deletes snooze row, emits
email.snooze.waked. A push subscriber posts a Telegram reminder.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 4"
```

### Task 8: Snooze action routes

**Files:**
- Modify: `src/mini-app/actions.ts` (add snooze/unsnooze)
- Modify: `src/__tests__/mini-app-actions.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/mini-app-actions.test.ts`:

```ts
describe('mini-app actions — snooze', () => {
  let db: Database.Database;
  let gmailOps: any;
  beforeEach(() => {
    db = freshDb();
    gmailOps = { archiveThread: vi.fn() };
  });

  it('POST /api/email/:id/snooze with preset duration writes row and updates state', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const now = Date.now();

    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: '1h' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wake_at).toBeGreaterThanOrEqual(now + 3600_000 - 5000);
    expect(res.body.wake_at).toBeLessThanOrEqual(now + 3600_000 + 5000);

    const snooze = db
      .prepare('SELECT wake_at, original_state, original_queue FROM snoozed_items WHERE item_id=?')
      .get('i1') as { wake_at: number; original_state: string; original_queue: string };
    expect(snooze.original_state).toBe('pushed');
    expect(snooze.original_queue).toBe('attention');

    const item = db.prepare('SELECT state FROM tracked_items WHERE id=?').get('i1') as { state: string };
    expect(item.state).toBe('snoozed');
  });

  it('POST /api/email/:id/snooze with custom wake_at', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const wakeAt = Date.now() + 4 * 3600_000;

    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: 'custom', wake_at: new Date(wakeAt).toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.wake_at).toBe(wakeAt);
  });

  it('POST /api/email/:id/snooze with invalid duration → 400', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({ duration: 'six-years' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  it('POST /api/email/:id/snooze caps at 90 days', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/snooze')
      .send({
        duration: 'custom',
        wake_at: new Date(Date.now() + 100 * 86400_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  it('DELETE /api/email/:id/snooze restores state', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET state=? WHERE id=?').run('snoozed', 'i1');
    db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
       VALUES (?,?,?,?,?)`,
    ).run('i1', Date.now(), Date.now() + 3600_000, 'pushed', 'attention');
    const app = createMiniAppServer({ port: 0, db, gmailOps });

    const res = await request(app).delete('/api/email/i1/snooze');
    expect(res.status).toBe(200);
    const item = db.prepare('SELECT state, queue FROM tracked_items WHERE id=?').get('i1') as {
      state: string;
      queue: string;
    };
    expect(item.state).toBe('pushed');
    expect(item.queue).toBe('attention');
    const count = db.prepare('SELECT COUNT(*) AS n FROM snoozed_items').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts`
Expected: FAIL on snooze tests.

- [ ] **Step 3: Add duration-to-wake_at helper**

Append to `src/mini-app/actions.ts`:

```ts
const MAX_SNOOZE_MS = 90 * 86400_000;

function resolveWakeAt(
  duration: string,
  customIso: string | undefined,
): { ok: true; wake_at: number } | { ok: false; reason: string } {
  const now = Date.now();
  switch (duration) {
    case '1h':
      return { ok: true, wake_at: now + 3600_000 };
    case 'tomorrow-8am': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'next-monday-8am': {
      const d = new Date(now);
      const daysUntilMonday = ((1 - d.getDay() + 7) % 7) || 7;
      d.setDate(d.getDate() + daysUntilMonday);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'next-week': {
      const d = new Date(now);
      d.setDate(d.getDate() + 7);
      d.setHours(8, 0, 0, 0);
      return { ok: true, wake_at: d.getTime() };
    }
    case 'custom': {
      if (!customIso) return { ok: false, reason: 'custom requires wake_at' };
      const t = Date.parse(customIso);
      if (Number.isNaN(t))
        return { ok: false, reason: 'invalid wake_at ISO string' };
      if (t <= now) return { ok: false, reason: 'wake_at must be in the future' };
      if (t > now + MAX_SNOOZE_MS)
        return { ok: false, reason: 'wake_at exceeds 90-day cap' };
      return { ok: true, wake_at: t };
    }
    default:
      return { ok: false, reason: `unknown duration: ${duration}` };
  }
}
```

- [ ] **Step 4: Add snooze routes**

Inside `createActionsRouter`:

```ts
router.post('/api/email/:id/snooze', (req, res) => {
  const item = lookupItem(req.params.id);
  if (!item) {
    res.status(404).json({
      ok: false,
      error: 'Tracked item not found',
      code: 'ITEM_NOT_FOUND',
    });
    return;
  }
  const body = req.body as { duration?: string; wake_at?: string };
  const parsed = resolveWakeAt(body.duration ?? '', body.wake_at);
  if (!parsed.ok) {
    res.status(400).json({
      ok: false,
      error: parsed.reason,
      code: 'INVALID_DURATION',
    });
    return;
  }

  const existing = deps.db
    .prepare(
      'SELECT state, queue FROM tracked_items WHERE id = ?',
    )
    .get(item.id) as { state: string; queue: string | null };

  const tx = deps.db.transaction(() => {
    deps.db.prepare(
      `INSERT INTO snoozed_items (item_id, snoozed_at, wake_at, original_state, original_queue)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         snoozed_at = excluded.snoozed_at,
         wake_at = excluded.wake_at,
         original_state = excluded.original_state,
         original_queue = excluded.original_queue`,
    ).run(item.id, Date.now(), parsed.wake_at, existing.state, existing.queue);
    deps.db.prepare(
      `UPDATE tracked_items SET state = 'snoozed' WHERE id = ?`,
    ).run(item.id);
  });
  tx();

  res.json({ ok: true, wake_at: parsed.wake_at });
});

router.delete('/api/email/:id/snooze', (req, res) => {
  const item = lookupItem(req.params.id);
  if (!item) {
    res.status(404).json({
      ok: false,
      error: 'Tracked item not found',
      code: 'ITEM_NOT_FOUND',
    });
    return;
  }
  const snooze = deps.db
    .prepare(
      `SELECT original_state, original_queue FROM snoozed_items WHERE item_id = ?`,
    )
    .get(item.id) as
    | { original_state: string; original_queue: string | null }
    | undefined;
  if (!snooze) {
    res.json({ ok: true });  // idempotent
    return;
  }
  const tx = deps.db.transaction(() => {
    deps.db.prepare(
      `UPDATE tracked_items SET state = ?, queue = ? WHERE id = ?`,
    ).run(snooze.original_state, snooze.original_queue, item.id);
    deps.db.prepare(`DELETE FROM snoozed_items WHERE item_id = ?`).run(item.id);
  });
  tx();
  res.json({ ok: true });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts`
Expected: all mute + snooze tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mini-app/actions.ts src/__tests__/mini-app-actions.test.ts
git commit -m "feat(mini-app): snooze / unsnooze routes with preset + custom durations

POST /api/email/:id/snooze accepts '1h' | 'tomorrow-8am' |
'next-monday-8am' | 'next-week' | 'custom' (with ISO wake_at).
Caps at 90 days. Wraps in a transaction so state/queue backup and
tracked_items state change are atomic. DELETE is idempotent.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 4"
```

---

## Phase 5 — Unsubscribe

### Task 9: Add `sendEmail` to GmailOps

**Files:**
- Modify: `src/gmail-ops.ts`
- Modify: `src/channels/gmail.ts`
- Test: `src/channels/gmail.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/channels/gmail.test.ts`:

```ts
describe('GmailChannel.sendEmail', () => {
  it('calls gmail.users.messages.send with base64url-encoded MIME', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent-1' } });
    const channel = makeChannelWithSendMock(send);  // existing harness; adapt

    await channel.sendEmail({
      to: 'unsub@example.com',
      subject: 'unsubscribe',
      body: '',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.userId).toBe('me');
    expect(typeof payload.requestBody.raw).toBe('string');
    // decode to verify header
    const decoded = Buffer.from(payload.requestBody.raw, 'base64url').toString('utf-8');
    expect(decoded).toMatch(/To: unsub@example.com/);
    expect(decoded).toMatch(/Subject: unsubscribe/);
  });
});
```

Note: adapt `makeChannelWithSendMock` to the existing test harness pattern in `gmail.test.ts`. Read that file first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/gmail.test.ts -t sendEmail`
Expected: FAIL — `sendEmail` method missing.

- [ ] **Step 3: Extend `GmailOps` + `GmailOpsProvider` interfaces**

In `src/gmail-ops.ts`:

```ts
export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

export interface GmailOps {
  // ...existing methods
  sendEmail(account: string, input: SendEmailInput): Promise<void>;
}

export interface GmailOpsProvider {
  // ...existing methods
  sendEmail(input: SendEmailInput): Promise<void>;
}
```

In `GmailOpsRouter`:

```ts
async sendEmail(account: string, input: SendEmailInput): Promise<void> {
  return this.getChannel(account).sendEmail(input);
}
```

- [ ] **Step 4: Implement `sendEmail` in `src/channels/gmail.ts`**

```ts
async sendEmail(input: SendEmailInput): Promise<void> {
  const headers: string[] = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + (input.body ?? ''),
    'utf-8',
  ).toString('base64url');

  await this.gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/channels/gmail.test.ts -t sendEmail`
Expected: PASS.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run 2>&1 | tail -10`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/gmail-ops.ts src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): sendEmail on GmailOps + GmailOpsProvider

Used by the unsubscribe executor for mailto: paths. Constructs a
minimal RFC 2822 message, base64url-encodes, sends via
gmail.users.messages.send.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 5"
```

### Task 10: Unsubscribe executor

**Files:**
- Create: `src/triage/unsubscribe-executor.ts`
- Test: `src/triage/__tests__/unsubscribe-executor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { pickUnsubscribeMethod, executeUnsubscribe } from '../unsubscribe-executor.js';

describe('pickUnsubscribeMethod', () => {
  it('picks one-click when List-Unsubscribe-Post present', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<https://news.example.com/unsub/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(m).toEqual({ kind: 'one-click', url: 'https://news.example.com/unsub/abc' });
  });

  it('picks mailto when only mailto: URI present', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<mailto:unsub@example.com>',
    });
    expect(m).toEqual({ kind: 'mailto', to: 'unsub@example.com' });
  });

  it('picks legacy-get for plain HTTPS URL', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<https://x.com/unsub>',
    });
    expect(m).toEqual({ kind: 'legacy-get', url: 'https://x.com/unsub' });
  });

  it('handles comma-separated list: prefers HTTPS one-click', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe':
        '<mailto:u@x.com>, <https://news.example.com/unsub/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(m).toEqual({ kind: 'one-click', url: 'https://news.example.com/unsub/abc' });
  });

  it('rejects javascript: and data: schemes', () => {
    expect(pickUnsubscribeMethod({ 'List-Unsubscribe': '<javascript:alert(1)>' })).toEqual({
      kind: 'none',
    });
    expect(pickUnsubscribeMethod({ 'List-Unsubscribe': '<data:text/html,foo>' })).toEqual({
      kind: 'none',
    });
  });

  it('returns none when no header', () => {
    expect(pickUnsubscribeMethod({})).toEqual({ kind: 'none' });
  });
});

describe('executeUnsubscribe', () => {
  it('one-click path POSTs empty body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as any);
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'one-click', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(res.status).toBe(200);
  });

  it('mailto path calls gmailOps.sendEmail', async () => {
    const gmailOps = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    const res = await executeUnsubscribe({
      method: { kind: 'mailto', to: 'unsub@x.com' },
      account: 'a@x.com',
      fetch: vi.fn(),
      gmailOps: gmailOps as any,
    });
    expect(gmailOps.sendEmail).toHaveBeenCalledWith('a@x.com', {
      to: 'unsub@x.com',
      subject: 'unsubscribe',
      body: '',
    });
    expect(res.status).toBe(200);
  });

  it('legacy-get path GETs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as any);
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'legacy-get', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.com/unsub',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(res.status).toBe(200);
  });

  it('timeout → status 0, error set', async () => {
    const fetchMock = vi.fn((_u, opts) =>
      new Promise((_resolve, reject) => {
        // simulate AbortController triggering
        opts.signal.addEventListener('abort', () =>
          reject(new Error('AbortError')),
        );
      }),
    );
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'one-click', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
      timeoutMs: 10,  // force fast timeout
    });
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/abort|timeout/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage/__tests__/unsubscribe-executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `unsubscribe-executor.ts`**

```ts
import type { GmailOps } from '../gmail-ops.js';

export type UnsubscribeMethod =
  | { kind: 'one-click'; url: string }
  | { kind: 'mailto'; to: string }
  | { kind: 'legacy-get'; url: string }
  | { kind: 'none' };

export interface UnsubscribeResult {
  method: UnsubscribeMethod['kind'];
  status: number;  // 0 on network error
  url?: string;
  error?: string;
}

const URI_PATTERN = /<([^>]+)>/g;

export function pickUnsubscribeMethod(
  headers: Record<string, string>,
): UnsubscribeMethod {
  const norm: Record<string, string> = {};
  for (const k of Object.keys(headers)) norm[k.toLowerCase()] = headers[k];
  const list = norm['list-unsubscribe'];
  if (!list) return { kind: 'none' };

  const oneClick = (norm['list-unsubscribe-post'] || '')
    .toLowerCase()
    .includes('one-click');

  const uris: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = URI_PATTERN.exec(list)) !== null) uris.push(m[1].trim());

  const https = uris.find((u) => u.startsWith('https://'));
  const mailto = uris.find((u) => u.startsWith('mailto:'));

  if (https && oneClick) return { kind: 'one-click', url: https };
  if (mailto) return { kind: 'mailto', to: mailto.slice('mailto:'.length) };
  if (https) return { kind: 'legacy-get', url: https };
  return { kind: 'none' };
}

export interface ExecuteDeps {
  method: UnsubscribeMethod;
  account: string;
  fetch: typeof globalThis.fetch;
  gmailOps: Pick<GmailOps, 'sendEmail'>;
  timeoutMs?: number;
}

export async function executeUnsubscribe(
  deps: ExecuteDeps,
): Promise<UnsubscribeResult> {
  const { method, account, fetch, gmailOps, timeoutMs = 5000 } = deps;

  switch (method.kind) {
    case 'one-click':
    case 'legacy-get': {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(method.url, {
          method: method.kind === 'one-click' ? 'POST' : 'GET',
          body: method.kind === 'one-click' ? '' : undefined,
          redirect: 'follow',
          signal: ctrl.signal,
        });
        return {
          method: method.kind,
          status: resp.status,
          url: method.url,
        };
      } catch (err) {
        return {
          method: method.kind,
          status: 0,
          url: method.url,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(t);
      }
    }
    case 'mailto':
      try {
        await gmailOps.sendEmail(account, {
          to: method.to,
          subject: 'unsubscribe',
          body: '',
        });
        return { method: 'mailto', status: 200 };
      } catch (err) {
        return {
          method: 'mailto',
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    case 'none':
      return { method: 'none', status: 0, error: 'no method' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/triage/__tests__/unsubscribe-executor.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/triage/unsubscribe-executor.ts src/triage/__tests__/unsubscribe-executor.test.ts
git commit -m "feat(triage): unsubscribe-executor — method picker + HTTP/mailto exec

pickUnsubscribeMethod inspects List-Unsubscribe / List-Unsubscribe-Post
headers and returns the best available method, rejecting javascript:
and data: schemes. executeUnsubscribe does the HTTP POST/GET or
delegates mailto sends to gmailOps.sendEmail. 5s timeout on network
calls.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 5"
```

### Task 11: Unsubscribe action route

**Files:**
- Modify: `src/mini-app/actions.ts` (add unsubscribe route)
- Modify: `src/__tests__/mini-app-actions.test.ts` (extend)

Requires that tracked_items have email headers accessible. Check how `src/mini-app/server.ts` currently fetches headers for the `/email/:id` rendering path — reuse that.

- [ ] **Step 1: Write the failing test**

```ts
describe('mini-app actions — unsubscribe', () => {
  let db: Database.Database;
  let gmailOps: any;
  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      sendEmail: vi.fn().mockResolvedValue(undefined),
      getMessageMeta: vi.fn().mockResolvedValue({
        subject: 'test',
        from: 'a',
        to: 'b',
        date: '',
        body: '',
        headers: {
          'List-Unsubscribe': '<https://news.example.com/unsub>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    };
  });

  it('POST /api/email/:id/unsubscribe one-click path', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET source_id=? WHERE id=?').run(
      'gmail:thread-1',
      'i1',
    );
    // supply a fetch double via the server's DI
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    const app = createMiniAppServer({ port: 0, db, gmailOps, fetchImpl: fetchMock as any });

    const res = await request(app).post('/api/email/i1/unsubscribe');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.method).toBe('one-click');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://news.example.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
    // archived too
    expect(gmailOps.archiveThread).toHaveBeenCalledWith(
      'alice@example.com',
      'thread-1',
    );
    // log row written
    const log = db
      .prepare('SELECT method, status FROM unsubscribe_log WHERE item_id=?')
      .get('i1') as { method: string; status: number };
    expect(log).toEqual({ method: 'one-click', status: 200 });
  });

  it('POST /api/email/:id/unsubscribe returns NO_UNSUBSCRIBE_HEADER when absent', async () => {
    gmailOps.getMessageMeta = vi.fn().mockResolvedValue({
      subject: '', from: '', to: '', date: '', body: '', headers: {},
    });
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app).post('/api/email/i1/unsubscribe');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_UNSUBSCRIBE_HEADER');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — route and `fetchImpl` DI don't exist.

- [ ] **Step 3: Add `fetchImpl` to MiniAppServerOpts**

In `src/mini-app/server.ts` `MiniAppServerOpts` type add:

```ts
fetchImpl?: typeof globalThis.fetch;
```

And pass through to `createActionsRouter({..., fetchImpl: opts.fetchImpl ?? fetch})`. Update `ActionDeps` to include `fetchImpl`.

- [ ] **Step 4: Implement the unsubscribe route**

In `src/mini-app/actions.ts` (requires the `getMessageMeta` now returns headers — confirm and possibly extend `EmailMeta.headers?: Record<string,string>` in `gmail-ops.ts`):

```ts
import { pickUnsubscribeMethod, executeUnsubscribe } from '../triage/unsubscribe-executor.js';

// Inside createActionsRouter, after snooze routes:
router.post('/api/email/:id/unsubscribe', async (req, res) => {
  const item = lookupItem(req.params.id);
  if (!item || !item.thread_id || !item.account) {
    res.status(404).json({
      ok: false, error: 'Tracked item not found', code: 'ITEM_NOT_FOUND',
    });
    return;
  }
  if (!deps.gmailOps) {
    res.status(503).json({
      ok: false, error: 'Gmail not configured', code: 'GMAIL_UNAVAILABLE',
    });
    return;
  }

  // Resolve real Gmail id (source_id may be 'gmail:...')
  const row = deps.db
    .prepare('SELECT source_id FROM tracked_items WHERE id = ?')
    .get(req.params.id) as { source_id: string | null } | undefined;
  const rawGmailId = row?.source_id ?? null;
  const gmailId = rawGmailId?.startsWith('gmail:')
    ? rawGmailId.slice('gmail:'.length)
    : rawGmailId ?? item.thread_id;

  let headers: Record<string, string> = {};
  try {
    const meta = await deps.gmailOps.getMessageMeta(item.account, gmailId);
    headers = (meta as any)?.headers ?? {};
  } catch (err) {
    logger.error(
      { err, id: req.params.id, component: 'mini-app-actions' },
      'Unsubscribe: failed to fetch headers',
    );
  }

  const method = pickUnsubscribeMethod(headers);
  if (method.kind === 'none') {
    res.status(422).json({
      ok: false,
      error: 'No List-Unsubscribe header present',
      code: 'NO_UNSUBSCRIBE_HEADER',
    });
    return;
  }

  const result = await executeUnsubscribe({
    method,
    account: item.account,
    fetch: deps.fetchImpl ?? fetch,
    gmailOps: deps.gmailOps,
  });

  deps.db.prepare(
    `INSERT INTO unsubscribe_log (item_id, method, url, status, error, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    req.params.id,
    result.method,
    result.url ?? null,
    result.status,
    result.error ?? null,
    Date.now(),
  );

  // Archive regardless — user intent is "done with this sender"
  try {
    await deps.gmailOps.archiveThread(item.account, item.thread_id);
  } catch (err) {
    logger.error(
      { err, id: req.params.id, component: 'mini-app-actions' },
      'Unsubscribe: archive failed',
    );
  }

  const succeeded = result.status >= 200 && result.status < 400;
  if (!succeeded && result.status !== 0) {
    res.status(502).json({
      ok: false,
      error: `Remote returned ${result.status}`,
      code: 'UNSUBSCRIBE_REMOTE_FAILED',
      method: result.method,
    });
    return;
  }
  res.json({ ok: true, method: result.method, status: result.status });
});
```

- [ ] **Step 5: Extend EmailMeta to include headers**

In `src/gmail-ops.ts`:

```ts
export interface EmailMeta {
  // ...existing
  headers?: Record<string, string>;
}
```

In `src/channels/gmail.ts getMessageMeta`: include a headers map (copy the subset: `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Precedence`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts -t unsubscribe`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mini-app/actions.ts src/mini-app/server.ts src/gmail-ops.ts src/channels/gmail.ts src/__tests__/mini-app-actions.test.ts
git commit -m "feat(mini-app): unsubscribe route — header-driven one-click/mailto/GET + archive

Fetches message headers, picks method, executes, logs to
unsubscribe_log, always archives the thread. Returns 422 with
NO_UNSUBSCRIBE_HEADER when absent. Remote 4xx/5xx becomes 502 with
UNSUBSCRIBE_REMOTE_FAILED. Adds EmailMeta.headers and exposes it
from the Gmail channel.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 5"
```

---

## Phase 6 — Context-aware action row template

### Task 12: Classification-aware row renderer

**Files:**
- Create: `src/mini-app/templates/action-row.ts`
- Test: `src/mini-app/templates/__tests__/action-row.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderActionRow } from '../action-row.js';

describe('renderActionRow', () => {
  const base = { emailId: 'i1', account: 'a@x.com', threadId: 'thread-1' };

  it('push + human shows canned chips and Quick/Prompt/Archive primary', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'human',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).toContain('data-chip="thanks"');
    expect(html).toContain('data-chip="got-it"');
    expect(html).toContain('data-chip="will-do"');
    expect(html).toContain('data-action="quick-draft"');
    expect(html).toContain('data-action="draft-prompt"');
    expect(html).toContain('data-action="archive"');
    expect(html).not.toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="more"');  // always present
  });

  it('push + bot shows Archive/Snooze/Open primary, no chips', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).not.toContain('data-chip=');
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('data-action="snooze"');
    expect(html).toContain('data-action="open-gmail"');
  });

  it('digest + List-Unsubscribe shows Unsubscribe as primary', () => {
    const html = renderActionRow({
      ...base,
      classification: 'digest',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: true,
    });
    expect(html).toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="mute"');
  });

  it('digest without unsubscribe omits it and adds Open in Gmail', () => {
    const html = renderActionRow({
      ...base,
      classification: 'digest',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).not.toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="open-gmail"');
    expect(html).toContain('data-action="mute"');
  });

  it('transactional is minimal: Archive + Open', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',  // any — subtype wins
      senderKind: 'bot',
      subtype: 'transactional',
      hasUnsubscribeHeader: false,
    });
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('data-action="open-gmail"');
    expect(html).not.toContain('data-action="snooze"');
    expect(html).not.toContain('data-action="mute"');
  });

  it('missing/ignore classification still shows More and Archive+Open', () => {
    const html = renderActionRow({
      ...base,
      classification: null,
      senderKind: 'unknown',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('data-action="more"');
  });

  it('More row (when expanded attribute is true) includes all other actions', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'human',
      subtype: null,
      hasUnsubscribeHeader: false,
      expanded: true,
    });
    // in expanded mode, hidden row visible
    expect(html).toContain('id="more-row"');
    expect(html).toContain('data-action="snooze"');
    expect(html).toContain('data-action="mute"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mini-app/templates/__tests__/action-row.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `action-row.ts`**

```ts
import { escapeHtml } from './escape.js';

export type Classification = 'push' | 'digest' | 'transactional' | 'ignore' | null;
export type SenderKind = 'human' | 'bot' | 'unknown' | null;
export type Subtype = 'transactional' | null;

export interface ActionRowInput {
  emailId: string;
  account: string;
  threadId: string;
  classification: Classification;
  senderKind: SenderKind;
  subtype: Subtype;
  hasUnsubscribeHeader: boolean;
  expanded?: boolean;
}

const ALL_ACTIONS = [
  'quick-draft',
  'draft-prompt',
  'archive',
  'snooze',
  'unsubscribe',
  'mute',
  'open-gmail',
] as const;

function primaryActions(i: ActionRowInput): string[] {
  if (i.subtype === 'transactional') return ['archive', 'open-gmail'];
  if (i.classification === 'push' && i.senderKind === 'human')
    return ['quick-draft', 'draft-prompt', 'archive'];
  if (i.classification === 'push')
    return ['archive', 'snooze', 'open-gmail'];
  if (i.classification === 'digest' && i.hasUnsubscribeHeader)
    return ['unsubscribe', 'archive', 'snooze', 'mute'];
  if (i.classification === 'digest')
    return ['archive', 'snooze', 'mute', 'open-gmail'];
  return ['archive', 'open-gmail'];
}

function chipsFor(i: ActionRowInput): boolean {
  return (
    i.classification === 'push' &&
    i.senderKind === 'human' &&
    i.subtype !== 'transactional'
  );
}

function btn(
  action: string,
  label: string,
  opts: { emailId: string; account: string; threadId: string; style?: string },
): string {
  const style = opts.style || 'background:#21262d;color:#c9d1d9;';
  return `<button class="btn" data-action="${action}" data-email-id="${escapeHtml(
    opts.emailId,
  )}" data-account="${escapeHtml(opts.account)}" data-thread-id="${escapeHtml(
    opts.threadId,
  )}" style="${style}padding:8px 14px;border-radius:6px;border:none;font-size:13px;">${escapeHtml(
    label,
  )}</button>`;
}

const LABELS: Record<string, string> = {
  'quick-draft': '⚡ Quick draft',
  'draft-prompt': '✍️ Draft with prompt',
  archive: 'Archive',
  snooze: '💤 Snooze',
  unsubscribe: '📭 Unsubscribe',
  mute: '🔇 Mute thread',
  'open-gmail': 'Open in Gmail',
};

export function renderActionRow(input: ActionRowInput): string {
  const primary = primaryActions(input);
  const secondary = ALL_ACTIONS.filter((a) => !primary.includes(a));

  const chipsHtml = chipsFor(input)
    ? `<div class="chips" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <button class="btn chip" data-chip="thanks" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Thanks</button>
        <button class="btn chip" data-chip="got-it" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Got it</button>
        <button class="btn chip" data-chip="will-do" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Will do</button>
      </div>`
    : '';

  const primaryHtml = primary
    .map((a) =>
      btn(a, LABELS[a], {
        emailId: input.emailId,
        account: input.account,
        threadId: input.threadId,
        style: a === 'archive' ? 'background:#276749;color:#c6f6d5;' : undefined,
      }),
    )
    .join('');

  const moreBtn = btn('more', '⋯ More', {
    emailId: input.emailId,
    account: input.account,
    threadId: input.threadId,
  });

  const secondaryHtml = secondary
    .map((a) =>
      btn(a, LABELS[a], {
        emailId: input.emailId,
        account: input.account,
        threadId: input.threadId,
      }),
    )
    .join('');

  const moreRowStyle = input.expanded ? 'display:flex;' : 'display:none;';

  return `
    ${chipsHtml}
    <div class="actions primary" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      ${primaryHtml}${moreBtn}
    </div>
    <div id="more-row" class="actions secondary" style="${moreRowStyle}gap:8px;flex-wrap:wrap;margin-top:8px;">
      ${secondaryHtml}
    </div>
  `;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mini-app/templates/__tests__/action-row.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mini-app/templates/action-row.ts src/mini-app/templates/__tests__/action-row.test.ts
git commit -m "feat(mini-app): renderActionRow — classification-aware button layout

Primary button row driven by (classification, senderKind, subtype,
hasUnsubscribeHeader). ⋯ More always present as escape hatch; its row
is rendered hidden by default. Chip row (Thanks/Got it/Will do) only
for human push senders.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 6"
```

### Task 13: Wire `renderActionRow` into `email-full.ts` with client-side JS

**Files:**
- Modify: `src/mini-app/templates/email-full.ts`
- Modify: `src/mini-app/server.ts` (pass new fields to template)
- Test: `src/__tests__/mini-app-routes.test.ts` (add assertion for new button set)

- [ ] **Step 1: Extend `EmailFullData` and render call**

In `src/mini-app/templates/email-full.ts`:

```ts
import { renderActionRow, type Classification, type SenderKind, type Subtype } from './action-row.js';

export interface EmailFullData {
  // ...existing
  classification?: Classification;
  senderKind?: SenderKind;
  subtype?: Subtype;
  hasUnsubscribeHeader?: boolean;
}
```

Replace the existing view-mode `actions` div with a call to `renderActionRow({...})`. The Archive button handler logic stays — just move it into a delegated event listener at the bottom of the script block that catches clicks on `[data-action]` buttons and routes to each endpoint.

Add to the inline `<script>`:

```ts
document.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('[data-action],[data-chip]') as HTMLElement | null;
  if (!btn) return;
  const emailId = btn.dataset.emailId;
  if (!emailId) return;
  const action = btn.dataset.action;
  const chip = btn.dataset.chip;

  if (chip) return handleChip(chip, emailId, btn);
  switch (action) {
    case 'archive':       return handleArchive(emailId, btn);
    case 'snooze':        return handleSnooze(emailId, btn);
    case 'mute':          return handleMute(emailId, btn);
    case 'unsubscribe':   return handleUnsubscribe(emailId, btn);
    case 'quick-draft':   return handleQuickDraft(emailId, btn);
    case 'draft-prompt':  return handleDraftPrompt(emailId, btn);
    case 'more':          return toggleMoreRow();
    case 'open-gmail':    return;  // anchor handles it
  }
});

function toggleMoreRow() {
  const row = document.getElementById('more-row');
  if (row) row.style.display = row.style.display === 'none' ? 'flex' : 'none';
}
```

And stub handlers for each (implementations below in later tasks wire them fully):

```ts
async function handleMute(id, btn) {
  btn.disabled = true; btn.textContent = 'Muting…';
  const r = await fetch(`/api/email/${encodeURIComponent(id)}/mute`, { method: 'POST' });
  const j = await r.json();
  if (j.ok) showBanner('🔇 Muted', 'Unmute', () => fetch(`/api/email/${encodeURIComponent(id)}/mute`, { method: 'DELETE' }));
  else { btn.disabled = false; btn.textContent = 'Mute thread'; alert(j.error || 'Failed'); }
}

function showBanner(text, actionLabel, actionFn) {
  const existing = document.querySelector('.action-banner'); if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'action-banner';
  div.style.cssText = 'border-top:1px solid #21262d;padding-top:12px;margin-top:12px;color:#c9d1d9;';
  div.innerHTML = `<span>${text}</span>`;
  if (actionLabel) {
    const a = document.createElement('button');
    a.textContent = actionLabel; a.style.cssText = 'margin-left:12px;background:#21262d;color:#c9d1d9;padding:6px 12px;border-radius:6px;border:none;';
    a.onclick = () => { actionFn(); div.remove(); };
    div.appendChild(a);
  }
  document.body.appendChild(div);
}
```

- [ ] **Step 2: Update server.ts to pass new fields**

In `src/mini-app/server.ts` `/email/:emailId` handler, pass along:

```ts
const row2 = opts.db.prepare(
  'SELECT classification, sender_kind, subtype FROM tracked_items WHERE id = ? OR thread_id = ? OR source_id = ? ORDER BY detected_at DESC LIMIT 1',
).get(emailId, emailId, emailId) as
  | { classification: string | null; sender_kind: string | null; subtype: string | null }
  | undefined;

const hasUnsubscribeHeader =
  !!(meta as any)?.headers?.['List-Unsubscribe'] ||
  !!(meta as any)?.headers?.['list-unsubscribe'];

const html = renderEmailFull({
  // ...existing
  classification: row2?.classification as any,
  senderKind: row2?.sender_kind as any,
  subtype: row2?.subtype as any,
  hasUnsubscribeHeader,
});
```

- [ ] **Step 3: Add assertion to existing route test**

In `src/__tests__/mini-app-routes.test.ts`, add:

```ts
it('GET /email/:emailId renders classification-aware action row', async () => {
  const { app, db } = setup();
  db.prepare(
    `INSERT INTO tracked_items (id, source, state, queue, classification, sender_kind, thread_id, detected_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('sse-class-1', 'email', 'pushed', 'attention', 'push', 'human', 'thread-1', Date.now(),
    JSON.stringify({ account: 'alice@example.com' }));
  const res = await request(app).get('/email/sse-class-1');
  expect(res.status).toBe(200);
  // Human push → chips visible
  expect(res.text).toContain('data-chip="thanks"');
  expect(res.text).toContain('data-action="quick-draft"');
});
```

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: the new test PASSES, existing tests still pass (archive flow still works via delegated handler).

- [ ] **Step 4: Commit**

```bash
git add src/mini-app/templates/email-full.ts src/mini-app/server.ts src/__tests__/mini-app-routes.test.ts
git commit -m "feat(mini-app): render classification-aware action row in email view

email-full.ts now calls renderActionRow() with classification,
senderKind, subtype, and hasUnsubscribeHeader resolved from
tracked_items + fetched headers. Event delegation routes clicks on
[data-action] and [data-chip] to their respective handlers. Mute
handler wired; others stubbed for later tasks.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 6"
```

---

## Phase 7 — Canned reply chips

### Task 14: Canned reply route + send

**Files:**
- Modify: `src/mini-app/actions.ts` (add canned-reply route)
- Modify: `src/mini-app/templates/email-full.ts` (wire `handleChip`)
- Modify: `src/__tests__/mini-app-actions.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe('mini-app actions — canned reply', () => {
  let db: Database.Database;
  let gmailOps: any;
  beforeEach(() => {
    db = freshDb();
    gmailOps = {
      archiveThread: vi.fn(),
      sendEmail: vi.fn(),
      getMessageMeta: vi.fn().mockResolvedValue({
        subject: 'RE: test',
        from: 'jane@example.com',
        to: 'alice@example.com',
        date: '',
        body: 'original',
        headers: { 'Message-ID': '<msg-1@example.com>' },
      }),
      createDraftReply: vi.fn().mockResolvedValue({ draftId: 'd-1' }),
      sendDraft: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('POST /api/email/:id/canned-reply creates draft + schedules send', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    db.prepare('UPDATE tracked_items SET source_id=? WHERE id=?').run(
      'gmail:thread-1', 'i1',
    );
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/canned-reply')
      .send({ kind: 'thanks' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.draftId).toBe('d-1');
    expect(res.body.sendAt).toBeGreaterThan(Date.now());
    expect(gmailOps.createDraftReply).toHaveBeenCalledWith(
      'alice@example.com',
      expect.objectContaining({
        threadId: 'thread-1',
        body: expect.stringContaining('Thanks!'),
      }),
    );
  });

  it('POST /api/email/:id/canned-reply rejects unknown kind', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({ port: 0, db, gmailOps });
    const res = await request(app)
      .post('/api/email/i1/canned-reply')
      .send({ kind: 'shrug' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KIND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `createDraftReply` not on `GmailOps`, route not registered.

- [ ] **Step 3: Add `createDraftReply` to GmailOps**

In `src/gmail-ops.ts`:

```ts
export interface CreateDraftReplyInput {
  threadId: string;
  body: string;
}
export interface GmailOps {
  // ...
  createDraftReply(account: string, input: CreateDraftReplyInput): Promise<{ draftId: string }>;
}
```

Implement in `src/channels/gmail.ts`:

```ts
async createDraftReply(input: CreateDraftReplyInput): Promise<{ draftId: string }> {
  // Get thread context for headers
  const thread = await this.gmail.users.threads.get({
    userId: 'me', id: input.threadId, format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'To', 'Message-ID', 'References'],
  });
  const last = (thread.data.messages || []).slice(-1)[0];
  const hdrs = last?.payload?.headers || [];
  const h = (name: string) => hdrs.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value;
  const subject = h('Subject') || '';
  const from = h('From') || '';
  const msgId = h('Message-ID') || '';
  const refs = h('References') || '';

  const headers: string[] = [
    `To: ${from}`,
    `Subject: Re: ${subject.replace(/^re:\s*/i, '')}`,
    msgId ? `In-Reply-To: ${msgId}` : '',
    `References: ${refs ? refs + ' ' : ''}${msgId}`,
    'Content-Type: text/plain; charset=UTF-8',
  ].filter(Boolean);
  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + input.body,
    'utf-8',
  ).toString('base64url');

  const resp = await this.gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { threadId: input.threadId, raw } },
  });
  return { draftId: resp.data.id ?? '' };
}
```

- [ ] **Step 4: Add signature cache**

In `src/mini-app/actions.ts`:

```ts
const signatureCache = new Map<string, string>();

async function getFirstName(
  gmailOps: GmailOps,
  account: string,
): Promise<string> {
  if (signatureCache.has(account)) return signatureCache.get(account)!;
  // Best-effort; default to "Jonathan" if the Gmail settings call isn't
  // available on this GmailOps. (Adapt if you later add sendAs listing.)
  const fallback = (account.split('@')[0] || 'Jonathan')
    .split(/[._-]/)[0]
    .replace(/^./, (c) => c.toUpperCase());
  signatureCache.set(account, fallback);
  return fallback;
}

const CANNED: Record<string, (name: string) => string> = {
  thanks: (n) => `Thanks!\n\n${n}`,
  'got-it': (n) => `Got it — thanks.\n\n${n}`,
  'will-do': (n) => `Will do. Thanks,\n\n${n}`,
};
```

- [ ] **Step 5: Add canned-reply route**

```ts
router.post('/api/email/:id/canned-reply', async (req, res) => {
  const item = lookupItem(req.params.id);
  if (!item || !item.thread_id || !item.account) {
    res.status(404).json({ ok: false, error: 'Not found', code: 'ITEM_NOT_FOUND' });
    return;
  }
  const kind = ((req.body as any)?.kind as string) ?? '';
  const builder = CANNED[kind];
  if (!builder) {
    res.status(400).json({ ok: false, error: `unknown kind: ${kind}`, code: 'INVALID_KIND' });
    return;
  }
  if (!deps.gmailOps || !deps.pendingSendRegistry) {
    res.status(503).json({ ok: false, error: 'dependencies missing', code: 'INTERNAL' });
    return;
  }
  const name = await getFirstName(deps.gmailOps, item.account);
  const body = builder(name);
  const { draftId } = await deps.gmailOps.createDraftReply(item.account, {
    threadId: item.thread_id,
    body,
  });
  // Schedule send via existing registry (10s undo)
  const { sendAt } = deps.pendingSendRegistry.schedule(
    draftId,
    item.account,
    10_000,
    async (id, acct) => {
      try {
        await deps.gmailOps!.sendDraft(acct, id);
      } catch (err) {
        logger.error({ err, draftId: id, component: 'mini-app-actions' }, 'canned-reply send failed');
      }
    },
  );
  res.json({ ok: true, draftId, sendAt });
});
```

Pass `pendingSendRegistry` into `ActionDeps`. Update `server.ts` accordingly (`createActionsRouter` call receives the registry).

- [ ] **Step 6: Wire `handleChip` in `email-full.ts` client-side JS**

```ts
async function handleChip(kind, emailId, btn) {
  const chips = document.querySelectorAll('.chip');
  chips.forEach(c => { (c as HTMLButtonElement).disabled = true; });
  const res = await fetch(`/api/email/${encodeURIComponent(emailId)}/canned-reply`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ kind }),
  });
  const j = await res.json();
  if (!j.ok) {
    chips.forEach(c => { (c as HTMLButtonElement).disabled = false; });
    alert(j.error || 'Canned reply failed');
    return;
  }
  const countdown = Math.max(0, Math.round((j.sendAt - Date.now()) / 1000));
  showUndoBanner(j.draftId, countdown);
}

function showUndoBanner(draftId, countdown) {
  // Reuse the existing undo banner from reply-mode if possible
  const div = document.createElement('div');
  div.className = 'action-banner';
  div.style.cssText = 'border-top:1px solid #21262d;padding-top:12px;margin-top:12px;color:#c9d1d9;';
  div.innerHTML = `<span>Sending in <span id="cd">${countdown}</span>s</span>`;
  const undo = document.createElement('button');
  undo.textContent = 'Undo';
  undo.style.cssText = 'margin-left:12px;background:#f85149;color:#fff;padding:6px 12px;border-radius:6px;border:none;';
  undo.onclick = async () => {
    await fetch(`/api/draft/${encodeURIComponent(draftId)}/send/cancel`, { method: 'POST' });
    div.remove();
    document.querySelectorAll('.chip').forEach(c => { (c as HTMLButtonElement).disabled = false; });
  };
  div.appendChild(undo);
  document.body.appendChild(div);
  const timer = setInterval(() => {
    countdown -= 1;
    const el = document.getElementById('cd');
    if (el) el.textContent = String(countdown);
    if (countdown <= 0) {
      clearInterval(timer);
      div.innerHTML = '<span style="color:#6ca368;">Sent.</span>';
      setTimeout(() => div.remove(), 3000);
    }
  }, 1000);
}
```

- [ ] **Step 7: Run tests + commit**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts`
Expected: PASS.

```bash
git add src/mini-app/actions.ts src/mini-app/server.ts src/mini-app/templates/email-full.ts src/gmail-ops.ts src/channels/gmail.ts src/__tests__/mini-app-actions.test.ts
git commit -m "feat(mini-app): canned reply chips (Thanks / Got it / Will do)

Chips on human push emails. Tap → server creates Gmail draft with
canonical text + name signature, schedules send via existing
PendingSendRegistry (10s undo banner, same UX as agent-drafted reply).

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 7"
```

---

## Phase 8 — Snooze / Unsubscribe / Mute UI wiring

### Task 15: Wire snooze dropdown + banners for the remaining actions

**Files:**
- Modify: `src/mini-app/templates/email-full.ts`

- [ ] **Step 1: Snooze dropdown**

Add to the script block:

```ts
function handleSnooze(emailId, btn) {
  const wrap = document.createElement('div');
  wrap.className = 'snooze-dropdown';
  wrap.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;';
  ['1h', 'tomorrow-8am', 'next-monday-8am', 'next-week', 'custom'].forEach((d) => {
    const b = document.createElement('button');
    b.textContent = {
      '1h': '1 hour',
      'tomorrow-8am': 'Tomorrow 8am',
      'next-monday-8am': 'Next Mon 8am',
      'next-week': 'Next week',
      custom: 'Custom…',
    }[d];
    b.style.cssText = 'background:#21262d;color:#c9d1d9;padding:6px 10px;border-radius:6px;border:none;font-size:12px;';
    b.onclick = async () => {
      let wakeAt;
      if (d === 'custom') {
        const v = prompt('Snooze until (ISO datetime, e.g. 2026-04-21T09:00)?');
        if (!v) return;
        wakeAt = new Date(v).toISOString();
      }
      const res = await fetch(`/api/email/${encodeURIComponent(emailId)}/snooze`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ duration: d, wake_at: wakeAt }),
      });
      const j = await res.json();
      if (!j.ok) { alert(j.error); return; }
      wrap.remove();
      const when = new Date(j.wake_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      showBanner(`💤 Snoozed until ${when}`, 'Unsnooze', async () => {
        await fetch(`/api/email/${encodeURIComponent(emailId)}/snooze`, { method: 'DELETE' });
      });
    };
    wrap.appendChild(b);
  });
  btn.parentElement.appendChild(wrap);
}
```

- [ ] **Step 2: Unsubscribe handler**

```ts
async function handleUnsubscribe(emailId, btn) {
  btn.disabled = true; btn.textContent = 'Unsubscribing…';
  const res = await fetch(`/api/email/${encodeURIComponent(emailId)}/unsubscribe`, { method: 'POST' });
  const j = await res.json();
  if (j.ok) showBanner('✅ Unsubscribed and archived', null, null);
  else if (j.code === 'NO_UNSUBSCRIBE_HEADER') {
    showBanner('No unsubscribe link in headers', 'Open in Gmail', () => {
      window.open(document.querySelector('a.btn[href*="mail.google"]')?.href || '', '_blank');
    });
  }
  else showBanner(`⚠️ Unsubscribe may have failed — ${j.error}`, 'Open in Gmail', null);
}
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts src/__tests__/mini-app-server.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/mini-app/templates/email-full.ts
git commit -m "feat(mini-app): wire snooze dropdown + unsubscribe banner in view mode

Snooze renders an inline dropdown of 5 presets (1h, tomorrow 8am,
next Mon, next week, custom). Unsubscribe shows an optimistic banner,
degraded fallback when header missing, warning on remote failure.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 8"
```

---

## Phase 9 — Draft with AI

### Task 16: `/api/email/:id/draft-with-ai` + polling + container task

**Files:**
- Modify: `src/mini-app/actions.ts` (new route + polling endpoint)
- Modify: `src/mini-app/templates/email-full.ts` (Quick / Prompt handlers)
- Modify: `src/__tests__/mini-app-actions.test.ts` (extend)

This task is larger than the others. It has three sub-parts; each is a step.

- [ ] **Step 1: Write the failing test**

```ts
describe('mini-app actions — draft-with-ai', () => {
  let db: Database.Database;
  let gmailOps: any;
  let spawnAgentMock: any;
  beforeEach(() => {
    db = freshDb();
    gmailOps = { archiveThread: vi.fn() };
    spawnAgentMock = vi.fn().mockResolvedValue({ taskId: 'task-abc' });
  });

  it('POST /api/email/:id/draft-with-ai returns taskId', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0, db, gmailOps, spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app)
      .post('/api/email/i1/draft-with-ai')
      .send({ intent: 'thanks but decline' });
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe('task-abc');
    expect(spawnAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('thanks but decline'),
      }),
    );
  });

  it('POST /api/email/:id/draft-with-ai rejects intent > 500 chars', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0, db, gmailOps, spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app)
      .post('/api/email/i1/draft-with-ai')
      .send({ intent: 'x'.repeat(501) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('INVALID_INTENT');
  });

  it('POST /api/email/:id/draft-with-ai returns 409 when a task is already running', async () => {
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const app = createMiniAppServer({
      port: 0, db, gmailOps, spawnAgentTask: spawnAgentMock,
    });
    await request(app).post('/api/email/i1/draft-with-ai').send({});
    const res = await request(app).post('/api/email/i1/draft-with-ai').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TASK_ALREADY_RUNNING');
  });

  it('GET /api/draft-status/:taskId returns status', async () => {
    const app = createMiniAppServer({
      port: 0, db, gmailOps, spawnAgentTask: spawnAgentMock,
    });
    const res = await request(app).get('/api/draft-status/unknown-task');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');  // unknown taskId
  });
});
```

- [ ] **Step 2: Implement route + polling endpoint**

Add `spawnAgentTask?: (opts: { prompt: string; account: string; itemId: string }) => Promise<{ taskId: string }>` to `ActionDeps`.

Keep an in-memory map:

```ts
// In actions.ts
const activeTasks = new Map<string, { taskId: string; startedAt: number }>();
const taskStatus = new Map<string, { status: 'running' | 'ready' | 'failed'; draftId?: string; error?: string }>();
```

Subscribe to the event bus at router creation time (if `eventBus` passed in deps):

```ts
if (deps.eventBus) {
  deps.eventBus.on('email.draft.ready', (e: any) => {
    const taskId = e?.payload?.taskId as string | undefined;
    const draftId = e?.payload?.draftId as string | undefined;
    if (taskId) taskStatus.set(taskId, { status: 'ready', draftId });
  });
}
```

Routes:

```ts
const TASK_TIMEOUT_MS = 45_000;
const INTENT_CAP = 500;

router.post('/api/email/:id/draft-with-ai', async (req, res) => {
  const item = lookupItem(req.params.id);
  if (!item || !item.thread_id || !item.account) {
    res.status(404).json({ ok: false, error: 'Not found', code: 'ITEM_NOT_FOUND' });
    return;
  }
  const intent = ((req.body as any)?.intent as string | undefined) ?? '';
  if (intent.length > INTENT_CAP) {
    res.status(413).json({ ok: false, error: 'intent too long', code: 'INVALID_INTENT' });
    return;
  }
  const existing = activeTasks.get(item.id);
  if (existing && Date.now() - existing.startedAt < TASK_TIMEOUT_MS) {
    res.status(409).json({
      ok: false, error: 'task already running', code: 'TASK_ALREADY_RUNNING',
      taskId: existing.taskId,
    });
    return;
  }
  if (!deps.spawnAgentTask) {
    res.status(503).json({ ok: false, error: 'agent runner missing', code: 'INTERNAL' });
    return;
  }
  const prompt = [
    'You are drafting a Gmail reply.',
    `Thread: ${item.thread_id} (account ${item.account})`,
    intent ? `User intent: ${intent}` : 'User intent: use best judgment based on thread context.',
    'Draft a concise, natural reply using gmail.users.drafts.create. Match any prior tone from earlier messages in the thread. Return the draft_id only.',
  ].join('\n');

  const { taskId } = await deps.spawnAgentTask({
    prompt, account: item.account, itemId: item.id,
  });
  activeTasks.set(item.id, { taskId, startedAt: Date.now() });
  taskStatus.set(taskId, { status: 'running' });
  res.json({ ok: true, taskId });
});

router.get('/api/draft-status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const state = taskStatus.get(taskId);
  if (!state) {
    res.json({ ok: true, status: 'unknown' });
    return;
  }
  res.json({ ok: true, status: state.status, draftId: state.draftId, error: state.error });
});
```

- [ ] **Step 3: Wire Quick + Prompt handlers in `email-full.ts`**

```ts
async function handleQuickDraft(emailId, btn) {
  btn.disabled = true; btn.textContent = '⚡ Drafting…';
  const res = await fetch(`/api/email/${encodeURIComponent(emailId)}/draft-with-ai`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  const j = await res.json();
  if (!j.ok) { btn.disabled = false; btn.textContent = 'Quick draft'; alert(j.error); return; }
  pollDraftTask(j.taskId, btn);
}

function handleDraftPrompt(emailId, btn) {
  if (document.getElementById('draft-prompt-input')) return;
  const ta = document.createElement('textarea');
  ta.id = 'draft-prompt-input';
  ta.placeholder = 'What should the reply say? (e.g. "decline politely, suggest next Tues")';
  ta.style.cssText = 'display:block;width:100%;min-height:72px;margin-top:8px;padding:8px;background:#0d1117;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;font:inherit;';
  const sub = document.createElement('button');
  sub.textContent = 'Draft'; sub.style.cssText = 'margin-top:6px;background:#1f6feb;color:#fff;padding:8px 14px;border-radius:6px;border:none;';
  sub.onclick = async () => {
    const intent = ta.value.trim();
    if (!intent) return;
    btn.disabled = true; sub.disabled = true; sub.textContent = 'Drafting…';
    const res = await fetch(`/api/email/${encodeURIComponent(emailId)}/draft-with-ai`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ intent }),
    });
    const j = await res.json();
    if (!j.ok) { alert(j.error); btn.disabled = false; sub.disabled = false; sub.textContent = 'Draft'; return; }
    ta.remove(); sub.remove();
    pollDraftTask(j.taskId, btn);
  };
  btn.parentElement.appendChild(ta);
  btn.parentElement.appendChild(sub);
}

function pollDraftTask(taskId, btn) {
  const deadline = Date.now() + 50_000;
  const timer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(timer);
      btn.disabled = false;
      alert('Draft timed out');
      return;
    }
    const res = await fetch(`/api/draft-status/${encodeURIComponent(taskId)}`);
    const j = await res.json();
    if (j.status === 'ready' && j.draftId) {
      clearInterval(timer);
      window.location.href = `/reply/${encodeURIComponent(j.draftId)}`;
    } else if (j.status === 'failed') {
      clearInterval(timer);
      btn.disabled = false;
      alert(`Draft failed: ${j.error}`);
    }
  }, 1500);
}
```

- [ ] **Step 4: Run tests + commit**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts -t draft-with-ai`
Expected: all PASS.

```bash
git add src/mini-app/actions.ts src/mini-app/server.ts src/mini-app/templates/email-full.ts src/__tests__/mini-app-actions.test.ts
git commit -m "feat(mini-app): Draft with AI — Quick and With prompt

POST /api/email/:id/draft-with-ai spawns a container agent task with
a scoped prompt. Quick sends {}; With prompt sends {intent}.
Concurrent calls on the same item are rejected with 409. Intents
capped at 500 chars. GET /api/draft-status/:taskId returns status.
Client polls every 1.5s and navigates to /reply/:draftId on ready.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 9"
```

---

## Phase 10 — Integration + rollout

### Task 17: End-to-end integration test

**Files:**
- Create: `src/__tests__/miniapp-ux-expansion-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { createMiniAppServer } from '../mini-app/server.js';
import { startSnoozeScheduler } from '../triage/snooze-scheduler.js';
// Reuse helpers from mini-app-actions.test.ts: freshDb, seedItem

describe('ux-expansion integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('snooze flow end-to-end: snooze → wake tick → Telegram event', async () => {
    const db = freshDb();
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('email.snooze.waked', (e) => events.push(e));

    const app = createMiniAppServer({ port: 0, db, gmailOps: { archiveThread: vi.fn() } as any });
    const wakeAt = new Date(Date.now() + 3600_000).toISOString();
    const r1 = await request(app).post('/api/email/i1/snooze').send({ duration: 'custom', wake_at: wakeAt });
    expect(r1.body.ok).toBe(true);

    const stop = startSnoozeScheduler({ db, eventBus: bus as any, intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(3700_000);
    stop();

    expect(events).toHaveLength(1);
    const row = db.prepare('SELECT state FROM tracked_items WHERE id=?').get('i1') as { state: string };
    expect(row.state).toBe('pushed');
  });

  it('mute flow: mute, new SSE email on same thread is skipped', async () => {
    const db = freshDb();
    seedItem(db, 'i1', 'thread-1', 'alice@example.com');
    const archive = vi.fn().mockResolvedValue(undefined);
    const app = createMiniAppServer({
      port: 0, db, gmailOps: { archiveThread: archive } as any,
    });
    await request(app).post('/api/email/i1/mute').send({});

    // Simulate a second incoming event on the same thread
    const { processIncomingEmail } = await import('../email-sse.js');
    const result = await processIncomingEmail({
      db,
      gmailOps: { archiveThread: archive } as any,
      event: {
        threadId: 'thread-1', account: 'alice@example.com',
        messageId: 'msg-2', subject: '', from: '', headers: {}, body: '',
      },
    });
    expect(result.action).toBe('muted_skip');
    // No new tracked_items
    const count = db.prepare('SELECT COUNT(*) AS n FROM tracked_items').get() as { n: number };
    expect(count.n).toBe(1);  // the original item only (now resolved)
    expect(archive).toHaveBeenCalledWith('alice@example.com', 'thread-1');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/__tests__/miniapp-ux-expansion-integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full mini-app suite one more time**

Run: `npx vitest run src/__tests__/mini-app-actions.test.ts src/__tests__/mini-app-routes.test.ts src/__tests__/mini-app-server.test.ts src/__tests__/mini-app-sse.test.ts src/__tests__/mini-app-send-integration.test.ts src/__tests__/mini-app-draft-send-routes.test.ts src/mini-app/pending-send.test.ts src/__tests__/miniapp-ux-expansion-integration.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/miniapp-ux-expansion-integration.test.ts
git commit -m "test: ux-expansion integration coverage

End-to-end: snooze wake emits Telegram event; mute then re-ingest of
same thread skips tracked_items insert and re-archives.

Plan: docs/superpowers/plans/2026-04-19-miniapp-ux-expansion.md — Phase 10"
```

### Task 18: Production smoke + merge

**Files:** (none — operational)

- [ ] **Step 1: Build**

Run from main tree: `npm run build`
Expected: clean, no TS errors.

- [ ] **Step 2: Merge branch to main**

```bash
cd /Users/topcoder1/dev/nanoclaw
git -c user.name='Jonathan' -c user.email='topcoder1@gmail.com' merge --no-ff <feature-branch> -m "merge: mini-app UX expansion"
```

- [ ] **Step 3: Restart service**

Run: `launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"`
Wait for it to come back up on port 3847.

- [ ] **Step 4: Smoke the live surface**

```bash
# view an existing tracked_item
curl -sS http://localhost:3847/email/<some-id> | head -50
# confirm action row rendered with data-action attrs
```

- [ ] **Step 5: Telegram WebView check**

Open Telegram, tap `Full Email` on the current attention item, verify the new button row renders correctly through the CF Access gate, interact with Mute / Snooze on a throwaway email to see banners.

- [ ] **Step 6: Push to origin**

```bash
git push origin main
git push origin <feature-branch>
```

- [ ] **Step 7: Final commit if any UI tweaks needed based on smoke**

If the smoke reveals issues, fix in place, commit incrementally, redeploy. Otherwise no final commit needed.

---

## Test summary (for the verifier)

| Suite | Tests added |
|---|---|
| `src/__tests__/migrations-2026-04-19.test.ts` | 6 |
| `src/triage/__tests__/sender-kind.test.ts` | 11 |
| `src/triage/__tests__/mute-filter.test.ts` | 6 (5 unit + 1 integration) |
| `src/triage/__tests__/snooze-scheduler.test.ts` | 3 |
| `src/triage/__tests__/unsubscribe-executor.test.ts` | 10 |
| `src/mini-app/templates/__tests__/action-row.test.ts` | 7 |
| `src/__tests__/mini-app-actions.test.ts` | 12 (mute 3 + snooze 5 + unsubscribe 2 + canned 2 + draft-with-ai 4 variants) |
| `src/channels/gmail.test.ts` | +1 sendEmail, +1 createDraftReply |
| `src/__tests__/invariants-runtime-proof.test.ts` | +2 muted-never-visible |
| `src/__tests__/miniapp-ux-expansion-integration.test.ts` | 2 |

**Net:** ~60 new test cases.

## Success criteria

1. All listed tests pass
2. `npm run build` is clean
3. Existing mini-app route tests still pass (no regressions)
4. Smoke checklist (Task 18 Step 4-5) confirms the UI renders correctly through the CF Access gate
5. The `muted-threads-never-visible` invariant holds on prod DB after at least one mute action in production use
