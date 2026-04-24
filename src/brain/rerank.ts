/**
 * Brain cross-encoder reranker — `ms-marco-MiniLM-L-6-v2` via
 * `@huggingface/transformers`. Enabled from P1 day 1 (locked by
 * .omc/design/brain-architecture-v2.md §11).
 *
 * The cross-encoder scores each (query, candidate) pair as a single
 * forward pass — much better than the bi-encoder (embedding) similarity
 * for retrieval quality, at the cost of O(N) model calls per query.
 * RRF cuts the candidate pool to ~50 before reranking, which keeps
 * latency manageable.
 *
 * Singleton pattern mirrors embed.ts. Tests mock `pipeline()`.
 */

import type { TextClassificationPipeline } from '@huggingface/transformers';

import { logger } from '../logger.js';

const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  text: string;
  score: number;
}

let pipelinePromise: Promise<TextClassificationPipeline> | null = null;

/** @internal — exported for tests. */
export async function getRerankPipeline(): Promise<TextClassificationPipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    logger.info({ model: MODEL_NAME }, 'Loading rerank model (first call)');
    const { pipeline } = await import('@huggingface/transformers');
    // The cross-encoder is served as a `text-classification` pipeline in
    // transformers.js. It takes {text, text_pair} or a stringified version
    // and returns a score.
    const pipe = (await pipeline(
      'text-classification',
      MODEL_NAME,
    )) as TextClassificationPipeline;
    logger.info({ model: MODEL_NAME }, 'Rerank model loaded');
    return pipe;
  })();
  return pipelinePromise;
}

/** @internal — tests only. */
export function _resetRerankPipeline(): void {
  pipelinePromise = null;
}

/**
 * Rerank `candidates` against `query` and return the top `topK` sorted by
 * descending relevance score. Stable within ties — input order preserved.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  topK: number,
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];
  if (topK <= 0) return [];
  const pipe = await getRerankPipeline();

  // transformers.js cross-encoder accepts a single object or an array of
  // objects shaped as {text, text_pair}. Batching up the whole candidate
  // list is the cheapest path.
  const inputs = candidates.map((c) => ({ text: query, text_pair: c.text }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await (pipe as any)(inputs)) as
    | Array<{ label?: string; score: number }>
    | { label?: string; score: number };

  const rawArr = Array.isArray(raw) ? raw : [raw];
  if (rawArr.length !== candidates.length) {
    throw new Error(
      `rerank: expected ${candidates.length} scores, got ${rawArr.length}`,
    );
  }

  const scored: RerankResult[] = candidates.map((c, i) => ({
    id: c.id,
    text: c.text,
    score: rawArr[i].score,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
