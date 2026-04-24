import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { backfillModelVersion } from '../backfill-qdrant.js';

const MODEL_VERSION = 'openai:text-embedding-3-small:1536';

interface FakePoint {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * Minimal fake implementing the scroll/setPayload surface used by the
 * backfill. Pages the store in fixed chunks, mirroring the real client.
 */
function makeFakeClient(points: FakePoint[]) {
  const scrolls: Array<{ offset: unknown }> = [];
  const setCalls: Array<{
    points: (string | number)[];
    payload: Record<string, unknown>;
  }> = [];

  return {
    scrolls,
    setCalls,
    points,
    async scroll(
      _collection: string,
      opts: { limit: number; offset?: string | number; with_payload?: boolean },
    ) {
      scrolls.push({ offset: opts.offset });
      const start = typeof opts.offset === 'number' ? opts.offset : 0;
      const limit = opts.limit;
      const slice = points.slice(start, start + limit);
      const nextOffset = start + limit < points.length ? start + limit : null;
      return {
        points: slice.map((p) => ({ id: p.id, payload: p.payload })),
        next_page_offset: nextOffset,
      };
    },
    async setPayload(
      _collection: string,
      opts: { payload: Record<string, unknown>; points: (string | number)[] },
    ) {
      setCalls.push({ points: opts.points, payload: opts.payload });
      for (const id of opts.points) {
        const p = points.find((x) => x.id === id);
        if (p) Object.assign(p.payload, opts.payload);
      }
    },
  };
}

describe('backfillModelVersion', () => {
  it('updates all points that lack model_version', async () => {
    const client = makeFakeClient([
      { id: 'a', payload: { text: 'a' } },
      { id: 'b', payload: { text: 'b' } },
      { id: 'c', payload: { text: 'c' } },
    ]);

    const result = await backfillModelVersion(
      client as unknown as Parameters<typeof backfillModelVersion>[0],
      'test',
    );

    expect(result.updated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(3);

    expect(client.setCalls).toHaveLength(1);
    expect(client.setCalls[0].payload).toEqual({
      model_version: MODEL_VERSION,
    });
    expect(client.setCalls[0].points.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips points that already have model_version', async () => {
    const client = makeFakeClient([
      { id: 'a', payload: { text: 'a', model_version: MODEL_VERSION } },
      { id: 'b', payload: { text: 'b' } },
      { id: 'c', payload: { text: 'c', model_version: MODEL_VERSION } },
    ]);

    const result = await backfillModelVersion(
      client as unknown as Parameters<typeof backfillModelVersion>[0],
      'test',
    );

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(3);
    expect(client.setCalls[0].points).toEqual(['b']);
  });

  it('is idempotent — second run updates nothing', async () => {
    const client = makeFakeClient([
      { id: 'a', payload: { text: 'a' } },
      { id: 'b', payload: { text: 'b' } },
    ]);

    const first = await backfillModelVersion(
      client as unknown as Parameters<typeof backfillModelVersion>[0],
      'test',
    );
    expect(first.updated).toBe(2);

    const second = await backfillModelVersion(
      client as unknown as Parameters<typeof backfillModelVersion>[0],
      'test',
    );
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(2);
    // setPayload called only on the first run.
    expect(client.setCalls).toHaveLength(1);
  });

  it('pages through all points when the collection exceeds one page', async () => {
    const points: FakePoint[] = [];
    for (let i = 0; i < 600; i++) {
      points.push({ id: `p${i}`, payload: { text: `t${i}` } });
    }
    const client = makeFakeClient(points);

    const result = await backfillModelVersion(
      client as unknown as Parameters<typeof backfillModelVersion>[0],
      'test',
    );

    expect(result.updated).toBe(600);
    expect(result.total).toBe(600);
    // 600 / 256 → 3 pages.
    expect(client.scrolls.length).toBe(3);
  });
});
