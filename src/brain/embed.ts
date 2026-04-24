/**
 * Brain embeddings — local `nomic-embed-text-v1.5` via `@huggingface/transformers`.
 *
 * Design: .omc/design/brain-architecture-v2.md §11 (locked: no OpenAI).
 * Output dim: 768. Matryoshka-truncatable, but P1 uses the full 768.
 *
 * Nomic requires a task-specific prefix on every input:
 *   - Documents being indexed: "search_document: <text>"
 *   - Query strings at retrieval time: "search_query: <text>"
 *
 * The model is loaded lazily on first call (singleton) to avoid the ~140MB
 * ONNX download at boot. Tests mock `pipeline()` so the real model is never
 * fetched in CI.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

import { logger } from '../logger.js';

// Model identifiers — kept as constants so they're easy to override in tests
// and so `getEmbeddingModelVersion()` stays the single source of truth.
const MODEL_NAME = 'nomic-ai/nomic-embed-text-v1.5';
const MODEL_DIMS = 768;
const MODEL_VERSION_TAG = 'nomic-embed-text-v1.5:768';
const MAX_BATCH_SIZE = 32;

export type EmbedMode = 'document' | 'query';

/** Prefix per Nomic spec. Must be applied to every input. */
function prefixFor(mode: EmbedMode): string {
  return mode === 'document' ? 'search_document: ' : 'search_query: ';
}

// Singleton pipeline — loaded once, shared across all callers.
// `Promise<Pipeline>` rather than `Pipeline` so concurrent first-callers
// don't each trigger their own load.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Load (or return cached) the feature-extraction pipeline.
 * Exported for tests so they can reset between cases.
 */
export async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    logger.info({ model: MODEL_NAME }, 'Loading embedding model (first call)');
    const { pipeline } = await import('@huggingface/transformers');
    const pipe = (await pipeline(
      'feature-extraction',
      MODEL_NAME,
    )) as FeatureExtractionPipeline;
    logger.info({ model: MODEL_NAME }, 'Embedding model loaded');
    return pipe;
  })();
  return pipelinePromise;
}

/** @internal — tests only. Reset the cached pipeline. */
export function _resetEmbeddingPipeline(): void {
  pipelinePromise = null;
}

/**
 * Embed a single text. Mean-pools across tokens and L2-normalizes (Nomic's
 * recommended recipe for retrieval).
 */
export async function embedText(
  text: string,
  mode: EmbedMode,
): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const input = prefixFor(mode) + text;
  const output = await pipe(input, { pooling: 'mean', normalize: true });
  // `output` is a Tensor-like with `.data` as Float32Array of length 768.
  // tolist() returns nested arrays; .data is faster and already flat for
  // single inputs.
  const vec = Array.from(output.data as Float32Array) as number[];
  if (vec.length !== MODEL_DIMS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${MODEL_DIMS}, got ${vec.length}`,
    );
  }
  return vec;
}

/**
 * Embed a batch of texts. Splits into sub-batches of MAX_BATCH_SIZE. Preserves
 * input order in the returned array.
 */
export async function embedBatch(
  texts: string[],
  mode: EmbedMode,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getEmbeddingPipeline();
  const prefix = prefixFor(mode);
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const slice = texts.slice(i, i + MAX_BATCH_SIZE).map((t) => prefix + t);
    const output = await pipe(slice, { pooling: 'mean', normalize: true });
    // Batched output is a 2-D tensor. Its `.data` is a single Float32Array
    // of length batch*dims; we slice it into dims-sized chunks.
    const flat = output.data as Float32Array;
    const dims = MODEL_DIMS;
    for (let b = 0; b < slice.length; b++) {
      const vec = Array.from(flat.slice(b * dims, (b + 1) * dims)) as number[];
      if (vec.length !== dims) {
        throw new Error(
          `Embedding dimension mismatch in batch: expected ${dims}, got ${vec.length}`,
        );
      }
      results.push(vec);
    }
  }
  return results;
}

/**
 * Canonical model-version tag written into Qdrant payload and used to gate
 * retrieval filters. Changing this string requires a collection migration.
 */
export function getEmbeddingModelVersion(): string {
  return MODEL_VERSION_TAG;
}

/** Exported dims constant — used by `qdrant.ts` to create collections. */
export const EMBEDDING_DIMS = MODEL_DIMS;
