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
    setPayload: vi.fn(),
  };
}

import {
  _setQdrantClientForTest,
  BRAIN_COLLECTION,
  ensureBrainCollection,
  kuPointId,
  searchSemantic,
  setPayload,
  upsertKu,
} from '../qdrant.js';

const UUID_V5_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  it('upsertKu derives a UUIDv5 point id and carries the ULID in payload.ku_id', async () => {
    fake.upsert.mockResolvedValue({});
    // A realistic ULID (26-char Crockford Base32).
    const ulid = '01HYZ0000000000000000000AB';
    await upsertKu({
      kuId: ulid,
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
    // Point id is UUIDv5, not the raw ULID.
    expect(payload.points[0].id).toMatch(UUID_V5_RE);
    expect(payload.points[0].id).not.toBe(ulid);
    // Derivation is deterministic.
    expect(payload.points[0].id).toBe(kuPointId(ulid));
    expect(payload.points[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(payload.points[0].payload.model_version).toBe(
      'nomic-embed-text-v1.5:768',
    );
    expect(payload.points[0].payload.account).toBe('work');
    // Logical ULID is preserved in the payload so searchSemantic can map back.
    expect(payload.points[0].payload.ku_id).toBe(ulid);
  });

  it('upsertKu defaults model_version when caller omits it', async () => {
    fake.upsert.mockResolvedValue({});
    await upsertKu({
      kuId: '01HYZ0000000000000000000CD',
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

  it('searchSemantic maps Qdrant UUID ids back to payload.ku_id (logical ULID)', async () => {
    const ulid = '01HYZ0000000000000000000AB';
    fake.search.mockResolvedValue([
      {
        id: kuPointId(ulid), // Qdrant returns the UUIDv5 we wrote
        score: 0.91,
        payload: {
          ku_id: ulid,
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
    // Caller sees the logical ULID, not the UUIDv5.
    expect(hits[0].id).toBe(ulid);
    expect(hits[0].score).toBeCloseTo(0.91);
    expect(hits[0].payload.source_type).toBe('email');
  });

  it('setPayload targets the correct point id and merges payload', async () => {
    fake.setPayload.mockResolvedValue({});
    const ulid = '01HYZ0000000000000000000EF';
    await setPayload(ulid, { important: true });
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
    const [coll, args] = fake.setPayload.mock.calls[0];
    expect(coll).toBe(BRAIN_COLLECTION);
    expect(args.points[0]).toBe(kuPointId(ulid));
    expect(args.payload).toEqual({ important: true });
    expect(args.wait).toBe(true);
  });

  it('setPayload is a no-op when the Qdrant client is unavailable', async () => {
    _setQdrantClientForTest(null);
    // QDRANT_URL is likely unset in tests — falls through to no-op. If it
    // *is* set we still exit cleanly since we don't assert anything beyond
    // "no throw". The setPayload mock was on the prior fake client, which
    // is now detached.
    await expect(setPayload('anything', { x: 1 })).resolves.toBeUndefined();
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
