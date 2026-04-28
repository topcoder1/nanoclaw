/**
 * Telegram `/recall <question>` handler (v2 §3, §11).
 *
 * Kept separate from the Telegram channel so it can be unit-tested in
 * isolation. The channel (or main.ts router) calls `handleRecallCommand()`
 * with the text after `/recall ` and gets back a ready-to-send Markdown
 * string.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { type Citation, enrichCitation } from './citations.js';
import { getBrainDb } from './db.js';
import { escapeMarkdown } from './markdown.js';
import { recall, type RecallResult } from './retrieve.js';

export type RecallFn = typeof recall;
export type AliasResolver = (alias: string) => string | null;

const HELP_TEXT =
  'Usage: `/recall <question>`\n\n' +
  'Examples:\n' +
  '• `/recall what did Alice say about the Q4 renewal?`\n' +
  '• `/recall last message from acme.co`\n';

export interface RecallCommandOptions {
  /** Injected for tests; defaults to the real recall() function. */
  recallFn?: RecallFn;
  /** Max results shown in the reply. Default 5. */
  limit?: number;
  /**
   * Account scope to query. P1 ingests everything as 'work', so callers
   * pass 'work' today. Plumbed through now so P2 personal ingestion does
   * not silently leak across scopes.
   */
  account?: 'personal' | 'work';
  /**
   * Map a payload `account` alias (e.g. `'personal'`, `'attaxion'`) onto
   * the mailbox address used in Gmail deep links. Wired from `index.ts`
   * via `gmailOpsRouter.emailAddressForAlias`. When omitted (tests, or
   * before gmailOps is up), citations fall back to the bare source-ref.
   */
  resolveAlias?: AliasResolver;
  /**
   * Injected for tests so the citation lookup can be observed without a
   * live brain.db. Defaults to the real `getBrainDb()`.
   */
  dbForCitations?: Database.Database | null;
}

/**
 * Parse + execute + format. `rawArgs` is everything after `/recall`.
 */
export async function handleRecallCommand(
  rawArgs: string,
  opts: RecallCommandOptions = {},
): Promise<string> {
  const question = rawArgs.trim();
  if (!question) return HELP_TEXT;

  const limit = opts.limit ?? 5;
  const fn = opts.recallFn ?? recall;
  const account = opts.account;

  let results: RecallResult[];
  try {
    results = await fn(question, { limit, account, caller: 'recall-command' });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/recall failed',
    );
    return '⚠️ Recall failed — check logs.';
  }

  if (results.length === 0) {
    return `No matches for *${escapeMarkdown(question)}*.`;
  }

  const citations = loadCitations(results, opts);
  const lines: string[] = [
    `🧠 Top ${results.length} match(es) for *${escapeMarkdown(question)}*:`,
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.valid_from ? r.valid_from.slice(0, 10) : '—';
    const snippet = truncate(r.text, 180);
    const sourceLine = formatSourceLink(r, citations[i]);
    lines.push(
      `\n*${i + 1}.* \`${r.source_type}\` • ${date}  (score ${r.finalScore.toFixed(2)})\n` +
        `${escapeMarkdown(snippet)}${sourceLine ? `\n${sourceLine}` : ''}`,
    );
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Look up subject/url for every hit in one prepare/run loop. Failures here
 * are non-fatal — we log once and return empty citations so the recall
 * reply still renders with the legacy source-ref form.
 */
function loadCitations(
  results: RecallResult[],
  opts: RecallCommandOptions,
): Citation[] {
  const empty = (): Citation => ({
    subject: null,
    senderEmail: null,
    url: null,
  });
  if (!opts.resolveAlias) return results.map(empty);
  let db: Database.Database | null;
  try {
    db = opts.dbForCitations === undefined ? getBrainDb() : opts.dbForCitations;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/recall: brain.db unavailable — skipping citation enrichment',
    );
    return results.map(empty);
  }
  if (!db) return results.map(empty);
  const resolver = opts.resolveAlias;
  return results.map((r) => {
    try {
      return enrichCitation(db, r.source_type, r.source_ref, resolver);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id: r.ku_id },
        '/recall: citation lookup failed',
      );
      return empty();
    }
  });
}

/**
 * Best-effort source link. Email hits with a recovered subject + Gmail URL
 * render as a Markdown link `[Subject — yyyy-mm-dd](url)`; otherwise we
 * fall back to the legacy bare source_ref form so a degraded environment
 * (no resolver, no payload row) is still useful.
 */
function formatSourceLink(r: RecallResult, c: Citation): string {
  if (!r.source_ref) return '';
  if (r.source_type === 'email') {
    if (c.subject && c.url) {
      const date = r.valid_from ? ` · ${r.valid_from.slice(0, 10)}` : '';
      return `  📎 [${escapeMarkdown(truncate(c.subject, 80))}${date}](${c.url})`;
    }
    if (c.url) {
      return `  📎 [open thread](${c.url})`;
    }
    return `  _thread:_ \`${r.source_ref}\``;
  }
  return `  _ref:_ \`${r.source_ref}\``;
}
