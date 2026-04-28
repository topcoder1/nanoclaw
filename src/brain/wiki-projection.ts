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

import { logger } from '../logger.js';

import { getDailyLlmBudgetUsd } from './extract.js';
import { escapeMarkdown } from './markdown.js';
import { getTodaysAnthropicSpend, logCost } from './metrics.js';

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
 * Parse the raw `entities.canonical` string column into a usable object.
 * Returns null on missing or malformed JSON. Centralized here (rather
 * than re-implemented per consumer) so wiki-writer, wiki-command, and
 * any future caller all interpret canonical the same way — prior
 * versions had three separate copies that drifted as the schema grew.
 */
export function parseCanonical(
  canonical: string | null,
): Record<string, unknown> | null {
  if (!canonical) return null;
  try {
    return JSON.parse(canonical) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Choose the human-readable title for an entity. Prefers `name`, falls back
 * to whichever canonical field is most identifying for the type, then to
 * the entity_id as a last resort. The entity_id never produces a useful
 * page title but it's better than throwing — a renamed/incomplete entity
 * still gets a page so /wikilint can flag it.
 *
 * Single source of truth for entity title text. ALL surfaces that show
 * the entity to a human (wiki page heading, index link, /wiki ambiguous
 * list, /wiki resolver match) MUST funnel through this helper —
 * otherwise email-only persons / domain-only companies render as ULIDs
 * in some places and emails/domains in others.
 */
export function deriveTitle(
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
  nowIso: string,
): RecentQueryRow[] {
  // 30-day window pinned to the caller-supplied `nowIso` rather than
  // SQLite's `datetime('now')`, so the section renders deterministically
  // for tests and so two simultaneous renders cross a midnight boundary
  // produce the same window. `GROUP BY q.id` dedups: a single query that
  // retrieved multiple KUs for this entity surfaces once, not N times.
  return db
    .prepare(
      `SELECT q.query_text, q.recorded_at
         FROM ku_queries q
         JOIN ku_retrievals r ON r.query_id = q.id
         JOIN ku_entities ke ON ke.ku_id = r.ku_id
        WHERE ke.entity_id = ?
          AND q.recorded_at >= datetime(?, '-30 days')
        GROUP BY q.id
        ORDER BY q.recorded_at DESC
        LIMIT ?`,
    )
    .all(entityId, nowIso, limit) as RecentQueryRow[];
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
    // Pass-through: the DB column is the raw JSON string written by
    // entities.ts, which always goes through `JSON.stringify()` —
    // single-line, no embedded newlines, valid YAML-as-JSON. If a
    // future writer ever stores multi-line JSON, the frontmatter will
    // break and this needs to defensively re-stringify (parse + stringify).
    // JSON-as-YAML is a deliberate simplification — saves writing a YAML
    // emitter for nested objects, and Obsidian Dataview parses it fine.
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
  const nowIso = input.nowIso ?? new Date().toISOString();
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
  const recent = loadRecentQueries(db, entityId, maxRecentQueries, nowIso);

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

// ===========================================================================
// Phase 3a.3 — LLM summary writer + cache
// ===========================================================================
//
// Writes the human-prose blockquote that sits between the title and the
// "## Facts" section. Decoupled from renderEntityPage so that:
//   - The deterministic projection (3a.2) can be tested without an LLM.
//   - The synthesis is async and writes to disk; the render is sync and
//     reads only.
//   - Each can be triggered on its own cadence (render = on-insert,
//     synthesize = daily pass).

/**
 * Caller for the summary LLM. Mirrors the shape of
 * `procedural-reflect.ts:ReflectionLlmCaller` so tests can stub identically
 * and so we can reuse `estimateHaikuCostUsd` plumbing if/when we
 * consolidate.
 */
export type SummaryLlmCaller = (prompt: string) => Promise<{
  summary: string;
  inputTokens: number;
  outputTokens: number;
}>;

export interface SynthesisInput {
  entityId: string;
  db: Database.Database;
  /** Inject for tests / cost gating. Defaults to the real Haiku caller. */
  llm?: SummaryLlmCaller;
  /** Override clock for determinism. ISO. */
  nowIso?: string;
  /**
   * Cap KUs fed to the LLM prompt. Bounds input cost — default 32 covers
   * typical entities while keeping a Haiku call comfortably under 2K
   * input tokens even with verbose KU text.
   */
  maxKusInPrompt?: number;
}

/**
 * Outcome of a synthesis attempt:
 *   - 'synthesized' — LLM was called, `wiki_summary` + cache stamps
 *                     written. Most expensive case.
 *   - 'reused'      — cache was still valid (recent enough AND ku_count
 *                     not drifted enough), no LLM call, no DB write.
 *   - 'skipped'     — entity has no KUs (nothing for the LLM to summarize)
 *                     OR entity_id doesn't exist. Cache stamps are NOT
 *                     written, so a future call after KUs land will
 *                     correctly trigger a fresh synthesis.
 */
export type SynthesisOutcome = 'synthesized' | 'reused' | 'skipped';

/** Regen if last synthesis was more than this long ago. 7 days per design. */
const SYNTHESIS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Regen if live ku_count drifted by more than this fraction. 20% per design. */
const KU_DRIFT_THRESHOLD = 0.2;

/**
 * Cache invalidation per design § "Cache invalidation rule":
 *   needsRegen =
 *     last_synthesis_at IS NULL
 *     OR (now - last_synthesis_at) > 7 days
 *     OR abs(liveKuCount - cachedKuCount) / max(1, cachedKuCount) > 0.20
 *
 * Exported for unit-testing the predicate directly without standing up a
 * full Haiku stub — and so a future caller can ask "is the cache stale?"
 * without paying for synthesis.
 */
export function shouldRegenerateSummary(opts: {
  lastSynthesisAt: string | null;
  cachedKuCount: number | null;
  liveKuCount: number;
  nowIso: string;
}): boolean {
  if (!opts.lastSynthesisAt) return true;
  const lastMs = Date.parse(opts.lastSynthesisAt);
  if (!Number.isFinite(lastMs)) return true;
  const nowMs = Date.parse(opts.nowIso);
  // Fail toward regeneration on a malformed `nowIso` rather than silently
  // skipping the staleness check. Only `Date.parse(new Date().toISOString())`
  // ever lands here in production, but if a caller ever passes a garbage
  // string we'd rather pay for one extra LLM call than reuse a year-old
  // cache that the staleness check would normally have invalidated.
  if (!Number.isFinite(nowMs)) return true;
  if (nowMs - lastMs > SYNTHESIS_STALE_MS) return true;
  const cached = opts.cachedKuCount ?? 0;
  const drift = Math.abs(opts.liveKuCount - cached) / Math.max(1, cached);
  if (drift > KU_DRIFT_THRESHOLD) return true;
  return false;
}

/**
 * Build the summary prompt. Bounded by maxKusInPrompt (default 32, sorted
 * by valid_from DESC). Prompt asks for 2-4 plain sentences and explicitly
 * forbids markdown headers / bullets / JSON so the output drops cleanly
 * into the blockquote.
 *
 * Exported for testability — callers shouldn't wire this directly.
 */
export function buildSummaryPrompt(input: {
  title: string;
  entityType: EntityType;
  canonical: Record<string, unknown> | null;
  kus: Array<{ text: string; validFrom: string }>;
}): string {
  const lines: string[] = [
    `You are summarizing what is known about a single ${input.entityType} based on extracted facts from emails.`,
    `Subject: ${input.title}`,
  ];
  if (input.canonical) {
    const interesting = Object.entries(input.canonical)
      .filter(([k, v]) => k !== 'name' && typeof v === 'string')
      .map(([k, v]) => `${k}=${String(v)}`);
    if (interesting.length > 0) {
      lines.push(`Identifiers: ${interesting.join(', ')}`);
    }
  }
  lines.push(
    '',
    'Facts (most recent first):',
    ...input.kus.map((k) => `  - [${k.validFrom.slice(0, 10)}] ${k.text}`),
    '',
    'Write 2 to 4 plain sentences summarizing the current state. Lead with the most decision-useful information. No bullet lists, no markdown headers, no JSON. Output only the summary text.',
  );
  return lines.join('\n');
}

/** Haiku 4.5 pricing — USD per 1M tokens. Mirrors procedural-reflect.ts. */
const HAIKU_INPUT_PER_MILLION = 1.0;
const HAIKU_OUTPUT_PER_MILLION = 5.0;

function estimateHaikuCostUsd(
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_PER_MILLION +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_MILLION
  );
}

/**
 * Default Haiku caller. Same `@ai-sdk/anthropic` plumbing as
 * `procedural-reflect.ts:defaultReflectionLlmCaller`. Writes one
 * `cost_log` row per call (operation='extract' — Haiku usage shares the
 * extraction cost bucket; we don't add a separate 'wiki_summary' op
 * because it'd require another `CostOperation` enum widening for ~$3/yr
 * of spend). Cost-log failure is non-fatal.
 */
export const defaultSummaryLlmCaller: SummaryLlmCaller = async (prompt) => {
  const { generateText } = await import('ai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { readEnvValue } = await import('../env.js');
  const apiKey = readEnvValue('ANTHROPIC_API_KEY');
  const anthropic = createAnthropic({
    apiKey: apiKey ?? '',
    baseURL:
      readEnvValue('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1',
  });
  const model = anthropic('claude-haiku-4-5-20251001');
  const result = await generateText({
    model,
    messages: [{ role: 'user', content: prompt }],
    // Cap matches the design (4-sentence summary). 256 tokens ≈ 6-8
    // sentences; a 4-sentence target plus model overhead lands well
    // inside the cap without truncation.
    maxOutputTokens: 256,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (result as any).usage ?? {};
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  try {
    // Distinct CostOperation bucket so wiki-summary spend is attributable
    // separately from `extract` and `reflect` in the digest's cost section.
    // Mirrors the precedent set when procedural-reflect added `'reflect'`.
    logCost({
      provider: 'anthropic',
      operation: 'wiki_summary',
      units: inputTokens + outputTokens,
      costUsd: estimateHaikuCostUsd(inputTokens, outputTokens),
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'wiki-projection: cost_log write failed (non-fatal)',
    );
  }
  return {
    summary: result.text.trim(),
    inputTokens,
    outputTokens,
  };
};

/**
 * Synthesize (or reuse) the LLM summary for one entity. Writes
 * `entities.wiki_summary`, `last_synthesis_at`, and
 * `ku_count_at_last_synthesis` on success. Idempotent under cache —
 * calling twice in quick succession costs one LLM call, not two.
 *
 * Errors from the LLM are caught and logged but never thrown; the
 * function returns 'reused' with the existing cache (or 'skipped' if no
 * cache exists yet). This way the daily synthesizer cron can fail one
 * entity without blowing up the whole pass.
 */
export async function synthesizeEntitySummary(
  input: SynthesisInput,
): Promise<SynthesisOutcome> {
  const { db, entityId } = input;
  const llm = input.llm ?? defaultSummaryLlmCaller;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const maxKus = input.maxKusInPrompt ?? 32;

  const entity = loadEntity(db, entityId);
  if (!entity) return 'skipped';

  const liveCount = liveKuCount(db, entityId);
  if (liveCount === 0) return 'skipped';

  const stale = shouldRegenerateSummary({
    lastSynthesisAt: entity.last_synthesis_at,
    cachedKuCount: entity.ku_count_at_last_synthesis,
    liveKuCount: liveCount,
    nowIso,
  });
  if (!stale) return 'reused';

  // Daily budget gate. Mirrors extract.ts:428 — fails-closed when today's
  // total Anthropic spend (across extract + reflect + wiki_summary) is at
  // or above the configured cap, so a runaway loop in any one workload
  // can't drain the others' budget. Returns 'reused' when prior cache
  // exists (so users still see something) and 'skipped' otherwise (so
  // nothing is over-stamped — next pass after the budget window resets
  // tries again).
  const day = nowIso.slice(0, 10);
  const spent = getTodaysAnthropicSpend(day);
  const budget = getDailyLlmBudgetUsd();
  if (spent >= budget) {
    logger.warn(
      { entityId, spent, budget, day },
      'wiki-projection: daily Anthropic budget exceeded — skipping LLM call',
    );
    return entity.last_synthesis_at ? 'reused' : 'skipped';
  }

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
  // Note: `kus` is capped at `maxKus` (default 32) — the LLM may not see
  // every live KU. `liveCount` (above) reflects the TRUE un-superseded
  // count and is what gets stamped into `ku_count_at_last_synthesis`.
  // The drift predicate uses the true count so regen fires whenever new
  // KUs land, regardless of whether the LLM saw them last time.
  const kus = loadFacts(db, entityId, maxKus).map((k) => ({
    text: k.text,
    validFrom: k.valid_from,
  }));

  let summary: string;
  try {
    const out = await llm(
      buildSummaryPrompt({
        title,
        entityType: entity.entity_type,
        canonical,
        kus,
      }),
    );
    summary = out.summary.trim();
    if (summary.length === 0) {
      logger.warn(
        { entityId },
        'wiki-projection: LLM returned empty summary — keeping existing cache',
      );
      return entity.last_synthesis_at ? 'reused' : 'skipped';
    }
  } catch (err) {
    logger.warn(
      { entityId, err: err instanceof Error ? err.message : String(err) },
      'wiki-projection: summary LLM call failed — keeping existing cache',
    );
    return entity.last_synthesis_at ? 'reused' : 'skipped';
  }

  // Single UPDATE writes all three cache fields atomically. Skipping a
  // transaction on purpose — one row, three columns, SQLite UPDATE is
  // already atomic at the row level.
  db.prepare(
    `UPDATE entities
        SET wiki_summary = ?,
            last_synthesis_at = ?,
            ku_count_at_last_synthesis = ?,
            updated_at = ?
      WHERE entity_id = ?`,
  ).run(summary, nowIso, liveCount, nowIso, entityId);

  return 'synthesized';
}
