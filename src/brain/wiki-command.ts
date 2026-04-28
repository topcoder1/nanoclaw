/**
 * `/wiki <entity-name-or-id>` slash command handler (Phase 3b.3 trigger C).
 *
 * Resolves a free-text query to one entity, materializes that entity's
 * wiki page (LLM-synthesizing the cached blockquote when stale), then
 * replies with the page's first ~4KB plus the on-disk path. Same shape as
 * `recall-command.ts:handleRecallCommand` so wiring in `src/index.ts`
 * looks identical.
 *
 * Resolution rules:
 *   - Empty query → usage text.
 *   - Try entity_id prefix match (`WHERE entity_id LIKE 'query%'`,
 *     case-sensitive — ULIDs are uppercase). Cheap, exact, useful for
 *     "I just saw this id in the digest".
 *   - Try canonical name LIKE (case-insensitive substring).
 *   - Union, dedupe.
 *   - 0 → no-match message pointing at `/recall`.
 *   - 1 → materialize + reply with content.
 *   - 2+ → ambiguous list (capped at 5).
 *
 * No autonomous CRUD — this is read-only / cache-refresh-only. The user
 * sees the wiki page; the user does not authorize this command to mutate
 * any KU or relationship.
 */

import * as fsp from 'fs/promises';

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { escapeMarkdown } from './markdown.js';
import {
  type EntityType,
  type SummaryLlmCaller,
} from './wiki-projection.js';
import { materializeEntity } from './wiki-writer.js';

const HELP_TEXT =
  'Usage: `/wiki <entity-name-or-id>`\n\n' +
  'Examples:\n' +
  '• `/wiki Alice Smith`\n' +
  '• `/wiki acme`\n' +
  '• `/wiki 01HALICE` (entity-id prefix)\n';

/**
 * Cap on inline reply size — beyond this we point to the on-disk file.
 * Measured in characters (not bytes) so the truncation point is a safe
 * code-point boundary; matches Telegram's 4096-char message ceiling.
 */
const MAX_INLINE_CHARS = 4096;

/** Cap on ambiguous-match suggestion count to keep replies readable. */
const MAX_AMBIGUOUS_SUGGESTIONS = 5;

export interface WikiCommandOptions {
  db?: Database.Database;
  llm?: SummaryLlmCaller;
  /** STORE_DIR (the wiki/ subdir is appended inside the materializer). */
  baseDir: string;
}

interface CandidateRow {
  entity_id: string;
  entity_type: EntityType;
  canonical: string | null;
}

export async function handleWikiCommand(
  rawArgs: string,
  opts: WikiCommandOptions,
): Promise<string> {
  const query = rawArgs.trim();
  if (!query) return HELP_TEXT;

  const db = opts.db ?? getBrainDb();

  let candidates: CandidateRow[];
  try {
    candidates = resolveCandidates(db, query);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/wiki resolve failed',
    );
    return '⚠️ Wiki lookup failed — check logs.';
  }

  if (candidates.length === 0) {
    return `No entity found matching \`${escapeMarkdown(query)}\`. Try \`/recall\` for free-text search.`;
  }

  if (candidates.length > 1) {
    return formatAmbiguous(query, candidates);
  }

  const target = candidates[0];
  const result = await materializeEntity(target.entity_id, opts.baseDir, {
    db,
    synthesize: true,
    llm: opts.llm,
  });

  if (result.status === 'failed' || !result.path) {
    return `⚠️ Could not materialize wiki page for \`${escapeMarkdown(target.entity_id)}\`: ${result.err ?? 'unknown error'}`;
  }

  let content: string;
  try {
    content = await fsp.readFile(result.path, 'utf-8');
  } catch (err) {
    return `⚠️ Wiki page written but unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (content.length > MAX_INLINE_CHARS) {
    content =
      content.slice(0, MAX_INLINE_CHARS) +
      `\n\n_…truncated at ${MAX_INLINE_CHARS} chars. Full page: \`${result.path}\`_`;
  } else {
    content += `\n\n_Full page: \`${result.path}\`_`;
  }

  return content;
}

/**
 * Escape SQL LIKE metacharacters (`%`, `_`, `\`) in a user query so the
 * pattern only matches what the user typed. Used with an ESCAPE clause
 * below. Bindings are still parameterized — this is a correctness fix,
 * not a SQL-injection fix.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function resolveCandidates(
  db: Database.Database,
  query: string,
): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  const escaped = escapeLikePattern(query);
  // Pass 1: entity_id prefix match. Capped to 6 — anything more and we'd
  // rather show "ambiguous" than load the whole table for a one-char query.
  const idRows = db
    .prepare(
      `SELECT entity_id, entity_type, canonical
         FROM entities
        WHERE entity_id LIKE ? || '%' ESCAPE '\\'
        ORDER BY entity_id ASC
        LIMIT 6`,
    )
    .all(escaped) as CandidateRow[];
  for (const r of idRows) {
    if (!seen.has(r.entity_id)) {
      seen.add(r.entity_id);
      out.push(r);
    }
  }
  // Pass 2: case-insensitive substring match across the same identifier
  // fields the page renderer's `deriveTitle` falls back through (name,
  // email, domain, repo_slug, slug, tag). Searching only `name` would
  // miss email-only persons and domain-only companies — the exact
  // entity types `deriveTitle` was extended to handle in PR #37.
  // Field names are constants (not user input) so direct interpolation
  // into SQL is safe; the user query is still parameterized.
  const SEARCH_FIELDS = [
    'name',
    'email',
    'domain',
    'repo_slug',
    'slug',
    'tag',
  ];
  const orClause = SEARCH_FIELDS.map(
    (f) =>
      `LOWER(json_extract(canonical, '$.${f}')) LIKE LOWER('%' || ? || '%') ESCAPE '\\'`,
  ).join(' OR ');
  const nameRows = db
    .prepare(
      `SELECT entity_id, entity_type, canonical
         FROM entities
        WHERE (${orClause})
        ORDER BY entity_type, entity_id
        LIMIT 6`,
    )
    .all(...SEARCH_FIELDS.map(() => escaped)) as CandidateRow[];
  for (const r of nameRows) {
    if (!seen.has(r.entity_id)) {
      seen.add(r.entity_id);
      out.push(r);
    }
  }
  return out;
}

function formatAmbiguous(query: string, candidates: CandidateRow[]): string {
  const lines: string[] = [
    `Multiple matches for \`${escapeMarkdown(query)}\`:`,
    '',
  ];
  for (const c of candidates.slice(0, MAX_AMBIGUOUS_SUGGESTIONS)) {
    const name = parseName(c.canonical) ?? c.entity_id;
    lines.push(
      `- **${escapeMarkdown(name)}** _(${c.entity_type}, \`${c.entity_id}\`)_`,
    );
  }
  if (candidates.length > MAX_AMBIGUOUS_SUGGESTIONS) {
    lines.push(
      '',
      `_…and ${candidates.length - MAX_AMBIGUOUS_SUGGESTIONS} more. Refine your query or pass an entity-id prefix._`,
    );
  } else {
    lines.push('', '_Refine your query or pass an entity-id prefix._');
  }
  return lines.join('\n');
}

function parseName(canonical: string | null): string | null {
  if (!canonical) return null;
  try {
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
  } catch {
    /* malformed canonical — fall back to entity_id */
  }
  return null;
}
