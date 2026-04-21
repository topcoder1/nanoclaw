import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warnSpy = vi.fn();

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  DEFAULT_BLOCKLIST,
  isBlocklisted,
  loadBlocklist,
} from '../junk-reaper-blocklist.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-blocklist-'));
  warnSpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DEFAULT_BLOCKLIST', () => {
  it('is non-empty and contains critical seeded patterns', () => {
    expect(DEFAULT_BLOCKLIST.length).toBeGreaterThan(0);
    expect(DEFAULT_BLOCKLIST).toContain('*@github.com');
    expect(DEFAULT_BLOCKLIST).toContain('*@usbank.com');
    expect(DEFAULT_BLOCKLIST).toContain('*@stripe.com');
    expect(DEFAULT_BLOCKLIST).toContain('*@attaxion.com');
  });
});

describe('loadBlocklist', () => {
  it('missing file → returns defaults', () => {
    const missing = path.join(tmpDir, 'nope.json');
    const result = loadBlocklist(missing);
    expect(result).toEqual(expect.arrayContaining(DEFAULT_BLOCKLIST));
    expect(result.length).toBe(DEFAULT_BLOCKLIST.length);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('malformed JSON → warn + defaults', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ this is not json');
    const result = loadBlocklist(p);
    expect(result).toEqual(expect.arrayContaining(DEFAULT_BLOCKLIST));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('non-array JSON → warn + defaults', () => {
    const p = path.join(tmpDir, 'obj.json');
    fs.writeFileSync(p, JSON.stringify({ patterns: ['*@foo.com'] }));
    const result = loadBlocklist(p);
    expect(result).toEqual(expect.arrayContaining(DEFAULT_BLOCKLIST));
    expect(result).not.toContain('*@foo.com');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('well-formed user file → defaults + user patterns (dedup)', () => {
    const p = path.join(tmpDir, 'ok.json');
    // Include one duplicate of a default to verify dedup
    fs.writeFileSync(
      p,
      JSON.stringify(['*@mycompany.example', '*@github.com']),
    );
    const result = loadBlocklist(p);
    expect(result).toContain('*@mycompany.example');
    expect(result).toContain('*@github.com');
    // Dedup: '*@github.com' should appear exactly once
    const occurrences = result.filter((x) => x === '*@github.com').length;
    expect(occurrences).toBe(1);
    // Total = defaults + 1 new user pattern
    expect(result.length).toBe(DEFAULT_BLOCKLIST.length + 1);
  });
});

describe('isBlocklisted', () => {
  const patterns = ['*@github.com', '*@*.stripe.com', '*@usbank.com'];

  const cases: Array<{ from: string | undefined; expected: boolean; desc: string }> = [
    { from: 'GitHub <noreply@github.com>', expected: true, desc: 'bracket form' },
    { from: 'noreply@github.com', expected: true, desc: 'raw email' },
    { from: 'NoReply@GitHub.com', expected: true, desc: 'case-insensitive' },
    { from: 'foo@notifications.stripe.com', expected: true, desc: 'subdomain wildcard match' },
    { from: 'foo@stripe.com', expected: false, desc: '*@*.stripe.com does not match bare domain' },
    { from: 'x@example.com', expected: false, desc: 'non-match' },
    { from: 'x@usbank.com.evil.com', expected: false, desc: 'suffix-attack rejected' },
    { from: 'x@evil-github.com', expected: false, desc: 'no dot boundary rejected' },
    { from: undefined, expected: true, desc: 'undefined → safe true' },
    { from: '', expected: true, desc: 'empty → safe true' },
    { from: 'not an email', expected: true, desc: 'unparseable → safe true' },
  ];

  for (const c of cases) {
    it(`${c.desc}: ${JSON.stringify(c.from)} → ${c.expected}`, () => {
      expect(isBlocklisted(c.from, patterns)).toBe(c.expected);
    });
  }
});
