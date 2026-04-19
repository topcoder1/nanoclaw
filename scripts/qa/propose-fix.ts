/**
 * QA auto-propose-fix — Week 3 of the QA autopilot plan.
 *
 * Given one or more failed invariants/scenarios, this script:
 *   1. Allocates a git worktree under .claude/worktrees/qa-fix-<id>.
 *   2. Dispatches a Claude Code agent (shell-out to `claude -p`) with
 *      the failure report and guardrails: diagnose, fix, add regression
 *      guard, commit on branch `qa/fix-<slug>`. Must not push.
 *   3. After the agent returns, runs `npm run build && npm test` in the
 *      worktree — blocks the proposal if tests are red.
 *   4. Classifies risk (LOW/MED/HIGH) from the diff.
 *   5. Pushes the branch to origin.
 *   6. Posts a Telegram approval card with [✓ Merge] [✕ Close] [🔍 Details].
 *   7. Persists proposal state to data/qa-proposals/<id>.json.
 *
 * ZERO unattended merges. [✓ Merge] routes through callback-router.ts
 * which runs `git merge --ff-only` + push + service restart only after
 * the user taps.
 *
 * Usage:
 *   echo '{...failure report...}' | npm run qa:propose-fix
 *   npm run qa:propose-fix -- --failure /path/to/failure.json
 *
 * Gating:
 *   QA_PROPOSE_FIX_DISABLED=1  skip (maintenance)
 *   QA_PROPOSE_FIX_DRY_RUN=1   run agent + classify but don't push / post
 */
import { execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvValue } from '../../src/env.js';

interface FailureReport {
  source: 'invariants' | 'scenarios';
  failures: Array<{
    name: string;
    message: string;
    category?: string;
    details?: unknown;
  }>;
}

interface Proposal {
  id: string;
  createdAt: number;
  failureReport: FailureReport;
  worktreePath: string;
  branch: string;
  risk: 'LOW' | 'MED' | 'HIGH';
  diffStat: { files: number; insertions: number; deletions: number };
  agentTranscriptPath: string;
  testStatus: 'pass' | 'fail' | 'skipped';
  proposedAt: number;
  pushed: boolean;
  blocked?: boolean;
  blockedReasons?: string[];
}

interface GuardrailCheck {
  blocked: boolean;
  reasons: string[];
}

/**
 * Paths where an auto-generated diff is NEVER auto-mergeable, regardless
 * of test result. Rationale per entry:
 *   - scripts/qa/**          an AI that's grading itself can weaken the graders
 *   - **\/\*.test.ts          tests can be relaxed to make red turn green
 *   - .env*                  credentials surface
 *   - container/             container recipe — affects every agent run
 *   - src/channels/registry  channel fan-in — breakage is cross-cutting
 *   - package(-lock).json    dependency supply chain
 *   - .github/workflows/     CI surface — same self-grading concern
 *   - .claude/               ops/worktree metadata
 *
 * src/db.ts is intentionally NOT here — benign query helpers are fine to
 * auto-merge. The migrations gate (DDL_PATTERN check) handles the actual
 * danger: schema changes that need human review.
 */
const PROTECTED_PATHS: RegExp[] = [
  /^scripts\/qa\//,
  /\.test\.ts$/,
  /^\.env($|\.)/,
  /^container\//,
  /^src\/channels\/registry\.ts$/,
  /^package(-lock)?\.json$/,
  /^\.github\/workflows\//,
  /^\.claude\//,
];

/**
 * SQL DDL pattern for the migrations gate. Matched against added diff
 * lines (not removed lines — removing a CREATE TABLE happens when a
 * migration moves). Triggers on any *.ts file, not just src/db.ts, so
 * migration helpers stashed elsewhere are also caught.
 */
const DDL_PATTERN =
  /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TRIGGER|UNIQUE)\b/i;

const REPO = path.resolve('.');
const PROPOSALS_DIR = path.join(REPO, 'data/qa-proposals');
const WORKTREES_DIR = path.join(REPO, '.claude/worktrees');

function shortId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function slug(failures: FailureReport['failures']): string {
  const first = failures[0]?.name ?? 'multi';
  return first.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
}

function readFailureReport(): FailureReport {
  const argIdx = process.argv.indexOf('--failure');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const raw = fs.readFileSync(process.argv[argIdx + 1], 'utf-8');
    return JSON.parse(raw) as FailureReport;
  }
  // Read from stdin.
  const raw = fs.readFileSync(0, 'utf-8');
  return JSON.parse(raw) as FailureReport;
}

function allocateWorktree(id: string): { worktreePath: string; branch: string } {
  const worktreePath = path.join(WORKTREES_DIR, `qa-fix-${id}`);
  const branch = `qa/fix-${id}`;
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  execSync(
    `git worktree add -b ${branch} "${worktreePath}" HEAD`,
    { cwd: REPO, stdio: 'inherit' },
  );
  return { worktreePath, branch };
}

function removeWorktree(worktreePath: string, branch: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: REPO,
      stdio: 'inherit',
    });
  } catch {
    /* best effort */
  }
  try {
    execSync(`git branch -D ${branch}`, { cwd: REPO, stdio: 'inherit' });
  } catch {
    /* best effort */
  }
}

function buildAgentPrompt(fr: FailureReport, branch: string): string {
  const failureDump = fr.failures
    .map(
      (f, i) =>
        `${i + 1}. [${f.category ?? 'qa'}] ${f.name}: ${f.message}\n   details: ${JSON.stringify(f.details ?? {}, null, 2)}`,
    )
    .join('\n\n');
  return `You are a QA fix agent. The nanoclaw QA autopilot detected the following
invariant/scenario failure(s). Your job: diagnose the root cause, implement the
minimal fix, and commit it on the current branch (${branch}). Do NOT push. The
user will review your diff via a Telegram approval card.

# Failures

${failureDump}

# Operating rules

- You are running in an isolated git worktree. The working tree is a full
  checkout of the main branch with the new branch ${branch} checked out.
- Prefer the SMALLEST possible diff that fixes the root cause. Don't
  refactor. Don't add unrelated cleanup.
- Always add or update a regression guard — either a scripts/qa/scenarios/*.json
  scenario, a new invariant in scripts/qa/invariants.ts, or a vitest unit test.
- Keep commit count to ONE. Use a commit message that describes the fix and
  references the failing invariant/scenario name.
- Do not modify .env, package-lock.json, or anything in container/, store/,
  data/, or logs/.
- Do NOT run git push. Leave the branch local.
- When done, run \`npm run build && npm test -- --run\` and confirm clean
  before your final commit.

# Reference material

- Plan: docs/superpowers/plans/2026-04-17-qa-autopilot.md
- Invariants runner: scripts/qa/invariants.ts
- Scenarios runner: scripts/qa/scenarios.ts
- Production guardrails: NEVER auto-archive emails, see groups/global/CLAUDE.md

Start by exploring the relevant files, then write a minimal fix. Stay under
15 turns.
`;
}

function runAgent(
  worktreePath: string,
  prompt: string,
  transcriptPath: string,
): void {
  // Shell out to Claude Code CLI in print mode. --output-format json so
  // the transcript is structured; we persist it for the [🔍 Details]
  // button.
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const promptFile = path.join(worktreePath, '.qa-fix-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  const proc = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      '15',
      '--permission-mode',
      'acceptEdits',
    ],
    {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    },
  );
  fs.writeFileSync(transcriptPath, proc.stdout + '\n\n--- STDERR ---\n' + proc.stderr);
  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* ignore */
  }
}

function diffStat(
  worktreePath: string,
): { files: number; insertions: number; deletions: number } {
  try {
    const out = execSync(
      `git diff --shortstat HEAD~1 2>/dev/null || git diff --shortstat HEAD`,
      { cwd: worktreePath, encoding: 'utf-8' },
    ).trim();
    // Example: " 2 files changed, 15 insertions(+), 3 deletions(-)"
    const files = Number(/(\d+) files? changed/.exec(out)?.[1] ?? 0);
    const insertions = Number(/(\d+) insertions?/.exec(out)?.[1] ?? 0);
    const deletions = Number(/(\d+) deletions?/.exec(out)?.[1] ?? 0);
    return { files, insertions, deletions };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

function changedFiles(worktreePath: string): string[] {
  try {
    return execSync(`git diff --name-only HEAD~1 2>/dev/null || git diff --name-only HEAD`, {
      cwd: worktreePath,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Guardrails run BEFORE push and BEFORE the approval card. A blocked
 * proposal is NOT pushed to origin and NOT offered for one-tap merge —
 * the card that's posted has no merge button, only a pointer at the
 * local worktree for manual inspection. Unlike classifyRisk (which
 * merely adjusts the risk label on the card), this function is the
 * hard gate.
 */
export function checkGuardrails(
  files: string[],
  worktreePath: string,
): GuardrailCheck {
  const reasons: string[] = [];

  const hitProtected = files.filter((f) =>
    PROTECTED_PATHS.some((re) => re.test(f)),
  );
  if (hitProtected.length > 0) {
    reasons.push(`protected path(s): ${hitProtected.join(', ')}`);
  }

  // Migration gate: DDL in added lines of any *.ts file.
  const tsFiles = files.filter((f) => f.endsWith('.ts'));
  for (const f of tsFiles) {
    let diff = '';
    try {
      diff = execSync(`git diff main -- ${JSON.stringify(f)}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      continue; // diff failed — don't block on a tooling issue
    }
    const addedLines = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    if (addedLines.some((l) => DDL_PATTERN.test(l))) {
      reasons.push(`DDL (schema change) detected in ${f}`);
    }
  }

  return { blocked: reasons.length > 0, reasons };
}

function classifyRisk(
  files: string[],
  stat: { files: number; insertions: number; deletions: number },
): 'LOW' | 'MED' | 'HIGH' {
  if (files.length === 0) return 'LOW'; // empty diff
  const HIGH_SURFACES = [
    /^src\/index\.ts$/,
    /^src\/container-runner\.ts$/,
    /^src\/db\.ts$/,
    /^src\/channels\//,
  ];
  if (files.some((f) => HIGH_SURFACES.some((re) => re.test(f)))) return 'HIGH';
  const LOW_SURFACES = [/^docs\//, /^scripts\/qa\//, /\.test\.ts$/, /^\.gitignore$/];
  const allLow = files.every((f) => LOW_SURFACES.some((re) => re.test(f)));
  if (allLow) return 'LOW';
  if (stat.files > 3 || stat.insertions + stat.deletions > 100) return 'HIGH';
  return 'MED';
}

function runBuildAndTest(worktreePath: string): 'pass' | 'fail' {
  try {
    execSync('npm run build', { cwd: worktreePath, stdio: 'ignore' });
  } catch {
    return 'fail';
  }
  try {
    execSync('npm test -- --run', {
      cwd: worktreePath,
      stdio: 'ignore',
      timeout: 5 * 60 * 1000,
    });
    return 'pass';
  } catch {
    return 'fail';
  }
}

function pushBranch(worktreePath: string, branch: string): boolean {
  try {
    execSync(`git push -u origin ${branch}`, {
      cwd: worktreePath,
      stdio: 'inherit',
    });
    return true;
  } catch {
    return false;
  }
}

async function sendTelegram(
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<number | null> {
  const token = readEnvValue('TELEGRAM_BOT_TOKEN');
  if (!token) return null;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const j = (await res.json()) as { result?: { message_id: number } };
  return j.result?.message_id ?? null;
}

function formatCard(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`🧪 *QA autopilot proposed a fix*`);
  lines.push('');
  lines.push(`*Failure:* ${p.failureReport.failures[0]?.name ?? '(multi)'}`);
  if (p.failureReport.failures.length > 1) {
    lines.push(`+ ${p.failureReport.failures.length - 1} more`);
  }
  lines.push(`*Branch:* \`${p.branch}\``);
  lines.push(
    `*Diff:* +${p.diffStat.insertions}  −${p.diffStat.deletions}  across ${p.diffStat.files} file(s)`,
  );
  lines.push(`*Risk:* ${p.risk}`);
  lines.push(`*Tests:* ${p.testStatus}`);
  lines.push(
    `*ID:* \`${p.id}\` · tap ✓ to fast-forward \`main\` + restart service`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (readEnvValue('QA_PROPOSE_FIX_DISABLED') === '1') {
    process.stdout.write('qa-propose-fix: disabled\n');
    process.exit(0);
  }
  const dryRun = readEnvValue('QA_PROPOSE_FIX_DRY_RUN') === '1';

  const failureReport = readFailureReport();
  if (failureReport.failures.length === 0) {
    process.stdout.write('qa-propose-fix: no failures provided, nothing to do\n');
    process.exit(0);
  }

  const id = shortId();
  const transcriptPath = path.join(PROPOSALS_DIR, `${id}.transcript.txt`);

  let worktreePath = '';
  let branch = '';
  try {
    ({ worktreePath, branch } = allocateWorktree(id));

    const prompt = buildAgentPrompt(failureReport, branch);
    process.stdout.write(`qa-propose-fix: dispatching agent in ${worktreePath}\n`);
    runAgent(worktreePath, prompt, transcriptPath);

    const files = changedFiles(worktreePath);
    const stat = diffStat(worktreePath);
    if (files.length === 0) {
      process.stdout.write('qa-propose-fix: agent produced empty diff\n');
      removeWorktree(worktreePath, branch);
      const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
      if (chatId && !dryRun) {
        await sendTelegram(
          chatId,
          `🤷 *QA autopilot: couldn't produce a fix*\nFailure: \`${failureReport.failures[0]?.name}\`\nAgent transcript: \`${transcriptPath}\``,
        );
      }
      process.exit(0);
    }

    const testStatus = runBuildAndTest(worktreePath);
    const guardrails = checkGuardrails(files, worktreePath);
    // Blocked proposals are ALWAYS reported as HIGH regardless of size —
    // they're for manual inspection, and we don't want a small-looking
    // diff to mislead the reviewer.
    const risk = guardrails.blocked ? 'HIGH' : classifyRisk(files, stat);

    // Guardrail hits suppress push (and the approval card). Tests still
    // run above so the manual-review card can report the status.
    let pushed = false;
    if (testStatus === 'pass' && !dryRun && !guardrails.blocked) {
      pushed = pushBranch(worktreePath, branch);
    }

    const proposal: Proposal = {
      id,
      createdAt: Date.now(),
      failureReport,
      worktreePath,
      branch,
      risk,
      diffStat: stat,
      agentTranscriptPath: transcriptPath,
      testStatus,
      proposedAt: Date.now(),
      pushed,
      ...(guardrails.blocked
        ? { blocked: true, blockedReasons: guardrails.reasons }
        : {}),
    };
    fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROPOSALS_DIR, `${id}.json`),
      JSON.stringify(proposal, null, 2),
    );

    const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');

    if (guardrails.blocked) {
      // No merge button — a blocked diff must never be one-tap mergeable.
      // Worktree is retained so the user can `cd` in and review / fix / merge
      // by hand; they can also tap Close to clean up.
      const lines: string[] = [];
      lines.push(`🛡️ *QA autopilot: manual review required*`);
      lines.push('');
      lines.push(
        `*Failure:* ${failureReport.failures[0]?.name ?? '(multi)'}`,
      );
      lines.push(`*Blocked by:*`);
      for (const r of guardrails.reasons) lines.push(`  • ${r}`);
      lines.push(
        `*Diff:* +${stat.insertions}  −${stat.deletions}  across ${stat.files} file(s)`,
      );
      lines.push(`*Tests:* ${testStatus}`);
      lines.push(`*Worktree:* \`${worktreePath}\``);
      lines.push(`*ID:* \`${id}\``);
      if (chatId && !dryRun) {
        await sendTelegram(chatId, lines.join('\n'), {
          inline_keyboard: [
            [
              { text: '✕ Close', callback_data: `qa:close:${id}` },
              { text: '🔍 Details', callback_data: `qa:details:${id}` },
            ],
          ],
        });
      }
      process.stdout.write(
        `qa-propose-fix: proposal ${id} BLOCKED (${guardrails.reasons.join('; ')}), tests=${testStatus}\n`,
      );
      process.exit(0);
    }

    if (!pushed) {
      // Tests failed or dry-run.
      if (chatId && !dryRun) {
        await sendTelegram(
          chatId,
          `⚠️ *QA autopilot: fix drafted but tests ${testStatus === 'pass' ? 'passed, push failed' : 'failed'}*\nBranch: \`${branch}\` (local only)\nID: \`${id}\`\nTranscript: \`${transcriptPath}\``,
        );
      } else if (dryRun) {
        process.stdout.write(
          `qa-propose-fix: DRY RUN — would post card for proposal ${id}, risk=${risk}, tests=${testStatus}\n`,
        );
      }
      process.exit(0);
    }

    if (chatId) {
      const card = formatCard(proposal);
      await sendTelegram(chatId, card, {
        inline_keyboard: [
          [
            { text: '✓ Merge', callback_data: `qa:merge:${id}` },
            { text: '✕ Close', callback_data: `qa:close:${id}` },
            { text: '🔍 Details', callback_data: `qa:details:${id}` },
          ],
        ],
      });
    }
    process.stdout.write(
      `qa-propose-fix: proposal ${id} posted, risk=${risk}, tests=${testStatus}\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `qa-propose-fix: crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    if (worktreePath && branch) {
      removeWorktree(worktreePath, branch);
    }
    process.exit(2);
  }
}

// Only auto-run when invoked as a script, so test harnesses can import
// checkGuardrails without triggering the full agent pipeline.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main();
}
