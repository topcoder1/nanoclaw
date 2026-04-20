/**
 * Shared types for QA autopilot proposals — produced by
 * scripts/qa/propose-fix.ts, consumed by src/qa-approval.ts.
 *
 * The producer and consumer previously each had their own Proposal
 * interface; they drifted, and when the agent subprocess failed the
 * [🔍 Details] renderer had nothing structured to fall back to — it
 * just printed `proc.stdout + proc.stderr` where both were undefined.
 * Centralizing the record lets Details render a summary regardless of
 * whether the raw transcript is usable.
 */
import type { SpawnSyncReturns } from 'node:child_process';

export type QaAgentOutcome =
  | { kind: 'ok'; stdoutBytes: number; stderrBytes: number }
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'spawn_error'; code: string; message: string }
  | {
      kind: 'nonzero';
      exitCode: number;
      signal: string | null;
      stderrTail: string;
    };

export interface QaFailureReport {
  source: 'invariants' | 'scenarios';
  failures: Array<{
    name: string;
    message: string;
    category?: string;
    details?: unknown;
  }>;
}

export interface QaProposal {
  id: string;
  createdAt: number;
  expiresAt: number;
  failureReport: QaFailureReport;
  worktreePath: string;
  branch: string;
  risk: 'LOW' | 'MED' | 'HIGH';
  diffStat: { files: number; insertions: number; deletions: number };
  changedFiles: string[];
  agentTranscriptPath: string;
  agent: QaAgentOutcome;
  testStatus: 'pass' | 'fail' | 'skipped';
  proposedAt: number;
  pushed: boolean;
  blocked?: boolean;
  blockedReasons?: string[];
  resolvedAt?: number;
  resolution?: 'merged' | 'closed' | 'expired';
}

/**
 * Default TTL for a QA proposal that is never acted on. After this
 * window the expire cron removes the worktree + branch and marks the
 * proposal `expired`. 48h is a balance between "long enough to cover
 * the reviewer being away for a weekend" and "short enough that stuck
 * proposals don't pile up in Telegram indefinitely."
 */
export const QA_PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Turn the raw SpawnSyncReturns into a structured outcome. The key
 * property is that EVERY branch produces a non-empty, human-legible
 * string when rendered — never the literal word "undefined".
 *
 * Timeout is detected via `proc.signal === 'SIGTERM'` combined with
 * the timeout flag, because Node does not set `proc.error` on timeout
 * (it kills the process and returns status=null).
 */
export function classifyAgentOutcome(
  proc: SpawnSyncReturns<string>,
  timeoutMs: number,
): QaAgentOutcome {
  if (proc.error) {
    const err = proc.error as NodeJS.ErrnoException;
    return {
      kind: 'spawn_error',
      code: err.code ?? 'UNKNOWN',
      message: err.message,
    };
  }
  if (proc.signal === 'SIGTERM' && proc.status === null) {
    return { kind: 'timeout', afterMs: timeoutMs };
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr ?? '';
    return {
      kind: 'nonzero',
      exitCode: proc.status ?? -1,
      signal: proc.signal ?? null,
      stderrTail: stderr.slice(-500),
    };
  }
  return {
    kind: 'ok',
    stdoutBytes: (proc.stdout ?? '').length,
    stderrBytes: (proc.stderr ?? '').length,
  };
}

export function renderAgentOutcome(o: QaAgentOutcome): string {
  switch (o.kind) {
    case 'ok':
      return `ok (${o.stdoutBytes}B stdout, ${o.stderrBytes}B stderr)`;
    case 'timeout':
      return `timeout after ${Math.round(o.afterMs / 1000)}s`;
    case 'spawn_error':
      return `spawn_error: ${o.code} — ${o.message}`;
    case 'nonzero': {
      const sig = o.signal ? ` signal=${o.signal}` : '';
      const tail = o.stderrTail
        ? `\n  stderr tail: ${o.stderrTail.trim()}`
        : '';
      return `exit ${o.exitCode}${sig}${tail}`;
    }
  }
}
