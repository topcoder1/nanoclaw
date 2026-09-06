// Lesson 2026-09-06: the launcher must never exec a dist/ that does not match
// src/. A box ran a dist/ built 2026-04-17 for five months while its src/
// carried the 2026-07-01 SSE reconnect-storm fix (#90): `git pull` updated
// src/, nothing rebuilt dist/, and every launchd restart (65 of them) reloaded
// the pre-fix build, which hammered the SuperPilot backend at ~80 connection
// attempts/s (~40 GB/day of egress, CloudWatch NetworkOut doubling every ~9
// days). `npm run build` now stamps dist/.src-hash with a content hash of the
// build inputs, and the launcher checks that stamp before exec — rebuilding
// when it is stale and refusing to start when the rebuild fails.
//
// The launcher tests below run the REAL NanoClaw.app/Contents/MacOS/NanoClaw
// script against a temporary tree (NANOCLAW_ROOT / NANOCLAW_NODE overrides),
// so the wiring — not just the helper — is what is pinned (helper-only tests
// pass while the launcher quietly stops calling the helper).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'dist-freshness.mjs');
const LAUNCHER = path.join(
  REPO,
  'NanoClaw.app',
  'Contents',
  'MacOS',
  'NanoClaw',
);

type Run = { code: number; out: string };

function runNode(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Run {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
    };
    if (typeof err.status !== 'number') throw e; // not an exit status: a real failure
    return {
      code: err.status,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

function check(root: string): Run {
  return runNode([SCRIPT, 'check', '--root', root]);
}
function stamp(root: string): Run {
  return runNode([SCRIPT, 'stamp', '--root', root]);
}

/** A minimal tree shaped like the repo: src/, tsconfig.json, dist/index.js. */
function makeTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoclaw-dist-fresh-'));
  mkdirSync(path.join(root, 'src', 'brain'), { recursive: true });
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const v = 1;\n');
  writeFileSync(
    path.join(root, 'src', 'brain', 'schema.sql'),
    'create table t(x);\n',
  );
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    '{ "compilerOptions": {} }\n',
  );
  writeFileSync(
    path.join(root, 'dist', 'index.js'),
    'console.log("started");\n',
  );
  return root;
}

let root: string;
beforeEach(() => {
  root = makeTree();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scripts/dist-freshness.mjs', () => {
  it('refuses a dist/ that carries no stamp (built by an older build script)', () => {
    const r = check(root);
    expect(r.code).toBe(3);
    expect(r.out).toContain('npm run build');
  });

  it('stamp then check passes, and the stamp is a sha256 hex digest', () => {
    expect(stamp(root).code).toBe(0);
    const recorded = readFileSync(
      path.join(root, 'dist', '.src-hash'),
      'utf8',
    ).trim();
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(check(root).code).toBe(0);
  });

  it('a source edit after the build makes the check fail as STALE', () => {
    stamp(root);
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export const v = 2;\n');
    const r = check(root);
    expect(r.code).toBe(4);
    expect(r.out).toContain('STALE');
  });

  it('a NEW source file after the build makes the check fail', () => {
    stamp(root);
    writeFileSync(
      path.join(root, 'src', 'added.ts'),
      'export const added = true;\n',
    );
    expect(check(root).code).toBe(4);
  });

  it('a non-.ts build input (schema.sql) and tsconfig.json both count', () => {
    stamp(root);
    writeFileSync(
      path.join(root, 'src', 'brain', 'schema.sql'),
      'create table t(x, y);\n',
    );
    expect(check(root).code).toBe(4);
    stamp(root);
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true } }\n',
    );
    expect(check(root).code).toBe(4);
  });

  it('a missing dist/index.js is refused even with a stamp present', () => {
    stamp(root);
    rmSync(path.join(root, 'dist', 'index.js'));
    expect(check(root).code).toBe(2);
  });

  it('the hash is deterministic across identical trees', () => {
    const other = makeTree();
    try {
      stamp(root);
      stamp(other);
      const a = readFileSync(path.join(root, 'dist', '.src-hash'), 'utf8');
      const b = readFileSync(path.join(other, 'dist', '.src-hash'), 'utf8');
      expect(a).toBe(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/**
 * Drive the real launcher. The temp tree gets the real freshness script and a
 * package.json whose `build` writes dist/index.js (or fails), then stamps —
 * so the launcher's rebuild/refuse decisions run end to end.
 */
function makeLaunchableTree(opts: { buildSucceeds: boolean }): string {
  mkdirSync(path.join(root, 'scripts'));
  cpSync(SCRIPT, path.join(root, 'scripts', 'dist-freshness.mjs'));
  const buildBody = opts.buildSucceeds
    ? [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('dist', { recursive: true });",
        "writeFileSync('dist/index.js', 'console.log(\"started\");\\n');",
        "writeFileSync('build-ran.marker', '1');",
      ].join('\n')
    : [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('build-ran.marker', '1');",
        'process.exit(1);',
      ].join('\n');
  writeFileSync(path.join(root, 'build.mjs'), `${buildBody}\n`);
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'launcher-fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
          build: 'node build.mjs && node scripts/dist-freshness.mjs stamp',
        },
      },
      null,
      2,
    ),
  );
  return root;
}

function runLauncher(): Run {
  try {
    const out = execFileSync('/bin/bash', [LAUNCHER], {
      cwd: root,
      env: {
        ...process.env,
        NANOCLAW_ROOT: root,
        NANOCLAW_NODE: process.execPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
    };
    if (typeof err.status !== 'number') throw e; // not an exit status: a real failure
    return {
      code: err.status,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

describe('NanoClaw.app launcher', () => {
  it('rebuilds a stale dist/ before starting, then starts', () => {
    makeLaunchableTree({ buildSucceeds: true });
    // dist/index.js exists but was never stamped → stale by definition.
    const r = runLauncher();
    expect(r.code).toBe(0);
    expect(r.out).toContain('started');
    expect(existsSync(path.join(root, 'build-ran.marker'))).toBe(true);
    expect(existsSync(path.join(root, 'dist', '.src-hash'))).toBe(true);
  });

  it('refuses to start when the rebuild fails (never execs a stale dist/)', () => {
    makeLaunchableTree({ buildSucceeds: false });
    const r = runLauncher();
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('started');
    expect(r.out).toContain('refusing to start');
    expect(existsSync(path.join(root, 'build-ran.marker'))).toBe(true);
  });

  it('starts a fresh dist/ without rebuilding', () => {
    makeLaunchableTree({ buildSucceeds: true });
    expect(stamp(root).code).toBe(0);
    const r = runLauncher();
    expect(r.code).toBe(0);
    expect(r.out).toContain('started');
    expect(existsSync(path.join(root, 'build-ran.marker'))).toBe(false);
  });

  it('the checked-in build script ends with the stamp step', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    expect(
      pkg.scripts.build.endsWith('node scripts/dist-freshness.mjs stamp'),
    ).toBe(true);
  });
});
