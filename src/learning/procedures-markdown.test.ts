import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { saveProcedure, type Procedure } from '../memory/procedure-store.js';
import {
  discoverGroupsWithProcedures,
  exportProceduresMarkdown,
  rankProcedures,
  startProceduresMarkdownSchedule,
  writeAllProceduresMarkdown,
  writeProceduresMarkdown,
} from './procedures-markdown.js';

// Unique per-file groupId so parallel test files don't clobber each other.
// We deliberately do NOT touch STORE_DIR/procedures (the global procedure
// scope) because it's shared with src/memory/procedure-store.test.ts and
// cleaning it from here races their assertions.
const groupId = 'procedures_markdown_test';
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
  fs.mkdirSync(groupProcDir, { recursive: true });
  cleanDir(groupProcDir);
  if (fs.existsSync(groupMdPath)) fs.unlinkSync(groupMdPath);
});

afterEach(() => {
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
  it('returns empty placeholder when no procedures qualify', () => {
    // listProcedures merges in globals, which the parallel
    // procedure-store.test.ts churns. Force an empty result via a high
    // minRuns floor so the placeholder branch fires deterministically.
    const md = exportProceduresMarkdown({ minRuns: 1_000_000 });
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

  // Note: the previous "group + global, ranked" test was removed because
  // src/memory/procedure-store.test.ts wholesale-cleans the global procedures
  // dir between its own runs, which races any global write made here.
  // listProcedures' group+global merging is exercised in procedure-store.test;
  // this file just calls listProcedures, so further coverage here is redundant.
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

describe('discoverGroupsWithProcedures', () => {
  it('lists groups whose procedures dir contains an active .json file', () => {
    saveProcedure(makeProc({ name: 'p1', success_count: 1, groupId }));
    const found = discoverGroupsWithProcedures();
    expect(found).toContain(groupId);
  });

  it('skips groups with only .deprecated.json files', () => {
    // Write directly so deprecated state is the only artifact
    const onlyDeprecatedGroup = `${groupId}_only_dep`;
    const dir = path.join(GROUPS_DIR, onlyDeprecatedGroup, 'procedures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.deprecated.json'), '{}');
    try {
      const found = discoverGroupsWithProcedures();
      expect(found).not.toContain(onlyDeprecatedGroup);
    } finally {
      fs.rmSync(path.join(GROUPS_DIR, onlyDeprecatedGroup), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('writeAllProceduresMarkdown', () => {
  it('writes one PROCEDURES.md per discovered group', () => {
    saveProcedure(makeProc({ name: 'p1', success_count: 1, groupId }));
    const r = writeAllProceduresMarkdown();
    const ours = r.written.find((w) => w.groupId === groupId);
    expect(ours).toBeDefined();
    expect(ours!.filePath).toBe(groupMdPath);
    expect(fs.existsSync(groupMdPath)).toBe(true);
  });
});

describe('startProceduresMarkdownSchedule', () => {
  it('runs immediately by default and writes the file', () => {
    saveProcedure(makeProc({ name: 'p_sched', success_count: 1, groupId }));
    const stop = startProceduresMarkdownSchedule({
      intervalMs: 60_000_000, // big enough that the interval never fires in test
    });
    try {
      expect(fs.existsSync(groupMdPath)).toBe(true);
      const md = fs.readFileSync(groupMdPath, 'utf-8');
      expect(md).toMatch(/## p_sched/);
    } finally {
      stop();
    }
  });

  it('does not run immediately when runImmediately=false', () => {
    saveProcedure(
      makeProc({ name: 'p_no_immediate', success_count: 1, groupId }),
    );
    const stop = startProceduresMarkdownSchedule({
      intervalMs: 60_000_000,
      runImmediately: false,
    });
    try {
      expect(fs.existsSync(groupMdPath)).toBe(false);
    } finally {
      stop();
    }
  });

  it('stop() halts the timer (no further writes after stop)', async () => {
    const stop = startProceduresMarkdownSchedule({
      intervalMs: 50,
      runImmediately: false,
    });
    stop();
    if (fs.existsSync(groupMdPath)) fs.unlinkSync(groupMdPath);
    saveProcedure(makeProc({ name: 'p_after_stop', success_count: 1, groupId }));
    await new Promise((r) => setTimeout(r, 150));
    expect(fs.existsSync(groupMdPath)).toBe(false);
  });
});
