import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from '../config.js';
import { saveProcedure, type Procedure } from '../memory/procedure-store.js';
import {
  exportProceduresMarkdown,
  rankProcedures,
  writeProceduresMarkdown,
} from './procedures-markdown.js';

const globalProcDir = path.join(STORE_DIR, 'procedures');
const groupId = 'main';
const groupProcDir = path.join(GROUPS_DIR, groupId, 'procedures');
const groupMdPath = path.join(GROUPS_DIR, groupId, 'PROCEDURES.md');

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
    description: 'a default proc',
    steps: [{ action: 'step_one' }, { action: 'step_two' }],
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
  if (fs.existsSync(groupMdPath)) fs.unlinkSync(groupMdPath);
});

afterEach(() => {
  cleanDir(globalProcDir);
  cleanDir(groupProcDir);
  if (fs.existsSync(groupMdPath)) fs.unlinkSync(groupMdPath);
});

describe('rankProcedures', () => {
  it('orders by score (success - 2*failure) desc, then total runs desc', () => {
    const a = makeProc({ name: 'a', success_count: 5, failure_count: 0 });
    const b = makeProc({ name: 'b', success_count: 5, failure_count: 1 });
    const c = makeProc({ name: 'c', success_count: 10, failure_count: 4 });
    const ranked = rankProcedures([b, c, a]);
    // scores: a=5, b=3, c=2 → a, b, c
    expect(ranked.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('drops procedures below minRuns', () => {
    const a = makeProc({ name: 'a', success_count: 0, failure_count: 0 });
    const b = makeProc({ name: 'b', success_count: 1, failure_count: 0 });
    const ranked = rankProcedures([a, b], { minRuns: 1 });
    expect(ranked.map((p) => p.name)).toEqual(['b']);
  });

  it('respects topN', () => {
    const procs = [
      makeProc({ name: 'a', success_count: 5 }),
      makeProc({ name: 'b', success_count: 4 }),
      makeProc({ name: 'c', success_count: 3 }),
    ];
    expect(rankProcedures(procs, { topN: 2 }).map((p) => p.name)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('exportProceduresMarkdown', () => {
  it('returns empty placeholder when no procedures exist', () => {
    const md = exportProceduresMarkdown();
    expect(md).toMatch(/# Learned Procedures/);
    expect(md).toMatch(/No procedures recorded yet/);
  });

  it('renders a procedure with stats, trigger, and steps', () => {
    saveProcedure(
      makeProc({
        name: 'open_pr',
        trigger: 'open a pr',
        description: 'open a pull request',
        steps: [
          { action: 'gh_pr_create', details: 'with title' },
          { action: 'paste_link' },
        ],
        success_count: 7,
        failure_count: 1,
        auto_execute: true,
        groupId,
      }),
    );
    const md = exportProceduresMarkdown({ groupId });
    expect(md).toMatch(/## open_pr _\(auto\)_/);
    expect(md).toMatch(/`open a pr`/);
    expect(md).toMatch(/88% success across 8 runs \(7✓ \/ 1✗\)/);
    expect(md).toMatch(/`gh_pr_create` — with title/);
    expect(md).toMatch(/`paste_link`/);
  });

  it('only includes group + global, ranked', () => {
    saveProcedure(
      makeProc({ name: 'global_low', success_count: 1, failure_count: 0 }),
    );
    saveProcedure(
      makeProc({
        name: 'group_high',
        success_count: 9,
        failure_count: 0,
        groupId,
      }),
    );
    const md = exportProceduresMarkdown({ groupId });
    const groupIdx = md.indexOf('group_high');
    const globalIdx = md.indexOf('global_low');
    expect(groupIdx).toBeGreaterThan(0);
    expect(globalIdx).toBeGreaterThan(0);
    expect(groupIdx).toBeLessThan(globalIdx);
  });
});

describe('writeProceduresMarkdown', () => {
  it('writes PROCEDURES.md to the group folder', () => {
    saveProcedure(makeProc({ name: 'p1', success_count: 3, groupId }));
    const filePath = writeProceduresMarkdown(groupId);
    expect(filePath).toBe(groupMdPath);
    const written = fs.readFileSync(filePath, 'utf-8');
    expect(written).toMatch(/## p1/);
  });
});
