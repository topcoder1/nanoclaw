import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from '../config.js';
import { saveProcedure, type Procedure } from '../memory/procedure-store.js';
import { acceptCandidate, readCandidate } from './accept-candidate.js';

// Unique per-file groupId so parallel test files don't clobber each other
// in groups/<id>/procedures/ on the real fs.
const groupId = 'accept_candidate_test';
const groupProcDir = path.join(GROUPS_DIR, groupId, 'procedures');
const candidatesRoot = path.join(STORE_DIR, 'consolidation-candidates');

function rmrf(p: string): void {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
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
    trigger: 't',
    description: 'd',
    steps: [{ action: 'a' }],
    success_count: 1,
    failure_count: 0,
    auto_execute: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function writeCandidate(
  ts: string,
  fileName: string,
  payload: { proposed: Procedure; replaces: Procedure[] },
): string {
  const dir = path.join(candidatesRoot, ts);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

beforeEach(() => {
  fs.mkdirSync(groupProcDir, { recursive: true });
  cleanDir(groupProcDir);
  rmrf(candidatesRoot);
});

afterEach(() => {
  cleanDir(groupProcDir);
  rmrf(candidatesRoot);
});

describe('readCandidate', () => {
  it('throws when file missing', () => {
    expect(() => readCandidate('/no/such/file.json')).toThrow(/not found/);
  });

  it('throws on invalid JSON', () => {
    const dir = path.join(candidatesRoot, 'x');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, 'not json');
    expect(() => readCandidate(p)).toThrow(/parse failed/);
  });

  it('throws when proposed is missing', () => {
    const p = writeCandidate('ts1', 'c.json', {
      proposed: undefined as unknown as Procedure,
      replaces: [],
    });
    expect(() => readCandidate(p)).toThrow(/missing `proposed`/);
  });

  it('throws when replaces is not an array', () => {
    const dir = path.join(candidatesRoot, 'ts2');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'c.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ proposed: makeProc(), replaces: 'oops' }),
    );
    expect(() => readCandidate(p)).toThrow(/missing `replaces`/);
  });

  it('parses a valid candidate', () => {
    const proposed = makeProc({ name: 'merged', groupId });
    const replaces = [makeProc({ name: 'old1', groupId })];
    const p = writeCandidate('ts3', 'c.json', { proposed, replaces });
    const out = readCandidate(p);
    expect(out.proposed.name).toBe('merged');
    expect(out.replaces).toHaveLength(1);
  });
});

describe('acceptCandidate', () => {
  it('saves proposed and deprecates originals', () => {
    saveProcedure(
      makeProc({ name: 'old_a', steps: [{ action: 'x' }], groupId }),
    );
    saveProcedure(
      makeProc({ name: 'old_b', steps: [{ action: 'x' }], groupId }),
    );
    const proposed = makeProc({
      name: 'merged_x',
      steps: [{ action: 'x' }],
      groupId,
    });
    const replaces = [
      makeProc({ name: 'old_a', steps: [{ action: 'x' }], groupId }),
      makeProc({ name: 'old_b', steps: [{ action: 'x' }], groupId }),
    ];
    const candidatePath = writeCandidate('tsA', 'merged_x.json', {
      proposed,
      replaces,
    });

    const result = acceptCandidate(candidatePath);

    expect(result.proposedName).toBe('merged_x');
    expect(result.deprecated.sort()).toEqual(['old_a', 'old_b']);
    expect(result.missing).toEqual([]);

    const remaining = fs.readdirSync(groupProcDir).sort();
    expect(remaining).toContain('merged_x.json');
    expect(remaining).toContain('old_a.deprecated.json');
    expect(remaining).toContain('old_b.deprecated.json');
    expect(remaining).not.toContain('old_a.json');
    expect(remaining).not.toContain('old_b.json');
  });

  it('reports missing originals without failing the accept', () => {
    // Only old_a exists on disk — old_b is in the candidate but not on disk
    saveProcedure(
      makeProc({ name: 'old_a', steps: [{ action: 'x' }], groupId }),
    );
    const proposed = makeProc({ name: 'merged_y', groupId });
    const replaces = [
      makeProc({ name: 'old_a', groupId }),
      makeProc({ name: 'old_b_gone', groupId }),
    ];
    const candidatePath = writeCandidate('tsB', 'merged_y.json', {
      proposed,
      replaces,
    });

    const result = acceptCandidate(candidatePath);

    expect(result.deprecated).toEqual(['old_a']);
    expect(result.missing).toEqual(['old_b_gone']);
  });

  it('refuses when proposed name collides with a replacee in the same group', () => {
    const proposed = makeProc({ name: 'p1', groupId });
    const replaces = [makeProc({ name: 'p1', groupId })];
    const candidatePath = writeCandidate('tsC', 'p1.json', {
      proposed,
      replaces,
    });
    expect(() => acceptCandidate(candidatePath)).toThrow(/collides/);
  });

  it('does not touch fs in dry-run', () => {
    saveProcedure(
      makeProc({ name: 'old_a', steps: [{ action: 'x' }], groupId }),
    );
    const proposed = makeProc({ name: 'merged_dry', groupId });
    const replaces = [makeProc({ name: 'old_a', groupId })];
    const candidatePath = writeCandidate('tsD', 'merged_dry.json', {
      proposed,
      replaces,
    });

    const result = acceptCandidate(candidatePath, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deprecated).toEqual([]);
    expect(result.missing).toEqual(['old_a']);

    const remaining = fs.readdirSync(groupProcDir).sort();
    expect(remaining).toEqual(['old_a.json']);
  });
});
