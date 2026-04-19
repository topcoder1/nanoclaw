/**
 * One-off verification: exercises checkGuardrails() against fabricated
 * inputs. Not a vitest test (scripts/ isn't in the test glob) — run with
 *   npx tsx scripts/qa/propose-fix-guardrails.verify.ts
 *
 * After we're satisfied the logic holds, this file can stay as living
 * doc or be deleted. It's not wired into CI.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGuardrails } from './propose-fix.js';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-guard-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'placeholder.ts'), '// seed\n');
  execSync('git add .', { cwd: dir });
  execSync('git commit -qm seed', { cwd: dir });
  execSync('git branch -M main', { cwd: dir });
  execSync('git checkout -qb feature', { cwd: dir });
  return dir;
}

let failures = 0;
function assert(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    process.stdout.write(
      `  ✗ ${label}${extra ? ` — ${JSON.stringify(extra)}` : ''}\n`,
    );
    failures++;
  }
}

// ── Case 1: benign src/*.ts change — not blocked ─────────────────────────
{
  process.stdout.write('\nCase 1: benign src/triage/config.ts edit\n');
  const repo = makeTempRepo();
  const target = path.join(repo, 'src/triage');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, 'config.ts'),
    'export const FOO = 42;\n',
  );
  execSync('git add .', { cwd: repo });
  execSync('git commit -qm edit', { cwd: repo });
  const r = checkGuardrails(['src/triage/config.ts'], repo);
  assert('not blocked', !r.blocked, r.reasons);
}

// ── Case 2: scripts/qa/ touched — blocked ────────────────────────────────
{
  process.stdout.write('\nCase 2: scripts/qa/invariants.ts edit\n');
  const repo = makeTempRepo();
  const r = checkGuardrails(['scripts/qa/invariants.ts'], repo);
  assert('blocked', r.blocked);
  assert(
    'reason mentions protected',
    r.reasons.some((s) => s.includes('protected')),
    r.reasons,
  );
}

// ── Case 3: *.test.ts touched — blocked ──────────────────────────────────
{
  process.stdout.write('\nCase 3: src/__tests__/foo.test.ts edit\n');
  const repo = makeTempRepo();
  const r = checkGuardrails(['src/__tests__/foo.test.ts'], repo);
  assert('blocked', r.blocked);
}

// ── Case 4: package.json touched — blocked ───────────────────────────────
{
  process.stdout.write('\nCase 4: package.json edit\n');
  const repo = makeTempRepo();
  const r = checkGuardrails(['package.json'], repo);
  assert('blocked', r.blocked);
}

// ── Case 5: src/db.ts with DDL — blocked via migrations gate ─────────────
{
  process.stdout.write('\nCase 5: src/db.ts adds CREATE TABLE\n');
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src/db.ts'),
    "db.exec('CREATE TABLE foo (id INTEGER);');\n",
  );
  execSync('git add .', { cwd: repo });
  execSync('git commit -qm ddl', { cwd: repo });
  const r = checkGuardrails(['src/db.ts'], repo);
  assert('blocked', r.blocked);
  assert(
    'reason mentions DDL',
    r.reasons.some((s) => s.includes('DDL')),
    r.reasons,
  );
}

// ── Case 6: src/db.ts with benign query helper — NOT blocked ─────────────
{
  process.stdout.write('\nCase 6: src/db.ts adds a prepared statement (no DDL)\n');
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src/db.ts'),
    "export function getThing(id: string) { return db.prepare('SELECT * FROM t WHERE id = ?').get(id); }\n",
  );
  execSync('git add .', { cwd: repo });
  execSync('git commit -qm helper', { cwd: repo });
  const r = checkGuardrails(['src/db.ts'], repo);
  assert('not blocked', !r.blocked, r.reasons);
}

// ── Case 7: DDL hidden in some other .ts file — blocked ──────────────────
{
  process.stdout.write('\nCase 7: src/migrate.ts adds ALTER TABLE\n');
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src/migrate.ts'),
    "db.exec('ALTER TABLE foo ADD COLUMN bar TEXT;');\n",
  );
  execSync('git add .', { cwd: repo });
  execSync('git commit -qm migrate', { cwd: repo });
  const r = checkGuardrails(['src/migrate.ts'], repo);
  assert('blocked', r.blocked);
}

// ── Case 8: .env touched — blocked ───────────────────────────────────────
{
  process.stdout.write('\nCase 8: .env edit\n');
  const repo = makeTempRepo();
  const r = checkGuardrails(['.env'], repo);
  assert('blocked', r.blocked);
}

// ── Case 9: multiple files, one protected — blocked ──────────────────────
{
  process.stdout.write('\nCase 9: mixed src/ + scripts/qa/ — partial protect\n');
  const repo = makeTempRepo();
  const r = checkGuardrails(
    ['src/router.ts', 'scripts/qa/scenarios.ts'],
    repo,
  );
  assert('blocked', r.blocked);
  assert(
    'reason names only the protected file',
    r.reasons[0]!.includes('scripts/qa/scenarios.ts') &&
      !r.reasons[0]!.includes('router.ts'),
    r.reasons,
  );
}

process.stdout.write(
  `\n${failures === 0 ? '✓ all guardrail cases passed' : `✗ ${failures} case(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
