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

const pipelineMock = vi.fn();
const pipelineFactory = vi.fn(async () => pipelineMock);
vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineFactory,
}));

import { _resetRerankPipeline, rerank } from '../rerank.js';

describe('brain/rerank', () => {
  beforeEach(() => {
    _resetRerankPipeline();
    pipelineMock.mockReset();
    pipelineFactory.mockClear();
  });

  afterEach(() => {
    _resetRerankPipeline();
  });

  it('returns empty array when no candidates', async () => {
    const out = await rerank('q', [], 5);
    expect(out).toEqual([]);
    expect(pipelineFactory).not.toHaveBeenCalled();
  });

  it('returns empty array when topK <= 0', async () => {
    const out = await rerank('q', [{ id: 'a', text: 't' }], 0);
    expect(out).toEqual([]);
  });

  it('sorts candidates by descending score', async () => {
    pipelineMock.mockResolvedValue([
      { score: 0.2 },
      { score: 0.9 },
      { score: 0.5 },
    ]);
    const out = await rerank(
      'q',
      [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'bravo' },
        { id: 'c', text: 'charlie' },
      ],
      3,
    );
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(out[0].score).toBe(0.9);
  });

  it('truncates to topK after sort', async () => {
    pipelineMock.mockResolvedValue([
      { score: 0.1 },
      { score: 0.2 },
      { score: 0.3 },
      { score: 0.4 },
    ]);
    const out = await rerank(
      'q',
      [
        { id: 'a', text: 'a' },
        { id: 'b', text: 'b' },
        { id: 'c', text: 'c' },
        { id: 'd', text: 'd' },
      ],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(['d', 'c']);
  });

  it('passes {text, text_pair} shape to the cross-encoder', async () => {
    pipelineMock.mockResolvedValue([{ score: 0.5 }]);
    await rerank('my query', [{ id: 'x', text: 'some candidate' }], 1);
    const input = pipelineMock.mock.calls[0][0];
    expect(Array.isArray(input)).toBe(true);
    expect(input[0]).toEqual({
      text: 'my query',
      text_pair: 'some candidate',
    });
  });

  it('throws if pipeline returns a mismatched length', async () => {
    pipelineMock.mockResolvedValue([{ score: 0.5 }]); // 1 score, 2 inputs
    await expect(
      rerank(
        'q',
        [
          { id: 'a', text: 'a' },
          { id: 'b', text: 'b' },
        ],
        2,
      ),
    ).rejects.toThrow(/expected 2 scores/);
  });
});
