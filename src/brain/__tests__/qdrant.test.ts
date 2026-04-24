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

// Fake Qdrant client used across tests.
function makeFakeClient() {
  return {
    collectionExists: vi.fn(),
    createCollection: vi.fn(),
    upsert: vi.fn(),
    search: vi.fn(),
  };
}

import {
  _setQdrantClientForTest,
  BRAIN_COLLECTION,
  ensureBrainCollection,
  searchSemantic,
  upsertKu,
} from '../qdrant.js';

describe('brain/qdrant', () => {
  let fake: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    fake = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setQdrantClientForTest(fake as any);
  });

  afterEach(() => {
    _setQdrantClientForTest(null);
  });

  it('collection name follows ku_<model>_<dim> convention', () => {
    expect(BRAIN_COLLECTION).toBe('ku_nomic-embed-text-v1.5_768');
  });

  it('ensureBrainCollection is a no-op if the collection already exists', async () => {
    fake.collectionExists.mockResolvedValue({ exists: true });
    await ensureBrainCollection();
    expect(fake.createCollection).not.toHaveBeenCalled();
  });

  it('ensureBrainCollection creates with 768d cosine', async () => {
    fake.collectionExists.mockResolvedValue({ exists: false });
    fake.createCollection.mockResolvedValue({});
    await ensureBrainCollection();
    expect(fake.createCollection).toHaveBeenCalledWith(BRAIN_COLLECTION, {
      vectors: { size: 768, distance: 'Cosine' },
    });
  });

  it('upsertKu forwards kuId, vector, and payload', async () => {
    fake.upsert.mockResolvedValue({});
    await upsertKu({
      kuId: 'KU-1',
      vector: [0.1, 0.2, 0.3],
      payload: {
        account: 'work',
        scope: ['sales'],
        model_version: 'nomic-embed-text-v1.5:768',
        valid_from: '2026-04-23T10:00:00Z',
        recorded_at: '2026-04-23T10:05:00Z',
        source_type: 'email',
      },
    });
    expect(fake.upsert).toHaveBeenCalledTimes(1);
    const [coll, payload] = fake.upsert.mock.calls[0];
    expect(coll).toBe(BRAIN_COLLECTION);
    expect(payload.points[0].id).toBe('KU-1');
    expect(payload.points[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(payload.points[0].payload.model_version).toBe(
      'nomic-embed-text-v1.5:768',
    );
    expect(payload.points[0].payload.account).toBe('work');
  });

  it('upsertKu defaults model_version when caller omits it', async () => {
    fake.upsert.mockResolvedValue({});
    await upsertKu({
      kuId: 'KU-2',
      vector: [0, 0, 0],
      payload: {
        account: 'work',
        valid_from: 'now',
        recorded_at: 'now',
        source_type: 'email',
      } as any,
    });
    const payload = fake.upsert.mock.calls[0][1];
    expect(payload.points[0].payload.model_version).toBe(
      'nomic-embed-text-v1.5:768',
    );
  });

  it('searchSemantic always filters by model_version', async () => {
    fake.search.mockResolvedValue([]);
    await searchSemantic([0.1], { modelVersion: 'nomic-embed-text-v1.5:768' }, 10);
    const args = fake.search.mock.calls[0][1];
    const must = args.filter.must as Array<{
      key: string;
      match: { value: string };
    }>;
    expect(must.some((m) => m.key === 'model_version')).toBe(true);
    expect(
      must.find((m) => m.key === 'model_version')!.match.value,
    ).toBe('nomic-embed-text-v1.5:768');
  });

  it('searchSemantic adds account filter when present', async () => {
    fake.search.mockResolvedValue([]);
    await searchSemantic(
      [0.1],
      { modelVersion: 'nomic-embed-text-v1.5:768', account: 'work' },
      10,
    );
    const must = fake.search.mock.calls[0][1].filter.must as Array<{
      key: string;
    }>;
    expect(must.some((m) => m.key === 'account')).toBe(true);
  });

  it('searchSemantic maps Qdrant hits to {id, score, payload}', async () => {
    fake.search.mockResolvedValue([
      {
        id: 'KU-A',
        score: 0.91,
        payload: {
          account: 'work',
          model_version: 'nomic-embed-text-v1.5:768',
          source_type: 'email',
          valid_from: 'now',
          recorded_at: 'now',
        },
      },
    ]);
    const hits = await searchSemantic(
      [0.1, 0.2],
      { modelVersion: 'nomic-embed-text-v1.5:768' },
      5,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('KU-A');
    expect(hits[0].score).toBeCloseTo(0.91);
    expect(hits[0].payload.source_type).toBe('email');
  });

  it('upsertKu returns void without throwing', async () => {
    fake.upsert.mockResolvedValue({});
    await expect(
      upsertKu({
        kuId: 'x',
        vector: [0],
        payload: {
          account: 'work',
          model_version: 'nomic-embed-text-v1.5:768',
          valid_from: 'now',
          recorded_at: 'now',
          source_type: 'email',
        },
      }),
    ).resolves.toBeUndefined();
  });
});
