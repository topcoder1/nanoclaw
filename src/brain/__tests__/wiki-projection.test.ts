import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import type Database from 'better-sqlite3';
import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  ENTITY_NOT_FOUND,
  buildSummaryPrompt,
  renderEntityPage,
  shouldRegenerateSummary,
  synthesizeEntitySummary,
  type EntityType,
  type SummaryLlmCaller,
} from '../wiki-projection.js';

const FIXED_NOW = '2026-04-27T12:00:00Z';

interface SeedEntityOpts {
  entityId: string;
  entityType: EntityType;
  canonical?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  lastSynthesisAt?: string | null;
  kuCountAtLastSynthesis?: number | null;
  wikiSummary?: string | null;
}

function seedEntity(db: Database.Database, opts: SeedEntityOpts): void {
  const created = opts.createdAt ?? '2026-04-01T00:00:00Z';
  const updated = opts.updatedAt ?? created;
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at,
                           last_synthesis_at, ku_count_at_last_synthesis, wiki_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.entityId,
    opts.entityType,
    opts.canonical === null
      ? null
      : opts.canonical
        ? JSON.stringify(opts.canonical)
        : null,
    created,
    updated,
    opts.lastSynthesisAt ?? null,
    opts.kuCountAtLastSynthesis ?? null,
    opts.wikiSummary ?? null,
  );
}

interface SeedAliasOpts {
  aliasId?: string;
  entityId: string;
  fieldName: string;
  fieldValue: string;
  sourceType?: string;
  confidence?: number;
  validFrom?: string;
  validUntil?: string | null;
}

function seedAlias(db: Database.Database, opts: SeedAliasOpts): void {
  db.prepare(
    `INSERT INTO entity_aliases
       (alias_id, entity_id, source_type, source_ref, field_name,
        field_value, valid_from, valid_until, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.aliasId ?? `a-${opts.entityId}-${opts.fieldName}-${opts.fieldValue}`,
    opts.entityId,
    opts.sourceType ?? 'manual',
    null,
    opts.fieldName,
    opts.fieldValue,
    opts.validFrom ?? '2026-04-01T00:00:00Z',
    opts.validUntil ?? null,
    opts.confidence ?? 1.0,
  );
}

interface SeedRelationshipOpts {
  relId?: string;
  fromEntityId: string;
  toEntityId: string;
  relationship: string;
  validFrom?: string;
  validUntil?: string | null;
  confidence?: number;
}

function seedRelationship(
  db: Database.Database,
  opts: SeedRelationshipOpts,
): void {
  db.prepare(
    `INSERT INTO entity_relationships
       (rel_id, from_entity_id, relationship, to_entity_id,
        valid_from, valid_until, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.relId ??
      `r-${opts.fromEntityId}-${opts.relationship}-${opts.toEntityId}`,
    opts.fromEntityId,
    opts.relationship,
    opts.toEntityId,
    opts.validFrom ?? '2026-04-15T00:00:00Z',
    opts.validUntil ?? null,
    opts.confidence ?? 0.9,
  );
}

interface SeedKuOpts {
  id: string;
  text: string;
  topicKey?: string | null;
  entityId: string;
  validFrom?: string;
  recordedAt?: string;
  superseded?: boolean;
  important?: boolean;
  role?: 'subject' | 'object' | 'mentioned' | 'author';
}

function seedKu(db: Database.Database, opts: SeedKuOpts): void {
  const validFrom = opts.validFrom ?? '2026-04-15T00:00:00Z';
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, confidence,
        valid_from, recorded_at, topic_key, important, superseded_at)
     VALUES (?, ?, 'email', ?, 'work', 0.9, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.text,
    `thread-${opts.id}`,
    validFrom,
    opts.recordedAt ?? validFrom,
    opts.topicKey ?? null,
    opts.important ? 1 : 0,
    opts.superseded ? '2026-04-20T00:00:00Z' : null,
  );
  db.prepare(
    `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
  ).run(opts.id, opts.entityId, opts.role ?? 'mentioned');
}

interface SeedQueryOpts {
  queryId: string;
  text: string;
  recordedAt: string;
  retrievedKuIds: string[];
}

function seedRecallQuery(db: Database.Database, opts: SeedQueryOpts): void {
  db.prepare(
    `INSERT INTO ku_queries
       (id, query_text, caller, account, scope, result_count, duration_ms, recorded_at)
     VALUES (?, ?, 'recall-command', 'work', NULL, ?, 50, ?)`,
  ).run(opts.queryId, opts.text, opts.retrievedKuIds.length, opts.recordedAt);
  for (let i = 0; i < opts.retrievedKuIds.length; i++) {
    db.prepare(
      `INSERT INTO ku_retrievals
         (query_id, ku_id, rank, final_score, rank_score, recency_score, access_score, important_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.queryId, opts.retrievedKuIds[i], i, 0.5, 0.5, 0.5, 0, 0);
  }
}

describe('brain/wiki-projection — renderEntityPage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wiki-proj-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ENTITY_NOT_FOUND for unknown entity_id', () => {
    const db = getBrainDb();
    const out = renderEntityPage({ db, entityId: 'does-not-exist' });
    expect(out).toBe(ENTITY_NOT_FOUND);
  });

  it('renders a person with full data — frontmatter, summary, facts, aliases, relationships, recent', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-alice',
      entityType: 'person',
      canonical: { name: 'Alice Smith', email: 'alice@acme.co' },
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
      lastSynthesisAt: '2026-04-20T09:00:00Z',
      kuCountAtLastSynthesis: 4,
      wikiSummary:
        'Alice leads the Q4 renewal at Acme. Pricing discussions ongoing.',
    });
    seedEntity(db, {
      entityId: 'c-acme',
      entityType: 'company',
      canonical: { name: 'Acme Corp', domain: 'acme.co' },
    });
    seedAlias(db, {
      entityId: 'p-alice',
      fieldName: 'email',
      fieldValue: 'alice@acme.co',
      confidence: 1.0,
    });
    seedAlias(db, {
      entityId: 'p-alice',
      fieldName: 'name',
      fieldValue: 'Alice Smith',
      confidence: 0.9,
    });
    seedRelationship(db, {
      fromEntityId: 'p-alice',
      toEntityId: 'c-acme',
      relationship: 'works_at',
    });
    seedKu(db, {
      id: 'ku-1',
      text: 'Q4 renewal locked at $120K.',
      topicKey: 'renewal',
      entityId: 'p-alice',
      validFrom: '2026-04-19T10:00:00Z',
      important: true,
    });
    seedKu(db, {
      id: 'ku-2',
      text: 'Discussed annual term vs multi-year.',
      topicKey: 'renewal',
      entityId: 'p-alice',
      validFrom: '2026-04-15T10:00:00Z',
    });
    seedKu(db, {
      id: 'ku-3',
      text: 'Joined the call from Berlin.',
      topicKey: 'logistics',
      entityId: 'p-alice',
      validFrom: '2026-04-10T10:00:00Z',
    });
    seedRecallQuery(db, {
      queryId: 'q-1',
      text: 'what did Alice say about Q4 renewal?',
      recordedAt: '2026-04-26T14:00:00Z',
      retrievedKuIds: ['ku-1'],
    });
    seedRecallQuery(db, {
      queryId: 'q-2',
      text: 'Alice availability next week',
      recordedAt: '2026-04-25T09:00:00Z',
      retrievedKuIds: ['ku-3'],
    });

    const out = renderEntityPage({
      db,
      entityId: 'p-alice',
      nowIso: FIXED_NOW,
    });
    if (out === ENTITY_NOT_FOUND)
      throw new Error('unexpected ENTITY_NOT_FOUND');

    expect(out.entityType).toBe('person');
    expect(out.liveKuCount).toBe(3);

    // Frontmatter
    expect(out.markdown).toContain('entity_id: p-alice');
    expect(out.markdown).toContain('entity_type: person');
    expect(out.markdown).toContain('"Alice Smith"');
    expect(out.markdown).toContain('ku_count: 3');
    expect(out.markdown).toContain('last_synthesis_at: 2026-04-20T09:00:00Z');

    // Title (escapeMarkdown is identity for plain alphanum)
    expect(out.markdown).toContain('# Alice Smith');

    // Summary blockquote
    expect(out.markdown).toContain('> Alice leads the Q4 renewal at Acme.');

    // Facts grouped by topic_key (ORDER BY topic_key ASC, then valid_from
    // DESC within group). 'logistics' < 'renewal' alphabetically, so it
    // appears first. The most recent KU within "renewal" is the renewal-
    // closed one, which is also `important=1` and shows ⭐.
    const renewalIdx = out.markdown.indexOf('### renewal');
    const logisticsIdx = out.markdown.indexOf('### logistics');
    expect(renewalIdx).toBeGreaterThan(-1);
    expect(logisticsIdx).toBeGreaterThan(-1);
    expect(logisticsIdx).toBeLessThan(renewalIdx);
    // The KU text contains a literal `$` which escapeMarkdown does NOT
    // escape (not in the V1 special-char set). The important flag adds
    // a trailing ⭐.
    expect(out.markdown).toContain('Q4 renewal locked at $120K.');
    expect(out.markdown).toContain('⭐');

    // Aliases — both surface, ordered by confidence DESC
    expect(out.markdown).toContain('## Aliases');
    expect(out.markdown).toContain('**email**: alice@acme.co');
    expect(out.markdown).toContain('**name**: Alice Smith');

    // Relationships — derefences to_entity_id's canonical name
    expect(out.markdown).toContain('## Relationships');
    expect(out.markdown).toContain('**works\\_at** → Acme Corp');

    // Recent activity
    expect(out.markdown).toContain('## Recent activity');
    expect(out.markdown).toContain('2026-04-26 — `what did Alice say');
  });

  it('renders a company with no relationships, no recent queries', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'c-only',
      entityType: 'company',
      canonical: { name: 'Solo Co', domain: 'solo.co' },
    });
    seedAlias(db, {
      entityId: 'c-only',
      fieldName: 'domain',
      fieldValue: 'solo.co',
    });
    seedKu(db, {
      id: 'ku-c1',
      text: 'Solo Co mentioned in passing.',
      entityId: 'c-only',
    });

    const out = renderEntityPage({ db, entityId: 'c-only' });
    if (out === ENTITY_NOT_FOUND) throw new Error('unexpected');
    expect(out.entityType).toBe('company');
    expect(out.markdown).toContain('# Solo Co');
    expect(out.markdown).toContain('## Aliases');
    expect(out.markdown).not.toContain('## Relationships');
    expect(out.markdown).not.toContain('## Recent activity');
  });

  it('renders a topic entity with minimal canonical data — falls back to slug, then entity_id', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 't-with-slug',
      entityType: 'topic',
      canonical: { slug: 'q4-pricing' },
    });
    seedKu(db, {
      id: 'ku-t1',
      text: 'Pricing target is $120K ARR.',
      entityId: 't-with-slug',
    });
    const withSlug = renderEntityPage({ db, entityId: 't-with-slug' });
    if (withSlug === ENTITY_NOT_FOUND) throw new Error('unexpected');
    expect(withSlug.markdown).toContain('# q4-pricing');

    // Entity with NULL canonical — falls all the way through to entity_id.
    seedEntity(db, {
      entityId: 't-orphan',
      entityType: 'topic',
      canonical: null,
    });
    const orphan = renderEntityPage({ db, entityId: 't-orphan' });
    if (orphan === ENTITY_NOT_FOUND) throw new Error('unexpected');
    expect(orphan.markdown).toContain('# t-orphan');
  });

  it('renders an entity with one KU — "## Facts" still has the section heading', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-solo',
      entityType: 'person',
      canonical: { name: 'Bob' },
    });
    seedKu(db, {
      id: 'ku-solo',
      text: 'Bob said something.',
      entityId: 'p-solo',
      topicKey: null, // ungrouped
    });
    const out = renderEntityPage({ db, entityId: 'p-solo' });
    if (out === ENTITY_NOT_FOUND) throw new Error('unexpected');
    expect(out.markdown).toContain('## Facts');
    // NULL topic_key groups under "Other"
    expect(out.markdown).toContain('### Other');
    expect(out.markdown).toContain('Bob said something.');
    expect(out.liveKuCount).toBe(1);
  });

  it('renders the cached wiki_summary verbatim and omits the blockquote when NULL', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-cached',
      entityType: 'person',
      canonical: { name: 'Has Summary' },
      wikiSummary: 'Line one.\nLine two of the summary.',
    });
    seedEntity(db, {
      entityId: 'p-uncached',
      entityType: 'person',
      canonical: { name: 'No Summary' },
      wikiSummary: null,
    });
    seedKu(db, {
      id: 'ku-cached',
      text: 'fact',
      entityId: 'p-cached',
    });
    seedKu(db, {
      id: 'ku-uncached',
      text: 'fact',
      entityId: 'p-uncached',
    });

    const cached = renderEntityPage({ db, entityId: 'p-cached' });
    const uncached = renderEntityPage({ db, entityId: 'p-uncached' });
    if (cached === ENTITY_NOT_FOUND || uncached === ENTITY_NOT_FOUND) {
      throw new Error('unexpected');
    }
    expect(cached.markdown).toContain('> Line one.');
    expect(cached.markdown).toContain('> Line two of the summary.');
    // Blockquote section is fully absent for the NULL case — not "> null"
    // or an empty blockquote.
    expect(uncached.markdown).not.toContain('> ');
    expect(uncached.markdown).not.toContain('null');
  });

  it('hides superseded KUs and counts only live KUs in liveKuCount', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-mixed',
      entityType: 'person',
      canonical: { name: 'Mixed' },
    });
    seedKu(db, {
      id: 'ku-live',
      text: 'Active fact.',
      entityId: 'p-mixed',
    });
    seedKu(db, {
      id: 'ku-dead',
      text: 'Superseded fact.',
      entityId: 'p-mixed',
      superseded: true,
    });
    const out = renderEntityPage({ db, entityId: 'p-mixed' });
    if (out === ENTITY_NOT_FOUND) throw new Error('unexpected');
    expect(out.liveKuCount).toBe(1);
    expect(out.markdown).toContain('Active fact.');
    expect(out.markdown).not.toContain('Superseded fact.');
  });

  it('produces byte-identical output on repeated render — hash-stable for diff-aware writes', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-stable',
      entityType: 'person',
      canonical: { name: 'Stable Subject', email: 's@x.co' },
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
      lastSynthesisAt: '2026-04-20T09:00:00Z',
      kuCountAtLastSynthesis: 2,
      wikiSummary: 'Cached summary.',
    });
    seedAlias(db, {
      entityId: 'p-stable',
      fieldName: 'email',
      fieldValue: 's@x.co',
    });
    seedKu(db, {
      id: 'ku-stable-a',
      text: 'Fact A',
      topicKey: 'topic-a',
      entityId: 'p-stable',
      validFrom: '2026-04-19T10:00:00Z',
    });
    seedKu(db, {
      id: 'ku-stable-b',
      text: 'Fact B',
      topicKey: 'topic-b',
      entityId: 'p-stable',
      validFrom: '2026-04-18T10:00:00Z',
    });

    const a = renderEntityPage({ db, entityId: 'p-stable' });
    const b = renderEntityPage({ db, entityId: 'p-stable' });
    if (a === ENTITY_NOT_FOUND || b === ENTITY_NOT_FOUND) {
      throw new Error('unexpected');
    }
    expect(a.markdown).toBe(b.markdown);
    expect(a.liveKuCount).toBe(b.liveKuCount);
  });

  it('caps facts at maxFacts and recent queries at maxRecentQueries', () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-prolific',
      entityType: 'person',
      canonical: { name: 'Prolific' },
    });
    // 7 KUs all in same topic
    for (let i = 0; i < 7; i++) {
      seedKu(db, {
        id: `ku-p-${i}`,
        text: `fact ${i}`,
        topicKey: 'topic',
        entityId: 'p-prolific',
        validFrom: `2026-04-${10 + i}T10:00:00Z`,
      });
    }
    // 5 distinct queries that all retrieved one of the KUs
    for (let i = 0; i < 5; i++) {
      seedRecallQuery(db, {
        queryId: `q-p-${i}`,
        text: `query ${i}`,
        recordedAt: `2026-04-${20 + i}T10:00:00Z`,
        retrievedKuIds: [`ku-p-0`],
      });
    }

    const out = renderEntityPage({
      db,
      entityId: 'p-prolific',
      maxFacts: 3,
      maxRecentQueries: 2,
    });
    if (out === ENTITY_NOT_FOUND) throw new Error('unexpected');
    // liveKuCount reports the true count, not the capped count
    expect(out.liveKuCount).toBe(7);
    // Only 3 facts in the rendered Markdown — most recent first
    const factLines = out.markdown
      .split('\n')
      .filter((l) => l.startsWith('- fact '));
    expect(factLines).toHaveLength(3);
    expect(factLines[0]).toContain('fact 6');
    // Only 2 recent queries
    const queryLines = out.markdown
      .split('\n')
      .filter((l) => l.match(/^- 2026-\d{2}-\d{2} — `query/));
    expect(queryLines).toHaveLength(2);
  });
});

describe('brain/wiki-projection — shouldRegenerateSummary', () => {
  const NOW = '2026-04-27T12:00:00Z';

  it('regenerates when there is no prior synthesis', () => {
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: null,
        cachedKuCount: null,
        liveKuCount: 5,
        nowIso: NOW,
      }),
    ).toBe(true);
  });

  it('reuses when synthesis is fresh and ku count is unchanged', () => {
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-26T12:00:00Z', // 1 day ago
        cachedKuCount: 10,
        liveKuCount: 10,
        nowIso: NOW,
      }),
    ).toBe(false);
  });

  it('regenerates when last synthesis is older than 7 days', () => {
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-19T11:00:00Z', // 8 days ago
        cachedKuCount: 10,
        liveKuCount: 10,
        nowIso: NOW,
      }),
    ).toBe(true);
  });

  it('regenerates when ku count drifted >20% (gain)', () => {
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-26T12:00:00Z',
        cachedKuCount: 10,
        liveKuCount: 13, // 30% gain
        nowIso: NOW,
      }),
    ).toBe(true);
  });

  it('regenerates when ku count drifted >20% (loss, e.g. supersession)', () => {
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-26T12:00:00Z',
        cachedKuCount: 10,
        liveKuCount: 7, // 30% loss
        nowIso: NOW,
      }),
    ).toBe(true);
  });

  it('does not regenerate at exactly the 20% drift boundary', () => {
    // 20% gain — strictly greater required, equal is not enough.
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-26T12:00:00Z',
        cachedKuCount: 10,
        liveKuCount: 12,
        nowIso: NOW,
      }),
    ).toBe(false);
  });

  it('regenerates on first KU when cachedKuCount is NULL but lastSynthesisAt is recent (degenerate state)', () => {
    // This shouldn't happen in practice but be permissive — any drift
    // from "0 cached" toward live count > 0 should regen.
    expect(
      shouldRegenerateSummary({
        lastSynthesisAt: '2026-04-26T12:00:00Z',
        cachedKuCount: null,
        liveKuCount: 5,
        nowIso: NOW,
      }),
    ).toBe(true);
  });
});

describe('brain/wiki-projection — buildSummaryPrompt', () => {
  it('embeds title, type, and KU dates in chronological cue order', () => {
    const prompt = buildSummaryPrompt({
      title: 'Alice Smith',
      entityType: 'person',
      canonical: { name: 'Alice Smith', email: 'alice@acme.co' },
      kus: [
        { text: 'Recent fact', validFrom: '2026-04-26T10:00:00Z' },
        { text: 'Older fact', validFrom: '2026-04-15T10:00:00Z' },
      ],
    });
    expect(prompt).toContain('Subject: Alice Smith');
    expect(prompt).toContain('person');
    expect(prompt).toContain('email=alice@acme.co');
    expect(prompt).toContain('[2026-04-26] Recent fact');
    expect(prompt).toContain('[2026-04-15] Older fact');
    expect(prompt).toMatch(/2 to 4 plain sentences/);
    // Must not invite markdown that would corrupt the blockquote.
    expect(prompt).toMatch(/No bullet lists, no markdown headers/);
  });

  it('omits the Identifiers line when canonical is null or only has name', () => {
    const noCanon = buildSummaryPrompt({
      title: 'Bare',
      entityType: 'topic',
      canonical: null,
      kus: [{ text: 'x', validFrom: '2026-04-20T00:00:00Z' }],
    });
    expect(noCanon).not.toContain('Identifiers:');

    const nameOnly = buildSummaryPrompt({
      title: 'Just a name',
      entityType: 'person',
      canonical: { name: 'Just a name' },
      kus: [{ text: 'x', validFrom: '2026-04-20T00:00:00Z' }],
    });
    expect(nameOnly).not.toContain('Identifiers:');
  });
});

describe('brain/wiki-projection — synthesizeEntitySummary', () => {
  const NOW = '2026-04-27T12:00:00Z';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wiki-syn-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "skipped" for an unknown entity_id without calling the LLM', async () => {
    const db = getBrainDb();
    const llm = vi.fn() as unknown as SummaryLlmCaller;
    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'does-not-exist',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('skipped');
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns "skipped" for an entity with zero KUs without calling the LLM', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-empty',
      entityType: 'person',
      canonical: { name: 'No Facts Yet' },
    });
    const llm = vi.fn() as unknown as SummaryLlmCaller;
    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-empty',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('skipped');
    expect(llm).not.toHaveBeenCalled();
  });

  it('synthesizes on first call and writes wiki_summary + cache stamps', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-fresh',
      entityType: 'person',
      canonical: { name: 'Fresh Subject', email: 'f@x.co' },
    });
    seedKu(db, {
      id: 'ku-fresh-1',
      text: 'Closed Q4 deal.',
      entityId: 'p-fresh',
      validFrom: '2026-04-20T10:00:00Z',
    });
    seedKu(db, {
      id: 'ku-fresh-2',
      text: 'Joined the call from Berlin.',
      entityId: 'p-fresh',
      validFrom: '2026-04-15T10:00:00Z',
    });

    let receivedPrompt = '';
    const llm: SummaryLlmCaller = vi.fn(async (prompt: string) => {
      receivedPrompt = prompt;
      return {
        summary: 'Fresh closed Q4. Based out of Berlin.',
        inputTokens: 200,
        outputTokens: 30,
      };
    });

    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-fresh',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('synthesized');
    expect(llm).toHaveBeenCalledOnce();
    expect(receivedPrompt).toContain('Subject: Fresh Subject');
    expect(receivedPrompt).toContain('email=f@x.co');

    const row = db
      .prepare(
        `SELECT wiki_summary, last_synthesis_at, ku_count_at_last_synthesis
           FROM entities WHERE entity_id = ?`,
      )
      .get('p-fresh') as {
      wiki_summary: string;
      last_synthesis_at: string;
      ku_count_at_last_synthesis: number;
    };
    expect(row.wiki_summary).toBe('Fresh closed Q4. Based out of Berlin.');
    expect(row.last_synthesis_at).toBe(NOW);
    expect(row.ku_count_at_last_synthesis).toBe(2);
  });

  it('returns "reused" when cache is fresh and ku_count is stable, no LLM call', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-cached',
      entityType: 'person',
      canonical: { name: 'Cached' },
      lastSynthesisAt: '2026-04-26T12:00:00Z',
      kuCountAtLastSynthesis: 2,
      wikiSummary: 'Stable cached summary.',
    });
    seedKu(db, { id: 'k1', text: 'a', entityId: 'p-cached' });
    seedKu(db, { id: 'k2', text: 'b', entityId: 'p-cached' });

    const llm = vi.fn() as unknown as SummaryLlmCaller;
    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-cached',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('reused');
    expect(llm).not.toHaveBeenCalled();

    // Cache is unchanged.
    const summary = (
      db
        .prepare(`SELECT wiki_summary FROM entities WHERE entity_id = ?`)
        .get('p-cached') as { wiki_summary: string }
    ).wiki_summary;
    expect(summary).toBe('Stable cached summary.');
  });

  it('regenerates when ku_count drifted >20% since last synthesis', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-grown',
      entityType: 'person',
      canonical: { name: 'Grown' },
      lastSynthesisAt: '2026-04-26T12:00:00Z',
      kuCountAtLastSynthesis: 10,
      wikiSummary: 'Stale summary based on 10 facts.',
    });
    // Live count is 13 → 30% gain → trigger
    for (let i = 0; i < 13; i++) {
      seedKu(db, {
        id: `k-${i}`,
        text: `fact ${i}`,
        entityId: 'p-grown',
      });
    }
    const llm: SummaryLlmCaller = vi.fn(async () => ({
      summary: 'Updated summary based on 13 facts.',
      inputTokens: 300,
      outputTokens: 40,
    }));

    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-grown',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('synthesized');

    const row = db
      .prepare(
        `SELECT wiki_summary, ku_count_at_last_synthesis FROM entities WHERE entity_id = ?`,
      )
      .get('p-grown') as {
      wiki_summary: string;
      ku_count_at_last_synthesis: number;
    };
    expect(row.wiki_summary).toContain('13 facts');
    expect(row.ku_count_at_last_synthesis).toBe(13);
  });

  it('keeps existing cache and returns "reused" when LLM throws (degraded)', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-llm-fail',
      entityType: 'person',
      canonical: { name: 'Has Cache' },
      lastSynthesisAt: '2026-04-15T12:00:00Z', // stale (>7d) so regen would fire
      kuCountAtLastSynthesis: 1,
      wikiSummary: 'Old cached summary.',
    });
    seedKu(db, { id: 'k', text: 'x', entityId: 'p-llm-fail' });

    const llm: SummaryLlmCaller = vi.fn(async () => {
      throw new Error('upstream timeout');
    });

    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-llm-fail',
      llm,
      nowIso: NOW,
    });
    // LLM failed but the entity HAS prior cache, so we degrade to reused
    // rather than wiping it. The next pass will retry.
    expect(outcome).toBe('reused');

    const row = db
      .prepare(
        `SELECT wiki_summary, last_synthesis_at FROM entities WHERE entity_id = ?`,
      )
      .get('p-llm-fail') as {
      wiki_summary: string;
      last_synthesis_at: string;
    };
    // Old cache survives — no overwrite, no stamp update.
    expect(row.wiki_summary).toBe('Old cached summary.');
    expect(row.last_synthesis_at).toBe('2026-04-15T12:00:00Z');
  });

  it('returns "skipped" when LLM throws AND there is no prior cache', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-no-cache',
      entityType: 'person',
      canonical: { name: 'No Cache' },
    });
    seedKu(db, { id: 'k', text: 'x', entityId: 'p-no-cache' });

    const llm: SummaryLlmCaller = vi.fn(async () => {
      throw new Error('upstream timeout');
    });

    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-no-cache',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('skipped');
    // No fields were written.
    const row = db
      .prepare(
        `SELECT wiki_summary, last_synthesis_at FROM entities WHERE entity_id = ?`,
      )
      .get('p-no-cache') as {
      wiki_summary: string | null;
      last_synthesis_at: string | null;
    };
    expect(row.wiki_summary).toBeNull();
    expect(row.last_synthesis_at).toBeNull();
  });

  it('treats an empty LLM response as failure (does not write empty cache)', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: 'p-empty-resp',
      entityType: 'person',
      canonical: { name: 'Empty Response' },
    });
    seedKu(db, { id: 'k', text: 'x', entityId: 'p-empty-resp' });

    const llm: SummaryLlmCaller = vi.fn(async () => ({
      summary: '   ',
      inputTokens: 50,
      outputTokens: 0,
    }));

    const outcome = await synthesizeEntitySummary({
      db,
      entityId: 'p-empty-resp',
      llm,
      nowIso: NOW,
    });
    expect(outcome).toBe('skipped');
    const row = db
      .prepare(`SELECT wiki_summary FROM entities WHERE entity_id = ?`)
      .get('p-empty-resp') as { wiki_summary: string | null };
    expect(row.wiki_summary).toBeNull();
  });
});
