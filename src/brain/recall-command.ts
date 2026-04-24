/**
 * Telegram `/recall <question>` handler (v2 §3, §11).
 *
 * Kept separate from the Telegram channel so it can be unit-tested in
 * isolation. The channel (or main.ts router) calls `handleRecallCommand()`
 * with the text after `/recall ` and gets back a ready-to-send Markdown
 * string.
 */

import { logger } from '../logger.js';

import { escapeMarkdown } from './markdown.js';
import { recall, type RecallResult } from './retrieve.js';

export type RecallFn = typeof recall;

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

  const lines: string[] = [
    `🧠 Top ${results.length} match(es) for *${escapeMarkdown(question)}*:`,
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.valid_from ? r.valid_from.slice(0, 10) : '—';
    const snippet = truncate(r.text, 180);
    const sourceLine = formatSourceLink(r);
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
 * Best-effort source link. Today we only have thread ids for email. For
 * other sources we fall back to a short reference. Only renders when we
 * have a stable URL-shaped source_ref.
 */
function formatSourceLink(r: RecallResult): string {
  if (!r.source_ref) return '';
  if (r.source_type === 'email') {
    return `  _thread:_ \`${r.source_ref}\``;
  }
  return `  _ref:_ \`${r.source_ref}\``;
}
