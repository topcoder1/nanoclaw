import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub .env fallback so tests don't see the developer's real QDRANT_URL /
// OPENAI_API_KEY from the repo root .env file. Without this, queryFactsSemantic
// would hit a real Qdrant instance, return [], and the FTS5 fallback branch
// (which this test is verifying) would never execute.
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  readEnvValue: vi.fn((name: string) => process.env[name] || undefined),
}));

import { _initTestDatabase } from '../db.js';
import {
  initKnowledgeStore,
  storeFact,
  queryFacts,
  queryFactsSemantic,
  ensureQdrantCollection,
  deleteFact,
  getAllFacts,
} from './knowledge-store.js';

beforeEach(() => {
  _initTestDatabase();
  initKnowledgeStore();
});

describe('Knowledge Store', () => {
  it('stores and retrieves a fact', () => {
    const id = storeFact({
      text: 'User prefers dark mode for all applications',
      domain: 'preferences',
      source: 'conversation',
    });
    expect(id).toBeGreaterThan(0);

    const facts = getAllFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('User prefers dark mode for all applications');
    expect(facts[0].domain).toBe('preferences');
  });

  it('queries facts with FTS5 text search', () => {
    storeFact({
      text: 'User prefers dark mode',
      domain: 'preferences',
      source: 'conversation',
    });
    storeFact({
      text: 'Meeting with Alice on Thursday',
      domain: 'calendar',
      source: 'email',
    });
    storeFact({
      text: 'Dark chocolate is the favorite',
      domain: 'food',
      source: 'conversation',
    });

    const results = queryFacts('dark');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((f) => f.text.includes('dark mode'))).toBe(true);
  });

  it('filters by domain', () => {
    storeFact({
      text: 'Prefers TypeScript',
      domain: 'tech',
      source: 'conversation',
    });
    storeFact({
      text: 'Prefers sushi',
      domain: 'food',
      source: 'conversation',
    });

    const techFacts = getAllFacts({ domain: 'tech' });
    expect(techFacts).toHaveLength(1);
    expect(techFacts[0].text).toBe('Prefers TypeScript');
  });

  it('filters by groupId', () => {
    storeFact({
      text: 'Group-specific fact',
      groupId: 'main',
      source: 'agent',
    });
    storeFact({
      text: 'Other group fact',
      groupId: 'work',
      source: 'agent',
    });

    const mainFacts = getAllFacts({ groupId: 'main' });
    expect(mainFacts).toHaveLength(1);
    expect(mainFacts[0].group_id).toBe('main');
  });

  it('deletes a fact', () => {
    const id = storeFact({
      text: 'Temporary fact',
      source: 'test',
    });

    expect(deleteFact(id)).toBe(true);
    expect(getAllFacts()).toHaveLength(0);
  });

  it('returns false when deleting non-existent fact', () => {
    expect(deleteFact(9999)).toBe(false);
  });

  it('respects limit in queryFacts', () => {
    for (let i = 0; i < 20; i++) {
      storeFact({ text: `Fact number ${i}`, source: 'test' });
    }

    const results = queryFacts('', { limit: 5 });
    expect(results).toHaveLength(5);
  });

  it('queries with combined text and domain filter', () => {
    storeFact({
      text: 'Prefers Python for scripting',
      domain: 'tech',
      source: 'conversation',
    });
    storeFact({
      text: 'Python is a type of snake',
      domain: 'animals',
      source: 'conversation',
    });

    const results = queryFacts('Python', { domain: 'tech' });
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe('tech');
  });
});

describe('ensureQdrantCollection', () => {
  it('is a callable function', () => {
    expect(typeof ensureQdrantCollection).toBe('function');
  });

  it('succeeds silently when QDRANT_URL is not set', async () => {
    await expect(ensureQdrantCollection()).resolves.toBeUndefined();
  });
});

describe('queryFactsSemantic groupId filter', () => {
  it('passes groupId filter to FTS5 fallback when Qdrant unavailable', async () => {
    storeFact({
      text: 'Alpha fact for group A',
      source: 'test',
      groupId: 'group-a',
    });
    storeFact({
      text: 'Alpha fact for group B',
      source: 'test',
      groupId: 'group-b',
    });

    const results = await queryFactsSemantic('Alpha fact', {
      groupId: 'group-a',
    });
    expect(results.every((f) => f.group_id === 'group-a')).toBe(true);
  });
});

describe('vector search fallback', () => {
  it('falls back to FTS5 when Qdrant is unavailable', async () => {
    storeFact({
      text: 'User prefers morning meetings',
      source: 'conversation',
      domain: 'preferences',
    });
    const results = await queryFactsSemantic('morning meeting preferences');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('morning');
  });
});
