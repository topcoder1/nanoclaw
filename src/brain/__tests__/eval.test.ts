import { describe, expect, it } from 'vitest';

import {
  _resetSeedCache,
  runEval,
  scoreOneQuery,
  seedTemplates,
} from '../eval.js';

describe('brain/eval — templates', () => {
  it('seedTemplates returns exactly 25 entries', () => {
    _resetSeedCache();
    const t = seedTemplates();
    expect(t).toHaveLength(25);
  });

  it('every template has id, category, template, expected_capabilities', () => {
    const t = seedTemplates();
    for (const q of t) {
      expect(typeof q.id).toBe('number');
      expect(typeof q.category).toBe('string');
      expect(typeof q.template).toBe('string');
      expect(Array.isArray(q.expected_capabilities)).toBe(true);
    }
  });

  it('covers all nine required categories', () => {
    const t = seedTemplates();
    const cats = new Set(t.map((q) => q.category));
    expect(cats).toEqual(
      new Set([
        'recency',
        'historical',
        'entity_lookup',
        'multi_hop',
        'bitemporal',
        'cross_source',
        'precision',
        'fuzzy',
        'negation',
      ]),
    );
  });
});

describe('brain/eval — scoreOneQuery', () => {
  it('precision@10 = hits / 10', () => {
    const r = scoreOneQuery(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
      new Set(['a', 'c', 'z']),
    );
    expect(r.precisionAt10).toBe(2 / 10); // 'a', 'c' in top 10; 'z' absent
  });

  it('recall@10 = hits / |relevant|', () => {
    const r = scoreOneQuery(['a', 'x', 'y'], new Set(['a', 'b', 'c']));
    expect(r.recallAt10).toBeCloseTo(1 / 3, 6);
  });

  it('reciprocalRank = 1 / rank_of_first_hit (1-indexed)', () => {
    expect(
      scoreOneQuery(['x', 'y', 'a'], new Set(['a'])).reciprocalRank,
    ).toBeCloseTo(1 / 3, 6);
    expect(
      scoreOneQuery(['a', 'y', 'z'], new Set(['a'])).reciprocalRank,
    ).toBe(1);
    expect(scoreOneQuery(['x', 'y'], new Set(['a'])).reciprocalRank).toBe(0);
  });

  it('recall@10 is 0 when no relevant docs are provided', () => {
    const r = scoreOneQuery(['a', 'b'], new Set<string>());
    expect(r.recallAt10).toBe(0);
  });
});

describe('brain/eval — runEval aggregation', () => {
  it('macro-averages precision/recall/MRR over queries', async () => {
    const queries = [
      { queryId: 'q1', retrievedKuIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
      { queryId: 'q2', retrievedKuIds: ['z', 'y', 'x'] },
    ];
    const expected = new Map<string, Set<string>>([
      ['q1', new Set(['a'])], // rank 1, p@10=0.1, r@10=1.0, mrr=1
      ['q2', new Set(['y'])], // rank 2, p@10=0.1, r@10=1.0, mrr=0.5
    ]);
    const report = await runEval(queries, expected);
    expect(report.precisionAt10).toBeCloseTo((0.1 + 0.1) / 2, 6);
    expect(report.recallAt10).toBe(1);
    expect(report.mrr).toBeCloseTo((1 + 0.5) / 2, 6);
    expect(report.perQuery).toHaveLength(2);
    expect(report.perQuery[0].queryId).toBe('q1');
  });
});
