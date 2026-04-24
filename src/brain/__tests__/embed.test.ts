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

// Mock @huggingface/transformers. The pipeline returned from `pipeline()` is a
// function that takes a string or string[] and options, and returns an object
// with a `.data` Float32Array. We capture every call so tests can assert the
// prefix + shape.
const pipelineMock = vi.fn();
const pipelineFactory = vi.fn(async () => pipelineMock);

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineFactory,
}));

import {
  _resetEmbeddingPipeline,
  EMBEDDING_DIMS,
  embedBatch,
  embedText,
  getEmbeddingModelVersion,
} from '../embed.js';

// Build a deterministic fake vector by filling a Float32Array with a seeded
// sequence so each test can distinguish outputs.
function fakeVector(seed: number, dims = EMBEDDING_DIMS): Float32Array {
  const arr = new Float32Array(dims);
  for (let i = 0; i < dims; i++) arr[i] = Math.sin(seed + i * 0.01);
  return arr;
}

describe('brain/embed', () => {
  beforeEach(() => {
    _resetEmbeddingPipeline();
    pipelineMock.mockReset();
    pipelineFactory.mockClear();
  });

  afterEach(() => {
    _resetEmbeddingPipeline();
  });

  it('getEmbeddingModelVersion returns the locked Nomic tag', () => {
    expect(getEmbeddingModelVersion()).toBe('nomic-embed-text-v1.5:768');
  });

  it('embedText prepends the document prefix in document mode', async () => {
    pipelineMock.mockResolvedValue({ data: fakeVector(1) });
    const vec = await embedText('hello world', 'document');
    expect(vec).toHaveLength(EMBEDDING_DIMS);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const calledWith = pipelineMock.mock.calls[0][0];
    expect(calledWith).toBe('search_document: hello world');
    // And normalize/pooling must both be set per Nomic recipe.
    expect(pipelineMock.mock.calls[0][1]).toEqual({
      pooling: 'mean',
      normalize: true,
    });
  });

  it('embedText prepends the query prefix in query mode', async () => {
    pipelineMock.mockResolvedValue({ data: fakeVector(2) });
    await embedText('what did she say', 'query');
    expect(pipelineMock.mock.calls[0][0]).toBe(
      'search_query: what did she say',
    );
  });

  it('embedText returns 768 numeric dimensions', async () => {
    pipelineMock.mockResolvedValue({ data: fakeVector(3) });
    const vec = await embedText('abc', 'document');
    expect(vec).toHaveLength(768);
    expect(typeof vec[0]).toBe('number');
  });

  it('embedText throws if pipeline returns wrong-length vector', async () => {
    pipelineMock.mockResolvedValue({ data: new Float32Array(256) });
    await expect(embedText('abc', 'document')).rejects.toThrow(
      /dimension mismatch/i,
    );
  });

  it('embedBatch returns one vector per input, in order', async () => {
    // Batched output from transformers: one concatenated Float32Array of
    // length batch*dims. Simulate shape accurately.
    pipelineMock.mockImplementation(async (input: string | string[]) => {
      const arr = Array.isArray(input) ? input : [input];
      const flat = new Float32Array(arr.length * EMBEDDING_DIMS);
      for (let b = 0; b < arr.length; b++) {
        const slice = fakeVector(b + 100);
        flat.set(slice, b * EMBEDDING_DIMS);
      }
      return { data: flat };
    });

    const vecs = await embedBatch(['a', 'b', 'c'], 'document');
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toHaveLength(EMBEDDING_DIMS);
    // Each row must be a distinct vector — order preserved.
    expect(vecs[0][0]).not.toBe(vecs[1][0]);
  });

  it('embedBatch splits inputs larger than 32 into sub-batches', async () => {
    pipelineMock.mockImplementation(async (input: string | string[]) => {
      const arr = Array.isArray(input) ? input : [input];
      expect(arr.length).toBeLessThanOrEqual(32);
      const flat = new Float32Array(arr.length * EMBEDDING_DIMS);
      return { data: flat };
    });
    const inputs = Array.from({ length: 50 }, (_, i) => `text-${i}`);
    const vecs = await embedBatch(inputs, 'document');
    expect(vecs).toHaveLength(50);
    // Two sub-batches: 32 + 18.
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('embedBatch preserves document prefix for every element', async () => {
    pipelineMock.mockImplementation(async (input: string | string[]) => {
      const arr = Array.isArray(input) ? input : [input];
      for (const s of arr) expect(s.startsWith('search_document: ')).toBe(true);
      return { data: new Float32Array(arr.length * EMBEDDING_DIMS) };
    });
    await embedBatch(['x', 'y'], 'document');
  });

  it('embedBatch empty input returns empty array without loading pipeline', async () => {
    const vecs = await embedBatch([], 'document');
    expect(vecs).toEqual([]);
    expect(pipelineFactory).not.toHaveBeenCalled();
  });

  it('pipeline is only loaded once across calls (singleton)', async () => {
    pipelineMock.mockResolvedValue({ data: fakeVector(4) });
    await embedText('a', 'document');
    await embedText('b', 'document');
    await embedText('c', 'query');
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });
});
