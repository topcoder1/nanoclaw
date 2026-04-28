/**
 * Wiki projection layer (Phase 3a.2 — pure render module, no I/O, no LLM).
 *
 * Projects one entity from `brain.db` into a Markdown page in the format
 * specced in `.omc/design/brain-wiki-and-frontier-v1.md` § "Page schema".
 *
 *   ┌─ frontmatter (entity_id, type, canonical, ku_count, synthesis ts)
 *   ├─ # <Title>
 *   ├─ > <cached LLM blockquote>            ← from entities.wiki_summary
 *   ├─ ## Facts                             ← KUs grouped by topic_key
 *   ├─ ## Aliases                           ← entity_aliases (un-expired)
 *   ├─ ## Relationships                     ← entity_relationships (un-expired)
 *   └─ ## Recent activity                   ← last 10 ku_queries that hit
 *
 * The deterministic sections are projected directly from typed rows. The
 * blockquote is rendered verbatim from the cached column (Phase 3a.3 writes
 * it). NULL summary → empty blockquote, never "null" or a placeholder.
 *
 * The function is pure: same input rows produce byte-identical output. This
 * is what enables the diff-aware writer in Phase 3b — re-rendering an
 * unchanged entity must hash to the same bytes so the writer can skip the
 * disk write.
 *
 * Returns `liveKuCount` alongside the markdown so Phase 3a.3 can compare
 * against `entities.ku_count_at_last_synthesis` to decide whether to
 * trigger a summary regen (>20% delta or >7 days stale).
 */

import type Database from 'better-sqlite3';

import { escapeMarkdown } from './markdown.js';

// --- Public types ----------------------------------------------------------

export type EntityType = 'person' | 'company' | 'project' | 'product' | 'topic';

export interface RenderInput {
  entityId: string;
  db: Database.Database;
  /** Override clock for golden-file determinism. ISO. */
  nowIso?: string;
  /**
   * Cap the number of KUs surfaced under "## Facts". Default 50 — tradeoff
   * between page utility and bounded rendering cost. Older KUs that fall
   * off the cap are still in `brain.db` and surface via /recall.
   */
  maxFacts?: number;
  /**
   * Cap the number of recent queries surfaced under "## Recent activity".
   * Default 10. Pulled from `ku_queries` joined through `ku_entities` so
   * only queries that actually retrieved this entity show up.
   */
  maxRecentQueries?: number;
}

export interface RenderedPage {
  entityType: EntityType;
  /** Full Markdown, including frontmatter. Newline-terminated. */
  markdown: string;
  /**
   * Live count of un-superseded KUs linked to this entity, computed at
   * render time. Phase 3a.3 compares this against
   * `entities.ku_count_at_last_synthesis` for the regen-trigger.
   */
  liveKuCount: number;
}

/**
 * Sentinel returned when the entity_id doesn't exist. Callers (the
 * materializer in 3b.2) treat this as a no-op rather than a hard failure
 * — entities can be deleted between when the trigger queues a rebuild
 * and when it fires.
 */
export const ENTITY_NOT_FOUND = Symbol('wiki-projection: entity not found');

// --- Internal row types ----------------------------------------------------

interface EntityRow {
  entity_id: string;
  entity_type: EntityType;
  canonical: string | null;
  created_at: string;
  updated_at: string;
  last_synthesis_at: string | null;
  ku_count_at_last_synthesis: number | null;
  wiki_summary: string | null;
}

interface AliasRow {
  field_name: string;
  field_value: string;
  source_type: string;
  confidence: number;
  valid_from: string;
}

interface RelationshipRow {
  relationship: string;
  to_entity_id: string;
  to_canonical: string | null;
  valid_from: string;
  confidence: number;
}

interface KuRow {
  id: string;
  text: string;
  topic_key: string | null;
  source_type: string;
  source_ref: string | null;
  valid_from: string;
  recorded_at: string;
  important: number;
}

interface RecentQueryRow {
  query_text: string;
  recorded_at: string;
}

// --- Title derivation ------------------------------------------------------

/**
 * Choose the human-readable title for an entity. Prefers `name`, falls back
 * to whichever canonical field is most identifying for the type, then to
 * the entity_id as a last resort. The entity_id never produces a useful
 * page title but it's better than throwing — a renamed/incomplete entity
 * still gets a page so /wikilint can flag it.
 */
function deriveTitle(
  entityType: EntityType,
  canonical: Record<string, unknown> | null,
  entityId: string,
): string {
  if (canonical) {
    const name = canonical.name;
    if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    // Per-type fallback in priority order.
    const fallbacks: Record<EntityType, string[]> = {
      person: ['email', 'phone'],
      company: ['domain'],
      project: ['repo_slug', 'slug'],
      product: ['slug'],
      topic: ['slug', 'tag'],
    };
    for (const key of fallbacks[entityType]) {
      const v = canonical[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
  }
  return entityId;
}

// --- Helpers ---------------------------------------------------------------

function loadEntity(db: Database.Database, entityId: string): EntityRow | null {
  const row = db
    .prepare(
      `SELECT entity_id, entity_type, canonical, created_at, updated_at,
              last_synthesis_at, ku_count_at_last_synthesis, wiki_summary
         FROM entities
        WHERE entity_id = ?`,
    )
    .get(entityId) as EntityRow | undefined;
  return row ?? null;
}

function loadAliases(db: Database.Database, entityId: string): AliasRow[] {
  return db
    .prepare(
      `SELECT field_name, field_value, source_type, confidence, valid_from
         FROM entity_aliases
        WHERE entity_id = ?
          AND valid_until IS NULL
        ORDER BY confidence DESC, valid_from`,
    )
    .all(entityId) as AliasRow[];
}

function loadRelationships(
  db: Database.Database,
  entityId: string,
): RelationshipRow[] {
  return db
    .prepare(
      `SELECT er.relationship, er.to_entity_id, e2.canonical AS to_canonical,
              er.valid_from, er.confidence
         FROM entity_relationships er
         JOIN entities e2 ON e2.entity_id = er.to_entity_id
        WHERE er.from_entity_id = ?
          AND er.valid_until IS NULL
        ORDER BY er.confidence DESC, er.valid_from`,
    )
    .all(entityId) as RelationshipRow[];
}

function loadFacts(
  db: Database.Database,
  entityId: string,
  limit: number,
): KuRow[] {
  // Sort by topic_key first so the GROUP-BY rendering stays stable, then
  // by valid_from DESC within each group so the most recent fact in a
  // topic appears first.
  return db
    .prepare(
      `SELECT ku.id, ku.text, ku.topic_key, ku.source_type, ku.source_ref,
              ku.valid_from, ku.recorded_at, ku.important
         FROM knowledge_units ku
         JOIN ku_entities ke ON ke.ku_id = ku.id
        WHERE ke.entity_id = ?
          AND ku.superseded_at IS NULL
        ORDER BY (ku.topic_key IS NULL), ku.topic_key ASC,
                 ku.valid_from DESC
        LIMIT ?`,
    )
    .all(entityId, limit) as KuRow[];
}

function liveKuCount(db: Database.Database, entityId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM knowledge_units ku
         JOIN ku_entities ke ON ke.ku_id = ku.id
        WHERE ke.entity_id = ?
          AND ku.superseded_at IS NULL`,
    )
    .get(entityId) as { n: number };
  return row.n;
}

function loadRecentQueries(
  db: Database.Database,
  entityId: string,
  limit: number,
): RecentQueryRow[] {
  return db
    .prepare(
      `SELECT q.query_text, q.recorded_at
         FROM ku_queries q
         JOIN ku_retrievals r ON r.query_id = q.id
         JOIN ku_entities ke ON ke.ku_id = r.ku_id
        WHERE ke.entity_id = ?
        GROUP BY q.id
        ORDER BY q.recorded_at DESC
        LIMIT ?`,
    )
    .all(entityId, limit) as RecentQueryRow[];
}

// --- Section renderers -----------------------------------------------------

function renderFrontmatter(
  e: EntityRow,
  liveCount: number,
  title: string,
): string {
  const lines: string[] = ['---'];
  lines.push(`entity_id: ${e.entity_id}`);
  lines.push(`entity_type: ${e.entity_type}`);
  lines.push(`title: ${JSON.stringify(title)}`);
  if (e.canonical) {
    // canonical is already-validated JSON from the entities table; we
    // re-stringify it on one line so the frontmatter stays parseable by
    // both YAML and Obsidian Dataview. JSON-as-YAML is a deliberate
    // simplification — saves writing a YAML emitter for nested objects.
    lines.push(`canonical: ${e.canonical}`);
  }
  lines.push(`ku_count: ${liveCount}`);
  if (e.last_synthesis_at) {
    lines.push(`last_synthesis_at: ${e.last_synthesis_at}`);
  }
  lines.push(`created_at: ${e.created_at}`);
  lines.push(`updated_at: ${e.updated_at}`);
  lines.push('---', '');
  return lines.join('\n');
}

function renderSummary(summary: string | null): string {
  if (!summary || summary.trim().length === 0) return '';
  // Quote each line individually so multi-paragraph summaries survive
  // verbatim. Trailing blank line so the next section's `## Facts`
  // heading is separated from the blockquote.
  const quoted = summary
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `${quoted}\n\n`;
}

function renderFacts(facts: KuRow[]): string {
  if (facts.length === 0) {
    return '## Facts\n\n_No facts recorded yet._\n\n';
  }
  const lines: string[] = ['## Facts', ''];
  // Group by topic_key (NULL grouped together as "Other"). Order is
  // already stable from the SQL — same topic_key rows are contiguous and
  // sorted by valid_from DESC within the group.
  let currentTopic: string | null | undefined = undefined;
  for (const ku of facts) {
    if (ku.topic_key !== currentTopic) {
      if (currentTopic !== undefined) lines.push('');
      const heading = ku.topic_key
        ? `### ${escapeMarkdown(ku.topic_key)}`
        : '### Other';
      lines.push(heading, '');
      currentTopic = ku.topic_key;
    }
    const date = ku.valid_from.slice(0, 10);
    const importantMark = ku.important === 1 ? ' ⭐' : '';
    lines.push(`- ${escapeMarkdown(ku.text)} _(${date})_${importantMark}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderAliases(aliases: AliasRow[]): string {
  if (aliases.length === 0) return '';
  const lines: string[] = ['## Aliases', ''];
  for (const a of aliases) {
    lines.push(
      `- **${escapeMarkdown(a.field_name)}**: ${escapeMarkdown(a.field_value)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderRelationships(rels: RelationshipRow[]): string {
  if (rels.length === 0) return '';
  const lines: string[] = ['## Relationships', ''];
  for (const r of rels) {
    let toName = r.to_entity_id;
    if (r.to_canonical) {
      try {
        const parsed = JSON.parse(r.to_canonical) as Record<string, unknown>;
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          toName = parsed.name;
        }
      } catch {
        /* malformed canonical — fall back to entity_id */
      }
    }
    lines.push(
      `- **${escapeMarkdown(r.relationship)}** → ${escapeMarkdown(toName)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderRecentActivity(queries: RecentQueryRow[]): string {
  if (queries.length === 0) return '';
  const lines: string[] = ['## Recent activity', ''];
  for (const q of queries) {
    const date = q.recorded_at.slice(0, 10);
    lines.push(`- ${date} — \`${escapeMarkdown(q.query_text)}\``);
  }
  lines.push('');
  return lines.join('\n');
}

// --- Main entry point ------------------------------------------------------

export function renderEntityPage(
  input: RenderInput,
): RenderedPage | typeof ENTITY_NOT_FOUND {
  const { db, entityId } = input;
  const maxFacts = input.maxFacts ?? 50;
  const maxRecentQueries = input.maxRecentQueries ?? 10;

  const entity = loadEntity(db, entityId);
  if (!entity) return ENTITY_NOT_FOUND;

  const canonical = entity.canonical
    ? (() => {
        try {
          return JSON.parse(entity.canonical!) as Record<string, unknown>;
        } catch {
          return null;
        }
      })()
    : null;
  const title = deriveTitle(entity.entity_type, canonical, entity.entity_id);

  const aliases = loadAliases(db, entityId);
  const rels = loadRelationships(db, entityId);
  const facts = loadFacts(db, entityId, maxFacts);
  const liveCount = liveKuCount(db, entityId);
  const recent = loadRecentQueries(db, entityId, maxRecentQueries);

  const sections: string[] = [
    renderFrontmatter(entity, liveCount, title),
    `# ${escapeMarkdown(title)}\n\n`,
    renderSummary(entity.wiki_summary),
    renderFacts(facts),
    renderAliases(aliases),
    renderRelationships(rels),
    renderRecentActivity(recent),
  ];

  // Preserve a trailing newline so concatenated diffs stay POSIX-clean.
  const markdown = sections.join('').replace(/\n+$/, '\n');

  return {
    entityType: entity.entity_type,
    markdown,
    liveKuCount: liveCount,
  };
}
