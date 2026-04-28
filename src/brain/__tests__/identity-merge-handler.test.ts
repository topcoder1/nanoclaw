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
import { handleEntityMergeRequested } from '../identity-merge-handler.js';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-merge-h-'));
});
afterEach(() => {
  _closeBrainDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedPerson(db: any, id: string, name: string): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`,
  ).run(
    id,
    JSON.stringify({ name }),
    '2026-04-27T00:00:00Z',
    '2026-04-27T00:00:00Z',
  );
}

describe('handleEntityMergeRequested', () => {
  it('resolves both handles via canonical name and calls mergeEntities', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-jz', 'Jonathan');
    seedPerson(db, 'e-jz2', 'J Zhang');
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
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'Jonathan',
        handle_b: 'J Zhang',
      },
      { db, sendReply: async (text: string) => { sentReplies.push(text); } },
    );

    const log = db.prepare(`SELECT * FROM entity_merge_log LIMIT 1`).get() as any;
    expect(log).toBeDefined();
    expect([log.kept_entity_id, log.merged_entity_id].sort()).toEqual([
      'e-jz',
      'e-jz2',
    ]);
    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0]).toMatch(/merged/i);
  });

  it('resolves via alias when canonical name does not match', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-1', 'Alice Wonderland');
    seedPerson(db, 'e-2', 'A. Wonderland');
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('a1', 'e-1', 'signal', 'phone', '+15551234567', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();
    const sentReplies: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: '+15551234567',
        handle_b: 'A. Wonderland',
      },
      { db, sendReply: async (t: string) => { sentReplies.push(t); } },
    );
    const log = db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get() as any;
    expect(log.n).toBe(1);
    expect(sentReplies[0]).toMatch(/merged/i);
  });

  it('refuses when a handle is ambiguous', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e1', 'Jonathan');
    seedPerson(db, 'e2', 'Jonathan');
    seedPerson(db, 'e3', 'Jane');
    const sent: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'Jonathan',
        handle_b: 'Jane',
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
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'nobody',
        handle_b: 'somebody',
      },
      { db, sendReply: async (t: string) => { sent.push(t); } },
    );
    expect(sent[0]).toMatch(/not found|no match/i);
  });

  it('refuses when both handles resolve to the same entity', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-same', 'Jonathan');
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('a1', 'e-same', 'signal', 'phone', '+15550000000', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();
    const sent: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'Jonathan',
        handle_b: '+15550000000',
      },
      { db, sendReply: async (t: string) => { sent.push(t); } },
    );
    expect(sent[0]).toMatch(/same entity|already.*same/i);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log`).get()).toEqual({ n: 0 });
  });

  it('handles mergeEntities throwing — surfaces error to reply', async () => {
    const db = getBrainDb();
    // Both real but already chained to provoke a chain rejection from mergeEntities.
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');
    seedPerson(db, 'c', 'C');
    // Simulate prior merge.
    db.prepare(
      `INSERT INTO entity_merge_log (merge_id, kept_entity_id, merged_entity_id,
         pre_merge_snapshot, confidence, evidence, merged_at, merged_by)
       VALUES ('m1', 'a', 'b', '{}', 1.0, '{}', '2026-04-27T00:00:00Z', 'human:op')`,
    ).run();
    const sent: string[] = [];
    await handleEntityMergeRequested(
      {
        type: 'entity.merge.requested',
        source: 'signal',
        timestamp: Date.now(),
        payload: {},
        platform: 'signal',
        chat_id: 'c1',
        requested_by_handle: 'op',
        handle_a: 'C',
        handle_b: 'B',
      },
      { db, sendReply: async (t: string) => { sent.push(t); } },
    );
    expect(sent[0]).toMatch(/failed/i);
  });
});
