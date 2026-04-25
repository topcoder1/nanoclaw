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

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  _shutdownEntityQueue,
  attachAlias,
  createCompanyFromDomain,
  createPersonFromEmail,
  createProjectFromRepoSlug,
  parseRepoSlugFromSourceRef,
  resolveByDomain,
  resolveByEmail,
  resolveByRepoSlug,
} from '../entities.js';

describe('brain/entities', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-entities-'));
  });

  afterEach(async () => {
    await _shutdownEntityQueue();
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolveByEmail returns null when no alias exists', () => {
    // Force DB init.
    getBrainDb();
    expect(resolveByEmail('nobody@example.com')).toBeNull();
  });

  it('createPersonFromEmail creates a person + email alias on first call', async () => {
    const e = await createPersonFromEmail('Alice@Example.COM', 'Alice');
    expect(e.entity_type).toBe('person');
    expect(e.canonical).toMatchObject({ name: 'Alice' });

    const db = getBrainDb();
    const alias = db
      .prepare(
        `SELECT entity_id, field_value, confidence FROM entity_aliases WHERE field_name = 'email'`,
      )
      .get() as { entity_id: string; field_value: string; confidence: number };
    // Normalization: lowercased + trimmed.
    expect(alias.field_value).toBe('alice@example.com');
    expect(alias.entity_id).toBe(e.entity_id);
    expect(alias.confidence).toBe(1.0);
  });

  it('createPersonFromEmail is idempotent — second call returns same entity', async () => {
    const first = await createPersonFromEmail('bob@example.com');
    const second = await createPersonFromEmail('bob@example.com');
    const third = await createPersonFromEmail('BOB@Example.Com');
    expect(second.entity_id).toBe(first.entity_id);
    expect(third.entity_id).toBe(first.entity_id);

    const db = getBrainDb();
    const rows = db
      .prepare(`SELECT COUNT(*) as n FROM entities WHERE entity_type='person'`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('resolveByEmail returns the created entity exactly', async () => {
    const created = await createPersonFromEmail('carol@example.com', 'Carol');
    const resolved = resolveByEmail('carol@example.com');
    expect(resolved).not.toBeNull();
    expect(resolved!.entity_id).toBe(created.entity_id);
  });

  it('createCompanyFromDomain normalizes and creates a company', async () => {
    const e = await createCompanyFromDomain('WWW.Example.COM');
    expect(e.entity_type).toBe('company');
    expect(e.canonical).toMatchObject({ domain: 'example.com' });

    const again = await createCompanyFromDomain('example.com');
    expect(again.entity_id).toBe(e.entity_id);
  });

  it('resolveByDomain returns null for unknown, entity for known', async () => {
    expect(resolveByDomain('nothing.example')).toBeNull();
    const created = await createCompanyFromDomain('acme.co');
    const resolved = resolveByDomain('acme.co');
    expect(resolved!.entity_id).toBe(created.entity_id);
  });

  it('attachAlias is a no-op when alias already points to the entity', async () => {
    const e = await createPersonFromEmail('dave@example.com');
    await attachAlias({
      entityId: e.entity_id,
      fieldName: 'email',
      fieldValue: 'dave@example.com',
    });
    // Drain the write queue so the insert (if any) has been applied.
    await _shutdownEntityQueue();
    const db = getBrainDb();
    const n = db
      .prepare(
        `SELECT COUNT(*) as c FROM entity_aliases WHERE entity_id = ? AND field_name = 'email'`,
      )
      .get(e.entity_id) as { c: number };
    expect(n.c).toBe(1);
  });

  it('createProjectFromRepoSlug creates a project + repo_slug alias', async () => {
    const e = await createProjectFromRepoSlug('NanoClaw');
    expect(e.entity_type).toBe('project');
    expect(e.canonical).toMatchObject({
      name: 'nanoclaw',
      repo_slug: 'nanoclaw',
    });

    const db = getBrainDb();
    const alias = db
      .prepare(
        `SELECT entity_id, field_value, source_type, confidence
           FROM entity_aliases WHERE field_name = 'repo_slug'`,
      )
      .get() as {
      entity_id: string;
      field_value: string;
      source_type: string;
      confidence: number;
    };
    expect(alias.field_value).toBe('nanoclaw');
    expect(alias.source_type).toBe('repo');
    expect(alias.entity_id).toBe(e.entity_id);
    expect(alias.confidence).toBe(1.0);
  });

  it('createProjectFromRepoSlug is idempotent across case variants', async () => {
    const a = await createProjectFromRepoSlug('inbox_superpilot');
    const b = await createProjectFromRepoSlug('Inbox_Superpilot');
    const c = await createProjectFromRepoSlug('INBOX_SUPERPILOT');
    expect(b.entity_id).toBe(a.entity_id);
    expect(c.entity_id).toBe(a.entity_id);

    const db = getBrainDb();
    const n = db
      .prepare(`SELECT COUNT(*) as n FROM entities WHERE entity_type='project'`)
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('createProjectFromRepoSlug rejects empty slugs', async () => {
    await expect(createProjectFromRepoSlug('   ')).rejects.toThrow(/empty/i);
  });

  it('resolveByRepoSlug returns null for unknown, entity for known', async () => {
    expect(resolveByRepoSlug('never-synced')).toBeNull();
    const created = await createProjectFromRepoSlug('finsight');
    const resolved = resolveByRepoSlug('finsight');
    expect(resolved!.entity_id).toBe(created.entity_id);
  });

  it('parseRepoSlugFromSourceRef handles claw-sync ref formats', () => {
    expect(parseRepoSlugFromSourceRef('nanoclaw:src/index.ts')).toBe(
      'nanoclaw',
    );
    expect(
      parseRepoSlugFromSourceRef('asm-v2:asm-core-v2/cmd/api/main.go#L1-L118'),
    ).toBe('asm-v2');
    expect(parseRepoSlugFromSourceRef('inbox_superpilot:README.md')).toBe(
      'inbox_superpilot',
    );
    expect(parseRepoSlugFromSourceRef(null)).toBeNull();
    expect(parseRepoSlugFromSourceRef('')).toBeNull();
    expect(parseRepoSlugFromSourceRef(':leading-colon')).toBeNull();
    expect(parseRepoSlugFromSourceRef('no-colon-at-all')).toBeNull();
  });

  it('attachAlias adds a new identifier to an existing entity', async () => {
    const e = await createPersonFromEmail('erin@example.com');
    await attachAlias({
      entityId: e.entity_id,
      fieldName: 'slack_id',
      fieldValue: 'U123',
      sourceType: 'slack',
    });
    await _shutdownEntityQueue();
    const db = getBrainDb();
    const rows = db
      .prepare(
        `SELECT field_name FROM entity_aliases WHERE entity_id = ? ORDER BY field_name`,
      )
      .all(e.entity_id) as { field_name: string }[];
    expect(rows.map((r) => r.field_name).sort()).toEqual(['email', 'slack_id']);
  });
});
