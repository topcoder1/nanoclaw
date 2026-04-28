import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  },
}));
let tmp: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() { return tmp; },
  QDRANT_URL: '',
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import { mergeEntities, unmergeEntities } from '../identity-merge.js';

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
  it('rebinds ku_entities and entity_aliases from loser to winner; writes merge_log', async () => {
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
    expect(result.kept_entity_id).toBe('e-keep');
    expect(result.merged_entity_id).toBe('e-merge');

    const links = db.prepare(`SELECT entity_id FROM ku_entities WHERE ku_id='k1'`).all() as any[];
    expect(links.map((l) => l.entity_id)).toEqual(['e-keep']);

    const alias = db.prepare(`SELECT entity_id FROM entity_aliases WHERE alias_id='a1'`).get() as any;
    expect(alias.entity_id).toBe('e-keep');

    const log = db.prepare(`SELECT * FROM entity_merge_log WHERE merge_id=?`).get(result.merge_id) as any;
    expect(log.kept_entity_id).toBe('e-keep');
    expect(log.merged_entity_id).toBe('e-merge');
    expect(log.merged_by).toBe('human:op');
    expect(log.confidence).toBe(1.0);
    const snap = JSON.parse(log.pre_merge_snapshot);
    expect(snap.kept.entity_id).toBe('e-keep');
    expect(snap.merged.entity_id).toBe('e-merge');
    expect(JSON.parse(log.evidence).trigger).toBe('manual');
  });

  it('coalesces ku_entities when winner already linked to the same KU', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-keep', 'A');
    seedPerson(db, 'e-merge', 'B');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
         valid_from, recorded_at, extracted_by, needs_review)
       VALUES ('k1', 'x', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
    ).run();
    // Both linked to k1.
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'e-keep', 'mentioned')`).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'e-merge', 'mentioned')`).run();

    await mergeEntities('e-keep', 'e-merge', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });

    const links = db.prepare(`SELECT entity_id FROM ku_entities WHERE ku_id='k1'`).all() as any[];
    expect(links).toHaveLength(1);
    expect(links[0].entity_id).toBe('e-keep');
  });

  it('rebinds entity_relationships in both directions', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-keep', 'A');
    seedPerson(db, 'e-merge', 'B');
    seedPerson(db, 'e-other', 'C');
    db.prepare(
      `INSERT INTO entity_relationships (rel_id, from_entity_id, relationship, to_entity_id, valid_from, confidence)
       VALUES ('r1', 'e-merge', 'reports_to', 'e-other', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_relationships (rel_id, from_entity_id, relationship, to_entity_id, valid_from, confidence)
       VALUES ('r2', 'e-other', 'reports_to', 'e-merge', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();

    await mergeEntities('e-keep', 'e-merge', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });

    const r1 = db.prepare(`SELECT from_entity_id FROM entity_relationships WHERE rel_id='r1'`).get() as any;
    expect(r1.from_entity_id).toBe('e-keep');
    const r2 = db.prepare(`SELECT to_entity_id FROM entity_relationships WHERE rel_id='r2'`).get() as any;
    expect(r2.to_entity_id).toBe('e-keep');
  });
});

describe('mergeEntities — rejection cases', () => {
  it('rejects self-merge', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e1', 'A');
    await expect(
      mergeEntities('e1', 'e1', {
        evidence: { trigger: 'manual' },
        confidence: 1,
        mergedBy: 'human:op',
        db,
      }),
    ).rejects.toThrow(/self-merge/);
  });

  it('rejects when kept entity is missing', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-merge', 'B');
    await expect(
      mergeEntities('missing-id', 'e-merge', {
        evidence: { trigger: 'manual' },
        confidence: 1,
        mergedBy: 'human:op',
        db,
      }),
    ).rejects.toThrow(/kept entity .*not found/);
  });

  it('rejects when merged entity is missing', async () => {
    const db = getBrainDb();
    seedPerson(db, 'e-keep', 'A');
    await expect(
      mergeEntities('e-keep', 'missing-id', {
        evidence: { trigger: 'manual' },
        confidence: 1,
        mergedBy: 'human:op',
        db,
      }),
    ).rejects.toThrow(/merged entity .*not found/);
  });

  it('rejects when entities have different types', async () => {
    const db = getBrainDb();
    db.prepare(
      `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES ('p1', 'person', ?, ?), ('c1', 'company', ?, ?)`,
    ).run(
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:00Z',
      '2026-04-27T00:00:00Z',
    );
    await expect(
      mergeEntities('p1', 'c1', {
        evidence: { trigger: 'manual' },
        confidence: 1,
        mergedBy: 'human:op',
        db,
      }),
    ).rejects.toThrow(/type mismatch/);
  });

  it('rejects re-merging an already-merged loser (chain detection)', async () => {
    const db = getBrainDb();
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');
    seedPerson(db, 'c', 'C');
    await mergeEntities('a', 'b', {
      evidence: { trigger: 'manual' },
      confidence: 1,
      mergedBy: 'human:op',
      db,
    });
    await expect(
      mergeEntities('c', 'b', {
        evidence: { trigger: 'manual' },
        confidence: 1,
        mergedBy: 'human:op',
        db,
      }),
    ).rejects.toThrow(/already merged/);
  });
});

describe('unmergeEntities — happy path', () => {
  it('round-trips: merge then unmerge restores original ku_entities and aliases', async () => {
    const db = getBrainDb();
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');

    // Seed each with a unique KU + alias.
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
         valid_from, recorded_at, extracted_by, needs_review)
       VALUES ('k-a', 'about A', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0),
              ('k-b', 'about B', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
    ).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k-a', 'a', 'mentioned')`).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k-b', 'b', 'mentioned')`).run();
    db.prepare(
      `INSERT INTO entity_aliases (alias_id, entity_id, source_type, field_name, field_value, valid_from, confidence)
       VALUES ('al-b', 'b', 'signal', 'phone', '+15550000000', '2026-04-27T00:00:00Z', 1.0)`,
    ).run();

    const merge = await mergeEntities('a', 'b', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });

    // After merge: a has both k-a + k-b; b has none; al-b points at a.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM ku_entities WHERE entity_id='a'`).get() as any).n,
    ).toBe(2);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM ku_entities WHERE entity_id='b'`).get() as any).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT entity_id FROM entity_aliases WHERE alias_id='al-b'`).get() as any).entity_id,
    ).toBe('a');

    const result = await unmergeEntities(merge.merge_id, { db });
    expect(result.merge_id).toBe(merge.merge_id);

    // After unmerge: each back to pre-merge state.
    const aLinks = db.prepare(`SELECT ku_id FROM ku_entities WHERE entity_id='a'`).all() as Array<{ ku_id: string }>;
    const bLinks = db.prepare(`SELECT ku_id FROM ku_entities WHERE entity_id='b'`).all() as Array<{ ku_id: string }>;
    expect(aLinks.map((r) => r.ku_id)).toEqual(['k-a']);
    expect(bLinks.map((r) => r.ku_id)).toEqual(['k-b']);
    expect(
      (db.prepare(`SELECT entity_id FROM entity_aliases WHERE alias_id='al-b'`).get() as any).entity_id,
    ).toBe('b');

    // merge_log row removed.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM entity_merge_log WHERE merge_id=?`).get(merge.merge_id) as any).n,
    ).toBe(0);
  });

  it('coalesced ku_entities are correctly split back', async () => {
    const db = getBrainDb();
    seedPerson(db, 'x', 'X');
    seedPerson(db, 'y', 'Y');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
         valid_from, recorded_at, extracted_by, needs_review)
       VALUES ('k1', 'shared', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
    ).run();
    // Both linked to k1 — merge will INSERT OR IGNORE then delete y's row.
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'x', 'mentioned')`).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k1', 'y', 'mentioned')`).run();

    const merge = await mergeEntities('x', 'y', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });
    await unmergeEntities(merge.merge_id, { db });

    // Both entities relink to k1 (back to pre-merge state).
    const xLinks = db.prepare(`SELECT entity_id FROM ku_entities WHERE ku_id='k1'`).all() as Array<{ entity_id: string }>;
    expect(xLinks.map((r) => r.entity_id).sort()).toEqual(['x', 'y']);
  });
});

describe('unmergeEntities — rejection cases', () => {
  it('rejects when merge_id does not exist', async () => {
    const db = getBrainDb();
    await expect(unmergeEntities('nonexistent', { db })).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects v1 snapshots (schema_version < 2)', async () => {
    const db = getBrainDb();
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');
    // Insert a v1-style merge log row directly (no schema_version field).
    db.prepare(
      `INSERT INTO entity_merge_log (merge_id, kept_entity_id, merged_entity_id,
         pre_merge_snapshot, confidence, evidence, merged_at, merged_by)
       VALUES ('legacy', 'a', 'b', '{"kept":{"entity_id":"a"},"merged":{"entity_id":"b"}}',
               1.0, '{}', '2026-04-27T00:00:00Z', 'human:op')`,
    ).run();
    await expect(unmergeEntities('legacy', { db })).rejects.toThrow(
      /schema_version/,
    );
  });

  it('refuses when kept entity has post-merge ku_entities additions (without force)', async () => {
    const db = getBrainDb();
    seedPerson(db, 'a', 'A');
    seedPerson(db, 'b', 'B');
    db.prepare(
      `INSERT INTO knowledge_units (id, text, source_type, account, confidence,
         valid_from, recorded_at, extracted_by, needs_review)
       VALUES ('k-pre', 'pre', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0),
              ('k-post', 'post', 'signal_message', 'personal', 0.9,
               '2026-04-27T00:00:00Z', '2026-04-27T00:00:00Z', 'rules', 0)`,
    ).run();
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k-pre', 'a', 'mentioned')`).run();

    const merge = await mergeEntities('a', 'b', {
      evidence: { trigger: 'manual' },
      confidence: 1.0,
      mergedBy: 'human:op',
      db,
    });
    // Simulate a post-merge addition: link k-post to the kept entity 'a'.
    db.prepare(`INSERT INTO ku_entities (ku_id, entity_id, role) VALUES ('k-post', 'a', 'mentioned')`).run();

    await expect(unmergeEntities(merge.merge_id, { db })).rejects.toThrow(
      /added after the merge/,
    );

    // With force:true it succeeds (and discards k-post link).
    await unmergeEntities(merge.merge_id, { db, force: true });
    const postLinks = db
      .prepare(`SELECT * FROM ku_entities WHERE ku_id='k-post'`)
      .all() as Array<unknown>;
    expect(postLinks).toHaveLength(0);
  });
});
