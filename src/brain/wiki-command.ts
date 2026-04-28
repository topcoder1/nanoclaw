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

/** Cap on inline reply size — beyond this we point to the on-disk file. */
const MAX_INLINE_BYTES = 4096;

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

  if (Buffer.byteLength(content) > MAX_INLINE_BYTES) {
    content =
      content.slice(0, MAX_INLINE_BYTES) +
      `\n\n_…truncated at ${MAX_INLINE_BYTES} bytes. Full page: \`${result.path}\`_`;
  } else {
    content += `\n\n_Full page: \`${result.path}\`_`;
  }

  return content;
}

function resolveCandidates(
  db: Database.Database,
  query: string,
): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  // Pass 1: entity_id prefix match. Capped to 6 — anything more and we'd
  // rather show "ambiguous" than load the whole table for a one-char query.
  const idRows = db
    .prepare(
      `SELECT entity_id, entity_type, canonical
         FROM entities
        WHERE entity_id LIKE ? || '%'
        ORDER BY entity_id ASC
        LIMIT 6`,
    )
    .all(query) as CandidateRow[];
  for (const r of idRows) {
    if (!seen.has(r.entity_id)) {
      seen.add(r.entity_id);
      out.push(r);
    }
  }
  // Pass 2: case-insensitive name substring match. Same cap.
  const nameRows = db
    .prepare(
      `SELECT entity_id, entity_type, canonical
         FROM entities
        WHERE LOWER(json_extract(canonical, '$.name')) LIKE LOWER('%' || ? || '%')
        ORDER BY entity_type, entity_id
        LIMIT 6`,
    )
    .all(query) as CandidateRow[];
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
