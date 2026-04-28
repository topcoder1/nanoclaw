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
