/**
 * `/wikilint` slash-command handler. Read-only: runs the four detectors
 * (`runAll`) against `brain.db` and returns the formatted Markdown report.
 * Same shape as `wiki-command.ts:handleWikiCommand` so wiring in
 * `src/index.ts` looks identical (intercept the prefix, await the handler,
 * `sendMessage` the reply).
 *
 * Failures from `runAll` (corrupted DB, Qdrant unreachable, etc.) collapse
 * to a single user-facing line — the user can re-run later or check logs;
 * a stack trace in the chat is noise.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { getSystemState, setSystemState } from './metrics.js';
import {
  formatWikilintReport,
  runAll,
  type DuplicateKusOptions,
} from './wikilint.js';

/** Weekly cadence — `last_wikilint` older than this triggers a re-run. */
const WIKILINT_DEBOUNCE_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_STATE_KEY = 'last_wikilint';

export interface WikilintCommandOptions {
  /** Inject a DB handle for tests; defaults to the singleton brain DB. */
  db?: Database.Database;
  /** Pinned clock for the orphan-age calculation (tests + cron stamp). */
  nowIso?: string;
  /** Forwarded to `findDuplicateKus` for tests. */
  duplicates?: DuplicateKusOptions;
}

export async function handleWikilintCommand(
  opts: WikilintCommandOptions = {},
): Promise<string> {
  const db = opts.db ?? getBrainDb();
  try {
    const findings = await runAll(db, {
      nowIso: opts.nowIso,
      duplicates: opts.duplicates,
    });
    return formatWikilintReport(findings);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/wikilint runAll failed',
    );
    return '⚠️ Wikilint failed — check logs.';
  }
}

export interface WikilintCronOptions {
  /** Delivery sink — same shape as the digest's delivery callback. */
  deliver: (markdown: string) => void | Promise<void>;
  /** Override clock for tests. ISO. */
  nowIso?: string;
  /** Inject a DB handle; defaults to the singleton brain DB. */
  db?: Database.Database;
}

/**
 * Weekly wikilint cron — delivers the report at most once every 7 days.
 * Designed to be invoked from the digest scheduler's callback so we don't
 * add another `setInterval`. Stamps `system_state.last_wikilint` on
 * successful delivery; failures don't stamp, so the next digest fires it
 * again.
 */
export async function maybeRunWikilintCron(
  opts: WikilintCronOptions,
): Promise<void> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const last = getSystemState(SYSTEM_STATE_KEY);
  if (last) {
    const lastMs = Date.parse(last.value);
    if (
      !Number.isNaN(lastMs) &&
      Date.parse(nowIso) - lastMs < WIKILINT_DEBOUNCE_MS
    ) {
      return;
    }
  }
  const reply = await handleWikilintCommand({ nowIso, db: opts.db });
  await Promise.resolve(opts.deliver(reply)).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'wikilint cron deliver failed',
    );
  });
  setSystemState(SYSTEM_STATE_KEY, nowIso, nowIso);
}
