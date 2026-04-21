import type Database from 'better-sqlite3';

import { ArchiveTracker } from '../archive-tracker.js';
import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';
import { isBlocklisted, loadBlocklist } from './junk-reaper-blocklist.js';
import {
  executeUnsubscribe,
  pickUnsubscribeMethod,
} from './unsubscribe-executor.js';

export const REAP_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_PER_ACCOUNT_PER_TICK = 50;
export const PER_CALL_TIMEOUT_MS = 15_000;

export const ARCHIVE_CANDIDATE_LABEL = 'SuperPilot/Archive-Candidate';
export const AUTO_ARCHIVED_LABEL = 'SuperPilot/Auto-Archived';

const UNSUB_HEADERS = ['List-Unsubscribe', 'List-Unsubscribe-Post', 'From'];

export interface ReapDeps {
  db: Database.Database;
  gmailOps: Pick<
    GmailOps,
    | 'listMessagesByLabel'
    | 'getMessageHeaders'
    | 'archiveThread'
    | 'modifyMessageLabels'
    | 'sendEmail'
  > & { accounts: string[] };
  fetch?: typeof globalThis.fetch;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error' | 'debug'>;
  /**
   * Per-Gmail-call timeout. Prevents a single hung API call from pinning
   * the tick forever (same failure mode as gmail-reconciler).
   */
  perCallTimeoutMs?: number;
  dryRun?: boolean;
  /** Max messages per account per tick; defaults to MAX_PER_ACCOUNT_PER_TICK. */
  maxPerAccount?: number;
  /**
   * Domain patterns (e.g. `*@github.com`) whose senders are archived but NOT
   * unsubscribed from. Defaults to loadBlocklist() result.
   */
  blocklist?: string[];
}

export interface ReapResult {
  accounts: number;
  scanned: number;
  reaped: number;
  errors: number;
  unsubAttempted: number;
  unsubSucceeded: number;
  unsubSkippedBlocklist: number;
}

export interface JunkReaperStatus {
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
  lastResult: ReapResult | null;
  totalTicks: number;
  totalReaped: number;
  totalErrors: number;
}

const status: JunkReaperStatus = {
  lastTickAt: null,
  lastTickDurationMs: null,
  lastResult: null,
  totalTicks: 0,
  totalReaped: 0,
  totalErrors: 0,
};

export function getJunkReaperStatus(): JunkReaperStatus {
  return { ...status };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms: ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function reapOnce(deps: ReapDeps): Promise<ReapResult> {
  const log = deps.logger ?? logger;
  const tickStartedAt = Date.now();
  const tracker = new ArchiveTracker(deps.db);
  const timeoutMs = deps.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS;
  const max = deps.maxPerAccount ?? MAX_PER_ACCOUNT_PER_TICK;
  const dryRun = deps.dryRun ?? false;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  // why: cache per reap call — avoid re-reading the user config file for each message
  const blocklist = deps.blocklist ?? loadBlocklist();

  const result: ReapResult = {
    accounts: 0,
    scanned: 0,
    reaped: 0,
    errors: 0,
    unsubAttempted: 0,
    unsubSucceeded: 0,
    unsubSkippedBlocklist: 0,
  };

  const accounts = deps.gmailOps.accounts;
  for (const account of accounts) {
    result.accounts++;
    let stubs;
    try {
      stubs = await withTimeout(
        deps.gmailOps.listMessagesByLabel(
          account,
          ARCHIVE_CANDIDATE_LABEL,
          max,
        ),
        timeoutMs,
        `listMessagesByLabel(${account})`,
      );
    } catch (err) {
      result.errors++;
      log.warn({ account, err }, 'Junk reaper: list failed');
      continue;
    }

    for (const stub of stubs) {
      result.scanned++;
      try {
        const headers = await withTimeout(
          deps.gmailOps.getMessageHeaders(account, stub.id, UNSUB_HEADERS),
          timeoutMs,
          `getMessageHeaders(${account}, ${stub.id})`,
        );
        const method = pickUnsubscribeMethod(headers);
        const blocked = isBlocklisted(headers.From, blocklist);

        let unsubTag: string = method.kind;
        let unsubStatus: number | 'skipped' = 'skipped';

        if (dryRun) {
          log.info(
            { account, messageId: stub.id, method: method.kind, blocked },
            'Junk reaper (dry-run): would reap',
          );
          continue;
        }

        if (blocked && method.kind !== 'none') {
          // why: blocklisted senders get archived but never unsubbed — their
          // unsub endpoint may also silence transactional mail we need.
          result.unsubSkippedBlocklist++;
          unsubTag = `blocklisted:${method.kind}`;
        } else if (method.kind !== 'none') {
          result.unsubAttempted++;
          const unsubResult = await withTimeout(
            executeUnsubscribe({
              method,
              account,
              fetch: fetchImpl,
              gmailOps: deps.gmailOps,
            }),
            timeoutMs,
            `executeUnsubscribe(${account}, ${stub.id})`,
          );
          unsubStatus = unsubResult.status;
          if (unsubResult.status >= 200 && unsubResult.status < 300) {
            result.unsubSucceeded++;
          }
        }

        // Archive + relabel regardless of unsub outcome: the message was
        // flagged as junk by SuperPilot and the user opted into live-reap,
        // so an unsub 500 must not leave it lingering in the inbox.
        await withTimeout(
          deps.gmailOps.archiveThread(account, stub.threadId),
          timeoutMs,
          `archiveThread(${account}, ${stub.threadId})`,
        );
        await withTimeout(
          deps.gmailOps.modifyMessageLabels(account, stub.id, {
            add: [AUTO_ARCHIVED_LABEL],
            remove: [ARCHIVE_CANDIDATE_LABEL, 'INBOX'],
          }),
          timeoutMs,
          `modifyMessageLabels(${account}, ${stub.id})`,
        );

        const action = `junk-reaper:${unsubTag}:${unsubStatus}`;
        tracker.recordAction(stub.id, stub.threadId, account, action);
        tracker.markArchived(stub.id, action);

        result.reaped++;
      } catch (err) {
        result.errors++;
        log.warn(
          { account, messageId: stub.id, threadId: stub.threadId, err },
          'Junk reaper: message failed',
        );
      }
    }
  }

  if (result.reaped > 0 || result.errors > 0) {
    log.info({ ...result }, 'Junk reaper tick');
  }

  status.lastTickAt = tickStartedAt;
  status.lastTickDurationMs = Date.now() - tickStartedAt;
  status.lastResult = result;
  status.totalTicks += 1;
  status.totalReaped += result.reaped;
  status.totalErrors += result.errors;

  return result;
}

export function startJunkReaper(
  deps: ReapDeps,
  intervalMs: number = REAP_INTERVAL_MS,
): () => void {
  const log = deps.logger ?? logger;
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped) return;
    if (inFlight) {
      log.warn('Junk reaper: previous tick still in flight, skipping');
      return;
    }
    inFlight = true;
    try {
      await reapOnce(deps);
    } catch (err) {
      log.error({ err }, 'Junk reaper tick crashed');
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
