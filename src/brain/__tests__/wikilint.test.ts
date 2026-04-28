/**
 * Tests for `/wikilint` detectors and report formatter (Phase 4).
 *
 * Each detector is exercised against an in-memory brain.db seeded with a
 * minimal but realistic mix of rows. The detectors are pure SQL (classes
 * 2/3/4) plus one Qdrant-backed pairwise-cosine pass (class 1). Class 1
 * tests inject a fake vector fetcher so no network/Qdrant required.
 */

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

import type Database from 'better-sqlite3';

import { _openBrainDbForTest } from '../db.js';
import {
  findDuplicateKus,
  findOrphanEntities,
  findStaleWikiPages,
  findTemporalContradictions,
  formatWikilintReport,
  runAll,
  type Finding,
} from '../wikilint.js';

const NOW = '2026-04-28T12:00:00Z';
const LONG_AGO = '2026-01-01T00:00:00Z'; // ~117 days before NOW
const RECENT = '2026-04-25T00:00:00Z'; //   ~3 days before NOW

let db: Database.Database;

beforeEach(() => {
  db = _openBrainDbForTest(':memory:');
});

afterEach(() => {
  db.close();
});

function insertEntity(
  id: string,
  type: 'person' | 'company' | 'project' | 'product' | 'topic',
  createdAt: string,
  opts: {
    canonical?: object;
    last_synthesis_at?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO entities
       (entity_id, entity_type, canonical, created_at, updated_at, last_synthesis_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    type,
    opts.canonical ? JSON.stringify(opts.canonical) : null,
    createdAt,
    createdAt,
    opts.last_synthesis_at ?? null,
  );
}

function insertKu(
  id: string,
  text: string,
  opts: {
    valid_from?: string;
    valid_until?: string | null;
    superseded_at?: string | null;
    topic_key?: string | null;
    recorded_at?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, account, confidence, valid_from, valid_until,
        recorded_at, superseded_at, topic_key)
     VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    text,
    opts.valid_from ?? '2026-04-23T00:00:00Z',
    opts.valid_until ?? null,
    opts.recorded_at ?? '2026-04-23T00:00:00Z',
    opts.superseded_at ?? null,
    opts.topic_key ?? null,
  );
}

function linkKuEntity(
  kuId: string,
  entityId: string,
  role: 'subject' | 'object' | 'mentioned' | 'author' = 'subject',
): void {
  db.prepare(
    `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
  ).run(kuId, entityId, role);
}

// ---------------------------------------------------------------------------
// 1. findOrphanEntities
// ---------------------------------------------------------------------------

describe('findOrphanEntities', () => {
  it('flags entities older than 30 days with <2 linked KUs', () => {
    // orphan-A: old, 0 KUs
    insertEntity('E_A', 'person', LONG_AGO);
    // orphan-B: old, 1 KU
    insertEntity('E_B', 'company', LONG_AGO);
    insertKu('KU_B1', 'b1');
    linkKuEntity('KU_B1', 'E_B');
    // not orphan: old, 2 KUs
    insertEntity('E_C', 'project', LONG_AGO);
    insertKu('KU_C1', 'c1');
    insertKu('KU_C2', 'c2');
    linkKuEntity('KU_C1', 'E_C');
    linkKuEntity('KU_C2', 'E_C');
    // not orphan: young, 0 KUs (still in onboarding window)
    insertEntity('E_D', 'topic', RECENT);

    const findings = findOrphanEntities(db, { nowIso: NOW });
    const ids = findings.map((f) => f.kind === 'orphan_entity' && f.entityId);
    expect(ids.sort()).toEqual(['E_A', 'E_B']);

    const a = findings.find(
      (f) => f.kind === 'orphan_entity' && f.entityId === 'E_A',
    ) as Extract<Finding, { kind: 'orphan_entity' }>;
    expect(a.kuCount).toBe(0);
    expect(a.ageDays).toBeGreaterThan(30);

    const b = findings.find(
      (f) => f.kind === 'orphan_entity' && f.entityId === 'E_B',
    ) as Extract<Finding, { kind: 'orphan_entity' }>;
    expect(b.kuCount).toBe(1);
  });

  it('returns empty array when no entities qualify', () => {
    insertEntity('E_X', 'person', RECENT); // too young
    expect(findOrphanEntities(db, { nowIso: NOW })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. findStaleWikiPages
// ---------------------------------------------------------------------------

describe('findStaleWikiPages', () => {
  it('flags entities whose newest non-superseded KU is fresher than last_synthesis_at', () => {
    // stale: synthesis at T0, KU at T1
    insertEntity('E_S', 'person', LONG_AGO, {
      last_synthesis_at: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_S', 's', { valid_from: '2026-04-20T00:00:00Z' });
    linkKuEntity('KU_S', 'E_S');

    // fresh: synthesis after the KU
    insertEntity('E_F', 'company', LONG_AGO, {
      last_synthesis_at: '2026-04-25T00:00:00Z',
    });
    insertKu('KU_F', 'f', { valid_from: '2026-04-20T00:00:00Z' });
    linkKuEntity('KU_F', 'E_F');

    // never synthesized: skip (NULL last_synthesis_at)
    insertEntity('E_N', 'topic', LONG_AGO);
    insertKu('KU_N', 'n', { valid_from: '2026-04-26T00:00:00Z' });
    linkKuEntity('KU_N', 'E_N');

    // superseded KU shouldn't trigger staleness
    insertEntity('E_X', 'project', LONG_AGO, {
      last_synthesis_at: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_X', 'x', {
      valid_from: '2026-04-22T00:00:00Z',
      superseded_at: '2026-04-23T00:00:00Z',
    });
    linkKuEntity('KU_X', 'E_X');

    const findings = findStaleWikiPages(db);
    expect(findings).toHaveLength(1);
    const f = findings[0] as Extract<Finding, { kind: 'stale_wiki_page' }>;
    expect(f.entityId).toBe('E_S');
    expect(f.lastSynthesisAt).toBe('2026-04-01T00:00:00Z');
    expect(f.newestKuValidFrom).toBe('2026-04-20T00:00:00Z');
  });

  it('returns empty when nothing is stale', () => {
    insertEntity('E_F', 'person', LONG_AGO, {
      last_synthesis_at: '2026-04-25T00:00:00Z',
    });
    insertKu('KU_F', 'f', { valid_from: '2026-04-20T00:00:00Z' });
    linkKuEntity('KU_F', 'E_F');
    expect(findStaleWikiPages(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. findTemporalContradictions
// ---------------------------------------------------------------------------

describe('findTemporalContradictions', () => {
  it('flags two un-superseded KUs sharing topic_key + entity with overlapping intervals and different text', () => {
    insertEntity('E_P', 'person', LONG_AGO);

    // pair-1: overlapping (a runs 2026-04-01 → open; b runs 2026-04-15 → open)
    insertKu('KU_A', 'works at Acme', {
      topic_key: 'employer',
      valid_from: '2026-04-01T00:00:00Z',
      valid_until: null,
    });
    insertKu('KU_B', 'works at Beta', {
      topic_key: 'employer',
      valid_from: '2026-04-15T00:00:00Z',
      valid_until: null,
    });
    linkKuEntity('KU_A', 'E_P');
    linkKuEntity('KU_B', 'E_P');

    // not flagged: superseded
    insertKu('KU_OLD', 'works at Charlie', {
      topic_key: 'employer',
      valid_from: '2026-03-01T00:00:00Z',
      valid_until: null,
      superseded_at: '2026-04-01T00:00:00Z',
    });
    linkKuEntity('KU_OLD', 'E_P');

    // not flagged: identical text — that's a duplicate, not a contradiction
    insertKu('KU_SAME1', 'lives in NYC', {
      topic_key: 'location',
      valid_from: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_SAME2', 'lives in NYC', {
      topic_key: 'location',
      valid_from: '2026-04-10T00:00:00Z',
    });
    linkKuEntity('KU_SAME1', 'E_P');
    linkKuEntity('KU_SAME2', 'E_P');

    // not flagged: different topic_key — orthogonal facts
    insertKu('KU_T1', 'role: engineer', {
      topic_key: 'role',
      valid_from: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_T2', 'team: backend', {
      topic_key: 'team',
      valid_from: '2026-04-01T00:00:00Z',
    });
    linkKuEntity('KU_T1', 'E_P');
    linkKuEntity('KU_T2', 'E_P');

    // not flagged: non-overlapping intervals
    insertKu('KU_N1', 'married to X', {
      topic_key: 'spouse',
      valid_from: '2026-01-01T00:00:00Z',
      valid_until: '2026-03-01T00:00:00Z',
    });
    insertKu('KU_N2', 'married to Y', {
      topic_key: 'spouse',
      valid_from: '2026-04-01T00:00:00Z',
      valid_until: null,
    });
    linkKuEntity('KU_N1', 'E_P');
    linkKuEntity('KU_N2', 'E_P');

    const findings = findTemporalContradictions(db);
    expect(findings).toHaveLength(1);
    const f = findings[0] as Extract<
      Finding,
      { kind: 'temporal_contradiction' }
    >;
    expect(f.entityId).toBe('E_P');
    expect([f.kuIdA, f.kuIdB].sort()).toEqual(['KU_A', 'KU_B']);
  });

  it('returns empty when topic_key is NULL on both sides', () => {
    insertEntity('E_P', 'person', LONG_AGO);
    insertKu('KU_1', 'one', { topic_key: null });
    insertKu('KU_2', 'two', { topic_key: null });
    linkKuEntity('KU_1', 'E_P');
    linkKuEntity('KU_2', 'E_P');
    expect(findTemporalContradictions(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. findDuplicateKus
// ---------------------------------------------------------------------------

/** Build a unit vector pointing at the given index (768d). */
function unitAt(i: number, dim = 8): number[] {
  const v = new Array(dim).fill(0);
  v[i] = 1;
  return v;
}

describe('findDuplicateKus', () => {
  it('flags pairs with cosine >= threshold within same (entity, topic_key)', async () => {
    insertEntity('E_P', 'person', LONG_AGO);
    insertKu('KU_A', 'a', { topic_key: 'role' });
    insertKu('KU_B', 'b', { topic_key: 'role' });
    insertKu('KU_C', 'c', { topic_key: 'role' });
    linkKuEntity('KU_A', 'E_P');
    linkKuEntity('KU_B', 'E_P');
    linkKuEntity('KU_C', 'E_P');

    const fetchVectors = vi.fn(async () => {
      const m = new Map<string, number[]>();
      // A and B nearly identical, C orthogonal.
      m.set('KU_A', [1, 0, 0, 0, 0, 0, 0, 0]);
      m.set('KU_B', [0.99, 0.141, 0, 0, 0, 0, 0, 0]); // cosine ≈ 0.99
      m.set('KU_C', [0, 1, 0, 0, 0, 0, 0, 0]); // cosine 0 with A
      return m;
    });

    const findings = await findDuplicateKus(db, { fetchVectors });
    expect(findings).toHaveLength(1);
    const f = findings[0] as Extract<Finding, { kind: 'duplicate_kus' }>;
    expect([f.kuIdA, f.kuIdB].sort()).toEqual(['KU_A', 'KU_B']);
    expect(f.cosine).toBeGreaterThan(0.95);
  });

  it('does not compare across different (entity, topic_key) groups', async () => {
    insertEntity('E_P', 'person', LONG_AGO);
    insertEntity('E_Q', 'person', LONG_AGO);
    insertKu('KU_X', 'x', { topic_key: 'role' });
    insertKu('KU_Y', 'y', { topic_key: 'role' });
    insertKu('KU_Z', 'z', { topic_key: 'team' });
    linkKuEntity('KU_X', 'E_P');
    linkKuEntity('KU_Y', 'E_Q'); // different entity
    linkKuEntity('KU_Z', 'E_P'); // different topic_key

    const fetchVectors = vi.fn(async () => new Map<string, number[]>());
    const findings = await findDuplicateKus(db, { fetchVectors });
    expect(findings).toEqual([]);
    // No groups with ≥2 KUs sharing both entity and topic_key — fetch should
    // never have been called.
    expect(fetchVectors).not.toHaveBeenCalled();
  });

  it('excludes superseded KUs and NULL topic_key from comparison', async () => {
    insertEntity('E_P', 'person', LONG_AGO);
    insertKu('KU_A', 'a', { topic_key: 'role' });
    insertKu('KU_B', 'b', {
      topic_key: 'role',
      superseded_at: '2026-04-20T00:00:00Z',
    });
    insertKu('KU_N1', 'n1', { topic_key: null });
    insertKu('KU_N2', 'n2', { topic_key: null });
    linkKuEntity('KU_A', 'E_P');
    linkKuEntity('KU_B', 'E_P');
    linkKuEntity('KU_N1', 'E_P');
    linkKuEntity('KU_N2', 'E_P');

    const fetchVectors = vi.fn(async () => new Map<string, number[]>());
    const findings = await findDuplicateKus(db, { fetchVectors });
    expect(findings).toEqual([]);
    expect(fetchVectors).not.toHaveBeenCalled();
  });

  it('caps total pair budget at maxPairs and skips groups with >maxKusPerGroup KUs', async () => {
    insertEntity('E_P', 'person', LONG_AGO);
    // Group with 5 KUs — pairs = 10; with maxKusPerGroup=4, skipped entirely.
    for (let i = 0; i < 5; i++) {
      insertKu(`BIG_${i}`, String(i), { topic_key: 'big' });
      linkKuEntity(`BIG_${i}`, 'E_P');
    }
    // Three small groups (2 KUs each → 1 pair each) — 3 pairs total.
    for (let g = 0; g < 3; g++) {
      insertKu(`G${g}_A`, 'a', { topic_key: `t${g}` });
      insertKu(`G${g}_B`, 'b', { topic_key: `t${g}` });
      linkKuEntity(`G${g}_A`, 'E_P');
      linkKuEntity(`G${g}_B`, 'E_P');
    }

    const fetchVectors = vi.fn(async (ids: string[]) => {
      const m = new Map<string, number[]>();
      for (const id of ids) m.set(id, unitAt(0));
      return m;
    });

    const findings = await findDuplicateKus(db, {
      fetchVectors,
      maxPairs: 2,
      maxKusPerGroup: 4,
    });

    // Only first 2 of 3 small groups considered; "big" group skipped.
    expect(findings).toHaveLength(2);
    // Verify no BIG_* ids in findings.
    for (const f of findings) {
      if (f.kind !== 'duplicate_kus') throw new Error('wrong kind');
      expect(f.kuIdA.startsWith('BIG_')).toBe(false);
      expect(f.kuIdB.startsWith('BIG_')).toBe(false);
    }
  });

  it('does not collapse multi-word topic_keys into a single group', async () => {
    // `extract.ts:normalizeTopic` produces space-joined topic_keys like
    // `current employer`. The grouping separator must not be a space (or
    // any character that can appear in a normalized topic) — regression
    // guard for the bug flagged in PR #?? where a space separator caused
    // `("current","employer")` and `("manager","report")` to collide.
    insertEntity('E_P', 'person', LONG_AGO);
    insertKu('KU_X', 'x', { topic_key: 'current employer' });
    insertKu('KU_Y', 'y', { topic_key: 'previous manager report' });
    linkKuEntity('KU_X', 'E_P');
    linkKuEntity('KU_Y', 'E_P');

    const fetchVectors = vi.fn(async () => new Map<string, number[]>());
    const findings = await findDuplicateKus(db, { fetchVectors });
    expect(findings).toEqual([]);
    // Different topic_keys → no candidate pair → no fetch.
    expect(fetchVectors).not.toHaveBeenCalled();
  });

  it('returns no findings (and skips fetch) if Qdrant is unavailable', async () => {
    insertEntity('E_P', 'person', LONG_AGO);
    insertKu('KU_A', 'a', { topic_key: 'role' });
    insertKu('KU_B', 'b', { topic_key: 'role' });
    linkKuEntity('KU_A', 'E_P');
    linkKuEntity('KU_B', 'E_P');

    // fetchVectors returns an empty map — KU vectors couldn't be retrieved.
    const fetchVectors = vi.fn(async () => new Map<string, number[]>());
    const findings = await findDuplicateKus(db, { fetchVectors });
    expect(findings).toEqual([]);
    expect(fetchVectors).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. runAll
// ---------------------------------------------------------------------------

describe('runAll', () => {
  it('combines findings from all four detectors', async () => {
    // orphan: old, no KUs
    insertEntity('E_ORPH', 'person', LONG_AGO);
    // stale: synthesized before its newest KU. Two KUs so it doesn't
    // also trip the orphan detector.
    insertEntity('E_STALE', 'company', LONG_AGO, {
      last_synthesis_at: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_S1', 's1', { valid_from: '2026-04-20T00:00:00Z' });
    insertKu('KU_S2', 's2', { valid_from: '2026-04-22T00:00:00Z' });
    linkKuEntity('KU_S1', 'E_STALE');
    linkKuEntity('KU_S2', 'E_STALE');
    // temporal: two open-ended conflicting KUs
    insertEntity('E_T', 'person', LONG_AGO);
    insertKu('KU_T1', 'works at A', {
      topic_key: 'employer',
      valid_from: '2026-04-01T00:00:00Z',
    });
    insertKu('KU_T2', 'works at B', {
      topic_key: 'employer',
      valid_from: '2026-04-15T00:00:00Z',
    });
    linkKuEntity('KU_T1', 'E_T');
    linkKuEntity('KU_T2', 'E_T');
    // dup: same vectors. Identical text → class 2 (temporal) is skipped
    // by its `a.text != b.text` guard, so this is purely a class-1
    // duplicate. Two distinct KUs with the same text isolates the
    // detector under test.
    insertEntity('E_D', 'person', LONG_AGO);
    insertKu('KU_D1', 'role: engineer', { topic_key: 'role' });
    insertKu('KU_D2', 'role: engineer', { topic_key: 'role' });
    linkKuEntity('KU_D1', 'E_D');
    linkKuEntity('KU_D2', 'E_D');

    const fetchVectors = async () => {
      const m = new Map<string, number[]>();
      m.set('KU_D1', [1, 0]);
      m.set('KU_D2', [1, 0]);
      return m;
    };

    const findings = await runAll(db, {
      nowIso: NOW,
      duplicates: { fetchVectors },
    });
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual([
      'duplicate_kus',
      'orphan_entity',
      'stale_wiki_page',
      'temporal_contradiction',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. formatWikilintReport
// ---------------------------------------------------------------------------

describe('formatWikilintReport', () => {
  it('returns a clean-bill message when no findings', () => {
    const out = formatWikilintReport([]);
    expect(out).toContain('no issues');
  });

  it('groups findings by class with per-class headings', () => {
    const findings: Finding[] = [
      { kind: 'orphan_entity', entityId: 'E_O', kuCount: 0, ageDays: 42 },
      {
        kind: 'duplicate_kus',
        kuIdA: 'KU_A',
        kuIdB: 'KU_B',
        cosine: 0.96,
      },
      {
        kind: 'temporal_contradiction',
        entityId: 'E_T',
        kuIdA: 'KU_T1',
        kuIdB: 'KU_T2',
      },
      {
        kind: 'stale_wiki_page',
        entityId: 'E_S',
        lastSynthesisAt: '2026-04-01T00:00:00Z',
        newestKuValidFrom: '2026-04-20T00:00:00Z',
      },
    ];
    const out = formatWikilintReport(findings);
    expect(out).toContain('4 findings');
    expect(out).toContain('Near-duplicate KUs');
    expect(out).toContain('Temporal contradictions');
    expect(out).toContain('Orphan entities');
    expect(out).toContain('Stale wiki pages');
    expect(out).toContain('KU_A');
    expect(out).toContain('KU_B');
    expect(out).toContain('0.96');
    expect(out).toContain('E_O');
    expect(out).toContain('E_T');
    expect(out).toContain('E_S');
  });
});
