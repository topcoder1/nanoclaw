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
import { handleWikiCommand } from '../wiki-command.js';

function seedEntity(
  db: Database.Database,
  opts: {
    entityId: string;
    entityType: 'person' | 'company' | 'project' | 'product' | 'topic';
    name: string;
  },
): void {
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at,
                           last_synthesis_at, ku_count_at_last_synthesis, wiki_summary)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    opts.entityId,
    opts.entityType,
    JSON.stringify({ name: opts.name }),
    '2026-04-01T00:00:00Z',
    '2026-04-01T00:00:00Z',
  );
}

function seedKu(
  db: Database.Database,
  opts: { id: string; text: string; entityId: string },
): void {
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, confidence,
        valid_from, recorded_at, topic_key, important, superseded_at)
     VALUES (?, ?, 'email', ?, 'work', 0.9, ?, ?, NULL, 0, NULL)`,
  ).run(
    opts.id,
    opts.text,
    `thread-${opts.id}`,
    '2026-04-15T00:00:00Z',
    '2026-04-15T00:00:00Z',
  );
  db.prepare(
    `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
  ).run(opts.id, opts.entityId);
}

describe('brain/wiki-command', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wiki-cmd-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns usage text on empty args', async () => {
    const reply = await handleWikiCommand('   ', { baseDir: tmpDir });
    expect(reply).toContain('Usage:');
    expect(reply).toContain('/wiki');
  });

  it('returns no-match message when nothing resolves', async () => {
    const reply = await handleWikiCommand('Nonexistent', { baseDir: tmpDir });
    expect(reply).toContain('No entity found');
    expect(reply).toContain('Nonexistent');
    expect(reply).toContain('/recall');
  });

  it('returns ambiguous-match list when query hits more than one entity', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HALICE1',
      entityType: 'person',
      name: 'Alice Smith',
    });
    seedEntity(db, {
      entityId: '01HALICE2',
      entityType: 'person',
      name: 'Alice Jones',
    });

    const reply = await handleWikiCommand('Alice', { baseDir: tmpDir });
    expect(reply).toContain('Multiple matches');
    expect(reply).toContain('Alice Smith');
    expect(reply).toContain('Alice Jones');
    expect(reply).toContain('Refine your query');
  });

  it('materializes the page and returns content for a single match (synthesis injected)', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HBOB',
      entityType: 'person',
      name: 'Bob Builder',
    });
    seedKu(db, {
      id: 'ku-bob',
      text: 'Bob runs the new build pipeline',
      entityId: '01HBOB',
    });

    const llm = vi.fn(async () => ({
      summary: 'Bob owns the build pipeline.',
      inputTokens: 100,
      outputTokens: 30,
    }));

    const reply = await handleWikiCommand('Bob', { baseDir: tmpDir, llm });

    expect(reply).toContain('# Bob Builder');
    expect(reply).toContain('Bob runs the new build pipeline');
    expect(reply).toContain('Bob owns the build pipeline.');
    expect(reply).toContain('Person/01HBOB.md');

    // File actually exists at the reported path.
    const pagePath = path.join(tmpDir, 'wiki', 'Person', '01HBOB.md');
    expect(fs.existsSync(pagePath)).toBe(true);
  });

  it('still replies with the deterministic projection when LLM synthesis throws', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HCAR',
      entityType: 'company',
      name: 'Carlson Co',
    });
    seedKu(db, {
      id: 'ku-c',
      text: 'Carlson signed the renewal',
      entityId: '01HCAR',
    });

    const llm = vi.fn(async () => {
      throw new Error('LLM down');
    });

    const reply = await handleWikiCommand('Carlson', { baseDir: tmpDir, llm });

    // No summary blockquote (synthesis failed → wiki_summary stays NULL),
    // but the deterministic projection still landed on disk.
    expect(reply).toContain('# Carlson Co');
    expect(reply).toContain('Carlson signed the renewal');
    expect(reply).toContain('Company/01HCAR.md');
  });

  it('resolves an entity-id prefix match (non-name path)', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HZED01',
      entityType: 'topic',
      name: 'zelda lore',
    });
    seedKu(db, { id: 'ku-z', text: 'zelda fact', entityId: '01HZED01' });

    const reply = await handleWikiCommand('01HZED', { baseDir: tmpDir });
    expect(reply).toContain('# zelda lore');
    expect(reply).toContain('Topic/01HZED01.md');
  });
});
