import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from '../config.js';
import { saveProcedure, type Procedure } from '../memory/procedure-store.js';
import {
  buildConsolidationPrompt,
  clusterProcedures,
  parseConsolidatedJson,
  runConsolidation,
  stepsOverlap,
} from './consolidator.js';

const globalProcDir = path.join(STORE_DIR, 'procedures');
// Unique per-file groupId so parallel test files don't clobber each other
// in groups/<id>/procedures/ on the real fs.
const groupId = 'consolidator_test';
const groupProcDir = path.join(GROUPS_DIR, groupId, 'procedures');
const reportsDir = path.join(STORE_DIR, 'consolidation-reports');
const candidatesRoot = path.join(STORE_DIR, 'consolidation-candidates');

function rmrf(p: string): void {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function cleanDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
  }
}

function makeProc(overrides: Partial<Procedure> = {}): Procedure {
  const now = new Date().toISOString();
  return {
    name: 'p_default',
    trigger: 'do something',
    description: 'a proc',
    steps: [{ action: 'a' }, { action: 'b' }],
    success_count: 1,
    failure_count: 0,
    auto_execute: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(globalProcDir, { recursive: true });
  fs.mkdirSync(groupProcDir, { recursive: true });
  cleanDir(globalProcDir);
  cleanDir(groupProcDir);
  rmrf(reportsDir);
  rmrf(candidatesRoot);
});

afterEach(() => {
  cleanDir(globalProcDir);
  cleanDir(groupProcDir);
  rmrf(reportsDir);
  rmrf(candidatesRoot);
});

describe('stepsOverlap', () => {
  it('returns 0 for empty', () => {
    expect(stepsOverlap([], [{ action: 'a' }])).toBe(0);
    expect(stepsOverlap([{ action: 'a' }], [])).toBe(0);
  });

  it('returns 1.0 for identical action sets', () => {
    expect(
      stepsOverlap(
        [{ action: 'a' }, { action: 'b' }],
        [{ action: 'b' }, { action: 'a' }],
      ),
    ).toBe(1);
  });

  it('returns ratio of common over max set size', () => {
    // {a,b} vs {a,c,d} → common={a}=1, max=3 → 1/3
    const v = stepsOverlap(
      [{ action: 'a' }, { action: 'b' }],
      [{ action: 'a' }, { action: 'c' }, { action: 'd' }],
    );
    expect(v).toBeCloseTo(1 / 3, 5);
  });
});

describe('clusterProcedures', () => {
  it('returns no clusters when nothing overlaps', () => {
    const procs = [
      makeProc({ name: 'p1', steps: [{ action: 'x' }] }),
      makeProc({ name: 'p2', steps: [{ action: 'y' }] }),
      makeProc({ name: 'p3', steps: [{ action: 'z' }] }),
    ];
    expect(clusterProcedures(procs)).toEqual([]);
  });

  it('groups procedures with >=70% step overlap', () => {
    // shared action set {a,b,c}, threshold 0.7 → 3/3=1.0 in p1/p2,
    // p3 has {a,b} overlap with {a,b,c} → 2/3=0.66 → below threshold
    const p1 = makeProc({
      name: 'p1',
      steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
    });
    const p2 = makeProc({
      name: 'p2',
      steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
    });
    const p3 = makeProc({
      name: 'p3',
      steps: [{ action: 'a' }, { action: 'b' }],
    });
    const clusters = clusterProcedures([p1, p2, p3]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.name).sort()).toEqual(['p1', 'p2']);
  });

  it('uses transitive growth: A links to B links to C', () => {
    const a = makeProc({
      name: 'a',
      steps: [{ action: '1' }, { action: '2' }, { action: '3' }],
    });
    const b = makeProc({
      name: 'b',
      steps: [{ action: '1' }, { action: '2' }, { action: '3' }],
    });
    const c = makeProc({
      name: 'c',
      steps: [{ action: '2' }, { action: '3' }, { action: '4' }],
    });
    // overlap(a,b)=1.0; overlap(a,c)={2,3}/{1,2,3,4}=2/4=0.5 below threshold
    // overlap(b,c) same as (a,c)=0.5. So c does NOT join.
    const clusters = clusterProcedures([a, b, c]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.name).sort()).toEqual(['a', 'b']);
  });
});

describe('buildConsolidationPrompt', () => {
  it('lists every member name and trigger', () => {
    const cluster = {
      members: [
        makeProc({ name: 'one', trigger: 'foo', steps: [{ action: 's1' }] }),
        makeProc({ name: 'two', trigger: 'bar', steps: [{ action: 's2' }] }),
      ],
    };
    const p = buildConsolidationPrompt(cluster);
    expect(p).toMatch(/one/);
    expect(p).toMatch(/two/);
    expect(p).toMatch(/foo/);
    expect(p).toMatch(/bar/);
    expect(p).toMatch(/STRICT JSON ONLY/);
  });
});

describe('parseConsolidatedJson', () => {
  it('parses clean JSON', () => {
    const out = parseConsolidatedJson(
      JSON.stringify({
        name: 'merged',
        trigger: 't',
        description: 'd',
        steps: [{ action: 'go', details: 'now' }],
      }),
    );
    expect(out).not.toBeNull();
    expect(out?.name).toBe('merged');
    expect(out?.steps).toEqual([{ action: 'go', details: 'now' }]);
  });

  it('strips ```json fences', () => {
    const wrapped =
      '```json\n{"name":"x","trigger":"y","steps":[{"action":"a"}]}\n```';
    const out = parseConsolidatedJson(wrapped);
    expect(out?.name).toBe('x');
  });

  it('returns null on invalid JSON', () => {
    expect(parseConsolidatedJson('not json')).toBeNull();
  });

  it('returns null when steps missing or empty', () => {
    expect(
      parseConsolidatedJson(JSON.stringify({ name: 'a', trigger: 'b' })),
    ).toBeNull();
    expect(
      parseConsolidatedJson(
        JSON.stringify({ name: 'a', trigger: 'b', steps: [] }),
      ),
    ).toBeNull();
  });

  it('drops steps with empty action', () => {
    const out = parseConsolidatedJson(
      JSON.stringify({
        name: 'a',
        trigger: 'b',
        steps: [{ action: '' }, { action: 'real' }],
      }),
    );
    expect(out?.steps).toEqual([{ action: 'real', details: undefined }]);
  });
});

describe('runConsolidation', () => {
  it('proposes a merged procedure for a cluster, writes report + candidate', async () => {
    saveProcedure(
      makeProc({
        name: 'p1',
        steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
        success_count: 4,
        groupId,
      }),
    );
    saveProcedure(
      makeProc({
        name: 'p2',
        steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
        success_count: 6,
        failure_count: 1,
        groupId,
      }),
    );
    saveProcedure(
      makeProc({
        name: 'unrelated',
        steps: [{ action: 'z' }],
        groupId,
      }),
    );

    const llmResponse = JSON.stringify({
      name: 'merged_abc',
      trigger: 'do abc',
      description: 'merged from p1+p2',
      steps: [
        { action: 'a', details: 'first' },
        { action: 'b' },
        { action: 'c' },
      ],
    });

    const result = await runConsolidation({
      groupId,
      deps: { llmCall: async () => llmResponse },
    });

    expect(result.totalProcedures).toBe(3);
    expect(result.clustersFound).toBe(1);
    expect(result.clusters[0].proposed?.name).toBe('merged_abc');
    expect(result.clusters[0].proposed?.success_count).toBe(10);
    expect(result.clusters[0].proposed?.failure_count).toBe(1);
    expect(result.reportPath).toBeDefined();
    expect(fs.existsSync(result.reportPath!)).toBe(true);
    expect(result.candidatesDir).toBeDefined();
    const candidates = fs.readdirSync(result.candidatesDir!);
    expect(candidates).toContain('merged_abc.json');
    const candidatePayload = JSON.parse(
      fs.readFileSync(
        path.join(result.candidatesDir!, 'merged_abc.json'),
        'utf-8',
      ),
    );
    expect(candidatePayload.replaces).toHaveLength(2);
  });

  it('does NOT mutate originals', async () => {
    saveProcedure(
      makeProc({
        name: 'p1',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    saveProcedure(
      makeProc({
        name: 'p2',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    const llmResponse = JSON.stringify({
      name: 'merged',
      trigger: 't',
      steps: [{ action: 'a' }, { action: 'b' }],
    });
    await runConsolidation({
      groupId,
      deps: { llmCall: async () => llmResponse },
    });
    const remaining = fs.readdirSync(groupProcDir).sort();
    expect(remaining).toEqual(['p1.json', 'p2.json']);
  });

  it('records parse_failed when LLM returns garbage', async () => {
    saveProcedure(
      makeProc({
        name: 'p1',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    saveProcedure(
      makeProc({
        name: 'p2',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    const result = await runConsolidation({
      groupId,
      deps: { llmCall: async () => 'lol not json' },
    });
    expect(result.clusters[0].error).toBe('parse_failed');
    expect(result.clusters[0].proposed).toBeNull();
  });

  it('records error message when LLM throws', async () => {
    saveProcedure(
      makeProc({
        name: 'p1',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    saveProcedure(
      makeProc({
        name: 'p2',
        steps: [{ action: 'a' }, { action: 'b' }],
        groupId,
      }),
    );
    const result = await runConsolidation({
      groupId,
      deps: {
        llmCall: async () => {
          throw new Error('rate limited');
        },
      },
    });
    expect(result.clusters[0].error).toBe('rate limited');
  });

  it('skips writing report when writeReport=false', async () => {
    saveProcedure(makeProc({ name: 'p1', steps: [{ action: 'a' }], groupId }));
    const result = await runConsolidation({
      groupId,
      writeReport: false,
      deps: { llmCall: async () => '' },
    });
    expect(result.reportPath).toBeUndefined();
    expect(result.candidatesDir).toBeUndefined();
  });
});
