/**
 * Auto-recall: before every user-initiated agent turn, query the brain for
 * top-K KUs relevant to the user's message and inject them as a
 * `<brain_context>` block prepended to the prompt. Lets the agent answer
 * questions that reference earlier knowledge ("what did Ryo say?", "remind
 * me of the Orphan VPN roadmap") without the user having to type `/recall`.
 *
 * v3 of the second-brain delivery (see `.omc/design/second-brain-v1.md`).
 *
 * Design constraints:
 *   - Zero mutation of the raw prompt when disabled or when no hits.
 *   - Error-safe: any failure returns the original prompt, never throws.
 *     Retrieval must never block a turn.
 *   - Skip automated triggers (Email Intelligence batches already come with
 *     their own context and don't need brain padding).
 *   - Cap total injected bytes so we don't blow the agent's context window.
 *   - Gate on `BRAIN_AUTO_RECALL` env var; any value other than "0"/"false"
 *     enables (defaults to on).
 *
 * The recall() call is tagged `caller: 'agent-auto'` so the audit trail in
 * /brain/queries is filterable.
 */

import { logger } from '../logger.js';

import { recall, type RecallResult } from './retrieve.js';

/** Minimum user-message length to trigger auto-recall. Short messages
 * ("hi", "thanks", "ok") are skipped — recall noise outweighs benefit. */
const MIN_PROMPT_CHARS = 20;

/** Cap the injected block at this many characters to protect the agent's
 * context budget. Typical hit gives ~200-400 chars, so ~5 hits. */
const MAX_INJECT_CHARS = 2200;

/** Minimum finalScore for a hit to be included. Below this the hit is
 * noise rather than signal given blended rank + recency + access. */
const MIN_SCORE = 0.25;

/** How many hits to request from recall() before applying score filter. */
const TOP_K = 5;

/** Heuristic: these prefixes mark system-generated trigger prompts (email
 * intelligence batches, task spawns) that already carry their own context
 * and should NOT get an auto-recall block on top. */
const TRIGGER_PREFIXES = [
  '## Email Intelligence Trigger',
  '## Task Completed',
  '## Scheduled Task',
  '## Webhook',
  '## Signer',
];

export interface AutoRecallOptions {
  /** Override the env var at call time (tests). */
  enabled?: boolean;
  /** Maximum injected characters (tests). */
  maxChars?: number;
  /** Override the recall function (tests). */
  recallFn?: typeof recall;
}

function shouldSkip(prompt: string): string | null {
  if (prompt.length < MIN_PROMPT_CHARS) {
    return 'prompt-too-short';
  }
  for (const prefix of TRIGGER_PREFIXES) {
    if (prompt.startsWith(prefix)) return `trigger-prefix:${prefix}`;
  }
  return null;
}

function formatKuLine(r: RecallResult): string {
  const typeTag =
    r.source_type === 'email'
      ? '✉️ email'
      : r.source_type === 'repo'
        ? '📄 repo'
        : r.source_type === 'note'
          ? '📝 note'
          : `🧠 ${r.source_type}`;
  // For repo KUs the source_ref (path) is the most informative label.
  // For everything else the first line of text is a better title than
  // an opaque thread_id or ULID.
  const label =
    r.source_type === 'repo' && r.source_ref
      ? r.source_ref
      : (r.text.split('\n', 1)[0] || r.ku_id).slice(0, 110);
  const body = r.text.split('\n').slice(0, 3).join(' ').slice(0, 240);
  const sameLine = label === body.slice(0, label.length);
  if (sameLine) return `- [${typeTag}] ${label}`;
  return `- [${typeTag}] ${label}\n  ${body}`;
}

export async function maybeInjectBrainContext(
  rawPrompt: string,
  opts: AutoRecallOptions = {},
): Promise<string> {
  const envFlag = process.env.BRAIN_AUTO_RECALL;
  const enabled =
    opts.enabled ?? (envFlag === undefined || !['0', 'false', ''].includes(envFlag));
  if (!enabled) return rawPrompt;

  const skipReason = shouldSkip(rawPrompt);
  if (skipReason) {
    logger.debug({ skipReason }, 'brain auto-recall: skipped');
    return rawPrompt;
  }

  try {
    const recallImpl = opts.recallFn ?? recall;
    const hits = await recallImpl(rawPrompt, {
      limit: TOP_K,
      caller: 'agent-auto',
    });
    const good = hits.filter((h) => h.finalScore >= MIN_SCORE);
    if (good.length === 0) return rawPrompt;

    const cap = opts.maxChars ?? MAX_INJECT_CHARS;
    const lines: string[] = [];
    let budget = cap;
    for (const h of good) {
      const line = formatKuLine(h);
      if (line.length + 1 > budget) break;
      lines.push(line);
      budget -= line.length + 1;
    }
    if (lines.length === 0) return rawPrompt;

    const block =
      `<brain_context>\n` +
      `The brain (your second memory) surfaced these items as related ` +
      `to the user's message. Use them only if they actually help — ` +
      `otherwise ignore. Do NOT mention this block verbatim.\n` +
      lines.join('\n') +
      `\n</brain_context>`;
    logger.info(
      { injected: lines.length, totalChars: block.length },
      'brain auto-recall: injected context',
    );
    return `${block}\n\n${rawPrompt}`;
  } catch (err) {
    // Never fail the turn — warn and return original prompt.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'brain auto-recall: failed, returning plain prompt',
    );
    return rawPrompt;
  }
}
