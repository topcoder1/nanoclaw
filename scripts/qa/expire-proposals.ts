/**
 * QA autopilot — auto-expire stuck proposals.
 *
 * Runs on a cron (see com.nanoclaw.qa-expire-proposals.plist). Scans
 * data/qa-proposals/*.json, finds unresolved proposals where
 * `now > expiresAt`, removes the associated worktree + branches, and
 * marks the proposal `resolution: 'expired'`.
 *
 * Invariants:
 *   - Never touches a proposal with a resolvedAt or resolution field.
 *   - Never re-expires (resolution === 'expired' means already done).
 *   - Worktree/branch cleanup is best-effort; a missing worktree is
 *     fine (already cleaned up manually), and we still mark expired.
 *   - Legacy proposals without an `expiresAt` field derive one from
 *     createdAt + QA_PROPOSAL_TTL_MS so old records don't linger.
 *
 * Usage:
 *   npm run qa:expire-proposals            normal run
 *   QA_EXPIRE_DRY_RUN=1 npm run qa:…       log-only, no side effects
 *   QA_EXPIRE_DISABLED=1 npm run qa:…      skip entirely (maintenance)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvValue } from '../../src/env.js';
import {
  QA_PROPOSAL_TTL_MS,
  type QaProposal,
} from '../../src/qa-proposal-types.js';

const REPO = path.resolve('.');
const PROPOSALS_DIR = path.join(REPO, 'data/qa-proposals');

type StoredProposal = Partial<QaProposal> &
  Pick<QaProposal, 'id' | 'worktreePath' | 'branch'>;

function loadProposal(file: string): StoredProposal | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredProposal;
  } catch {
    return null;
  }
}

function effectiveExpiresAt(p: StoredProposal): number {
  if (typeof p.expiresAt === 'number') return p.expiresAt;
  const created = typeof p.createdAt === 'number' ? p.createdAt : 0;
  return created + QA_PROPOSAL_TTL_MS;
}

function cleanup(p: StoredProposal): void {
  try {
    execSync(`git worktree remove --force "${p.worktreePath}"`, {
      cwd: REPO,
      stdio: 'ignore',
    });
  } catch {
    /* worktree may already be gone */
  }
  try {
    execSync(`git branch -D ${p.branch}`, { cwd: REPO, stdio: 'ignore' });
  } catch {
    /* branch may already be gone */
  }
  if (p.pushed) {
    try {
      execSync(`git push origin :${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* remote may already be gone */
    }
  }
}

async function notifyTelegram(summary: string[]): Promise<void> {
  const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
  const token = readEnvValue('TELEGRAM_BOT_TOKEN');
  if (!chatId || !token) return;
  const body = ['⏰ *QA autopilot: expired stuck proposal(s)*', '', ...summary].join('\n');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  }).catch(() => {
    /* notification is best-effort */
  });
}

async function main(): Promise<void> {
  if (readEnvValue('QA_EXPIRE_DISABLED') === '1') {
    process.stdout.write('qa-expire: disabled\n');
    process.exit(0);
  }
  const dryRun = readEnvValue('QA_EXPIRE_DRY_RUN') === '1';

  if (!fs.existsSync(PROPOSALS_DIR)) {
    process.stdout.write('qa-expire: no proposals directory, nothing to do\n');
    process.exit(0);
  }

  const now = Date.now();
  const files = fs
    .readdirSync(PROPOSALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(PROPOSALS_DIR, f));

  let scanned = 0;
  let expired = 0;
  const summary: string[] = [];

  for (const file of files) {
    scanned++;
    const p = loadProposal(file);
    if (!p) continue;
    if (p.resolution || typeof p.resolvedAt === 'number') continue;
    const exp = effectiveExpiresAt(p);
    if (now <= exp) continue;

    const ageHours = Math.round((now - (p.createdAt ?? exp - QA_PROPOSAL_TTL_MS)) / 3600_000);
    const failure = p.failureReport?.failures[0]?.name ?? '(unknown)';

    if (dryRun) {
      process.stdout.write(
        `qa-expire: [dry-run] would expire ${p.id} (${failure}, ${ageHours}h old)\n`,
      );
      continue;
    }

    cleanup(p);

    p.resolvedAt = now;
    p.resolution = 'expired';
    try {
      fs.writeFileSync(file, JSON.stringify(p, null, 2));
    } catch (err) {
      process.stderr.write(
        `qa-expire: failed to mark ${p.id} expired: ${err instanceof Error ? err.message : err}\n`,
      );
      continue;
    }

    expired++;
    summary.push(`• \`${p.id}\` — ${failure} (${ageHours}h old)`);
    process.stdout.write(`qa-expire: expired ${p.id} (${failure}, ${ageHours}h old)\n`);
  }

  process.stdout.write(
    `qa-expire: scanned=${scanned} expired=${expired}${dryRun ? ' (dry-run)' : ''}\n`,
  );

  if (expired > 0 && !dryRun) {
    await notifyTelegram(summary);
  }
}

const invokedDirectly =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(
      `qa-expire: crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  });
}
