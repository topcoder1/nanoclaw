/**
 * QA auto-propose-fix approval-flow handler.
 *
 * Wired into src/callback-router.ts for callback_data patterns:
 *   qa:merge:<id>    fast-forward merge the proposal branch into main,
 *                    push, kickstart the service.
 *   qa:close:<id>    delete the worktree + remote branch, mark closed.
 *   qa:details:<id>  post the agent transcript as a Telegram message.
 *
 * Persisted state lives at data/qa-proposals/<id>.json, written by
 * scripts/qa/propose-fix.ts. This handler mutates it with a `resolvedAt`
 * + `resolution` field.
 *
 * All operations are synchronous shell-outs. Timeouts are modest because
 * we're called from the Telegram callback path which should feel snappy.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CallbackQuery, Channel } from './types.js';
import { logger } from './logger.js';
import { renderAgentOutcome, type QaProposal } from './qa-proposal-types.js';

const REPO = path.resolve('.');
const PROPOSALS_DIR = path.join(REPO, 'data/qa-proposals');

// Old proposals on disk (pre-shared-types) may be missing the newer
// fields. Treat anything structural beyond id/worktreePath/branch/
// testStatus as optional at load time and let the Details renderer
// degrade gracefully.
type StoredProposal = Partial<QaProposal> &
  Pick<QaProposal, 'id' | 'worktreePath' | 'branch' | 'testStatus'>;

function loadProposal(id: string): StoredProposal | null {
  const file = path.join(PROPOSALS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredProposal;
  } catch {
    return null;
  }
}

function saveProposal(p: StoredProposal): void {
  fs.writeFileSync(
    path.join(PROPOSALS_DIR, `${p.id}.json`),
    JSON.stringify(p, null, 2),
  );
}

async function replyText(
  channel: (Channel & Record<string, unknown>) | undefined,
  chatJid: string,
  messageId: number | undefined,
  text: string,
): Promise<void> {
  if (!channel) return;
  // Prefer editing the original card when we have its message id so we
  // don't litter chat with approval confirmations.
  const c = channel as unknown as {
    editMessageTextAndButtons?: (
      jid: string,
      msgId: number,
      text: string,
      actions: unknown[],
    ) => Promise<void>;
    sendMessage: (jid: string, text: string) => Promise<void>;
  };
  if (c.editMessageTextAndButtons && messageId) {
    await c.editMessageTextAndButtons(chatJid, messageId, text, []);
    return;
  }
  await c.sendMessage(chatJid, text);
}

/**
 * Render a Telegram-friendly summary of a proposal. Structured fields
 * drive the output so a broken agent subprocess (ENOENT, timeout) shows
 * its actual failure mode instead of the previous `undefined ... undefined`
 * transcript blob.
 *
 * The raw transcript is included as a short tail at the bottom for
 * debugging — only when it's present and actually has content.
 */
function renderDetails(p: StoredProposal): string {
  const lines: string[] = [];
  lines.push(`🔍 *QA proposal* \`${p.id}\``);

  const status = resolutionLabel(p);
  if (status) lines.push(`*Status:* ${status}`);

  const firstFailure = p.failureReport?.failures[0];
  if (firstFailure) {
    const extra =
      (p.failureReport?.failures.length ?? 0) > 1
        ? ` (+${(p.failureReport?.failures.length ?? 1) - 1} more)`
        : '';
    lines.push(`*Failure:* ${firstFailure.name}${extra}`);
    if (firstFailure.message) {
      lines.push(`  ${truncate(firstFailure.message, 200)}`);
    }
  }

  if (p.diffStat) {
    lines.push(
      `*Diff:* +${p.diffStat.insertions}  −${p.diffStat.deletions}  across ${p.diffStat.files} file(s)`,
    );
  }
  if (p.changedFiles && p.changedFiles.length > 0) {
    const shown = p.changedFiles.slice(0, 6).map((f) => `  • ${f}`);
    const tail =
      p.changedFiles.length > 6
        ? `  • …and ${p.changedFiles.length - 6} more`
        : '';
    lines.push(`*Files:*`);
    lines.push(...shown);
    if (tail) lines.push(tail);
  }

  if (p.risk) lines.push(`*Risk:* ${p.risk}   *Tests:* ${p.testStatus}`);
  else lines.push(`*Tests:* ${p.testStatus}`);

  if (p.blocked) {
    lines.push(`*Blocked:* ${p.blockedReasons?.join('; ') ?? '(unspecified)'}`);
  }

  lines.push(
    `*Agent:* ${p.agent ? renderAgentOutcome(p.agent) : '(not recorded — older proposal)'}`,
  );
  lines.push(`*Branch:* \`${p.branch}\``);
  lines.push(`*Worktree:* \`${p.worktreePath}\``);

  // Transcript tail — only when present and non-trivial.
  if (p.agentTranscriptPath && fs.existsSync(p.agentTranscriptPath)) {
    let raw = '';
    try {
      raw = fs.readFileSync(p.agentTranscriptPath, 'utf-8');
    } catch {
      raw = '';
    }
    const tail = raw.trim();
    if (tail.length > 0) {
      const TAIL_LEN = 1500;
      const slice = tail.length > TAIL_LEN ? `…${tail.slice(-TAIL_LEN)}` : tail;
      lines.push('');
      lines.push('*Transcript tail:*');
      lines.push('```');
      lines.push(slice);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

function resolutionLabel(p: StoredProposal): string | null {
  if (p.resolution === 'merged') return 'merged ✅';
  if (p.resolution === 'closed') return 'closed ✕';
  if (p.blocked) return 'awaiting manual review (guardrail blocked)';
  if (p.pushed) return 'awaiting review';
  return p.pushed === false ? 'local only (not pushed)' : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export async function handleQaCallback(
  sub: string,
  proposalId: string,
  query: CallbackQuery,
  channel: (Channel & Record<string, unknown>) | undefined,
): Promise<void> {
  const p = loadProposal(proposalId);
  if (!p) {
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `⚠️ QA proposal ${proposalId} not found (already resolved?)`,
    );
    return;
  }

  if (sub === 'details') {
    await replyText(channel, query.chatJid, undefined, renderDetails(p));
    return;
  }

  if (sub === 'close') {
    try {
      execSync(`git worktree remove --force "${p.worktreePath}"`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* best effort */
    }
    try {
      execSync(`git push origin :${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* branch may already be gone */
    }
    try {
      execSync(`git branch -D ${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
    } catch {
      /* best effort */
    }
    p.resolvedAt = Date.now();
    p.resolution = 'closed';
    saveProposal(p);
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `✕ QA proposal \`${p.id}\` closed — branch removed, no changes landed.`,
    );
    return;
  }

  if (sub === 'merge') {
    if (p.testStatus !== 'pass') {
      await replyText(
        channel,
        query.chatJid,
        query.messageId,
        `⛔ Can't merge \`${p.id}\` — tests were ${p.testStatus} when the proposal was drafted.`,
      );
      return;
    }
    try {
      execSync(`git fetch origin ${p.branch}`, { cwd: REPO, stdio: 'ignore' });
      execSync('git checkout main', { cwd: REPO, stdio: 'ignore' });
      execSync('git pull --ff-only origin main', {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync(`git merge --ff-only origin/${p.branch}`, {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync('git push origin main', { cwd: REPO, stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, proposalId: p.id }, 'QA merge failed');
      await replyText(
        channel,
        query.chatJid,
        query.messageId,
        `💥 Merge failed for \`${p.id}\`: ${err instanceof Error ? err.message : String(err)}. Branch is still at \`${p.branch}\`.`,
      );
      return;
    }
    // Build + restart — match what the main commit-flow would do.
    try {
      execSync('npm run build', { cwd: REPO, stdio: 'ignore' });
      execSync(`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`, {
        stdio: 'ignore',
      });
    } catch (err) {
      logger.warn(
        { err, proposalId: p.id },
        'QA merge: build/restart after merge had a hiccup',
      );
    }
    // Clean up worktree + local branch (remote is already merged).
    try {
      execSync(`git worktree remove --force "${p.worktreePath}"`, {
        cwd: REPO,
        stdio: 'ignore',
      });
      execSync(`git branch -D ${p.branch}`, { cwd: REPO, stdio: 'ignore' });
      execSync(`git push origin :${p.branch}`, { cwd: REPO, stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    p.resolvedAt = Date.now();
    p.resolution = 'merged';
    saveProposal(p);
    await replyText(
      channel,
      query.chatJid,
      query.messageId,
      `🚀 Merged \`${p.id}\` to main. Service restarted.`,
    );
    return;
  }

  logger.warn({ sub, proposalId }, 'Unknown qa: callback sub-action');
}
