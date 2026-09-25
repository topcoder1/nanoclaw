import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncAgentRunnerSrc } from './agent-runner-sync.js';

// Real files in a temp dir: the bug was in how file times and copies
// interact, which a mocked fs would hide.
let root: string;
let src: string;
let dest: string;

// When the source was checked out, well before any copy.
const CHECKOUT = new Date('2026-01-01T00:00:00Z');

function write(file: string, text: string, mtime?: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

// A time after the first copy, as a `git pull` of the source would give it.
function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-sync-'));
  src = path.join(root, 'container', 'agent-runner', 'src');
  dest = path.join(root, 'data', 'sessions', 'group', 'agent-runner-src');
  write(path.join(src, 'index.ts'), 'index v1', CHECKOUT);
  write(path.join(src, 'gmail-tools.ts'), 'gmail-tools v1', CHECKOUT);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('syncAgentRunnerSrc', () => {
  it('copies the runner source into a new group cache', () => {
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'index.ts'))).toBe('index v1');
    expect(read(path.join(dest, 'gmail-tools.ts'))).toBe('gmail-tools v1');
  });

  it('re-copies when a file other than index.ts changes', () => {
    syncAgentRunnerSrc(src, dest);
    write(
      path.join(src, 'gmail-tools.ts'),
      'gmail-tools v2',
      minutesFromNow(1),
    );
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'gmail-tools.ts'))).toBe('gmail-tools v2');
  });

  it('removes a file deleted from the source, which the entrypoint would still compile', () => {
    write(path.join(src, 'old-tool.ts'), 'old tool', CHECKOUT);
    syncAgentRunnerSrc(src, dest);
    fs.rmSync(path.join(src, 'old-tool.ts'));
    syncAgentRunnerSrc(src, dest);
    expect(fs.existsSync(path.join(dest, 'old-tool.ts'))).toBe(false);
    expect(read(path.join(dest, 'index.ts'))).toBe('index v1');
  });

  it("does not let an agent's edit to its own copy pin a stale runner", () => {
    syncAgentRunnerSrc(src, dest);
    // A deploy changes index.ts, then an agent still running on the old copy
    // edits its /app/src/index.ts, so its copy is newer than the source.
    write(path.join(src, 'index.ts'), 'index v2', minutesFromNow(1));
    write(path.join(dest, 'index.ts'), 'agent edit', minutesFromNow(2));
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'index.ts'))).toBe('index v2');
  });

  it('re-copies a cache an older host made, with no record of its source', () => {
    write(path.join(dest, 'index.ts'), 'index v0');
    write(path.join(dest, 'gmail-tools.ts'), 'gmail-tools v0');
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'gmail-tools.ts'))).toBe('gmail-tools v1');
  });

  it("keeps an agent's changes to its copy while the source is unchanged", () => {
    syncAgentRunnerSrc(src, dest);
    write(path.join(dest, 'index.ts'), 'agent edit');
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'index.ts'))).toBe('agent edit');
  });

  it('restores a cached index.ts that has gone missing', () => {
    syncAgentRunnerSrc(src, dest);
    fs.rmSync(path.join(dest, 'index.ts'));
    syncAgentRunnerSrc(src, dest);
    expect(read(path.join(dest, 'index.ts'))).toBe('index v1');
  });
});
