/**
 * Brain-specific Qdrant client (v2 §3, §11).
 *
 * Separate from `src/memory/knowledge-store.ts` — that module owns the
 * legacy `nanoclaw_knowledge` collection (1536d / OpenAI). This module
 * owns the new brain collection `ku_nomic-embed-text-v1.5_768`. The two
 * exist in parallel during the P0→P2 migration window.
 *
 * Every upsert/search MUST include the `model_version` filter (design
 * §3.3) so we never mix embeddings from different models.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';

import { QDRANT_URL } from '../config.js';
import { logger } from '../logger.js';

import { EMBEDDING_DIMS, getEmbeddingModelVersion } from './embed.js';

// Collection name: `ku_<model>_<dim>`. Underscores separate parts; hyphens
// inside the model tag are allowed by Qdrant (verified in docs) but we
// keep the form close to the design. Example:
//   ku_nomic-embed-text-v1.5_768
export const BRAIN_COLLECTION = `ku_nomic-embed-text-v1.5_${EMBEDDING_DIMS}`;

// Qdrant REST API only accepts point IDs as uint64 or UUID — ULIDs are
// rejected as 4xx. We derive a deterministic UUIDv5 from the ULID (kuId)
// for the Qdrant point ID and keep the original ULID in the payload under
// `ku_id` so callers can still query back by the logical KU id.
// Namespace is the RFC 4122 DNS namespace — any fixed UUID works; the
// standard DNS one is chosen so the derivation is reproducible across
// processes and versions.
const KU_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function kuPointId(kuId: string): string {
  return uuidv5(kuId, KU_NAMESPACE);
}

export interface KuPayload {
  account: 'personal' | 'work';
  scope?: string[] | null;
  model_version: string;
  valid_from: string;
  recorded_at: string;
  source_type: string;
  // Free-form additions: topic_key, tags, etc. are fine — Qdrant stores the
  // whole object.
  [extra: string]: unknown;
}

export interface UpsertKuInput {
  kuId: string;
  vector: number[];
  payload: KuPayload;
}

export interface SearchFilter {
  account?: 'personal' | 'work';
  scope?: string; // single tag — an OR across the JSON array. Simple case for P1.
  modelVersion: string; // REQUIRED — non-negotiable per design §3.3
}

export interface BrainSearchHit {
  id: string;
  score: number;
  payload: KuPayload;
}

let client: QdrantClient | null = null;

/** @internal — swap the cached client for tests. */
export function _setQdrantClientForTest(c: QdrantClient | null): void {
  client = c;
}

function getClient(): QdrantClient | null {
  if (client) return client;
  if (!QDRANT_URL) return null;
  client = new QdrantClient({ url: QDRANT_URL });
  return client;
}

/**
 * Ensure the brain collection exists with 768d cosine vectors and default
 * HNSW settings. No-op if QDRANT_URL is not set. Safe to call repeatedly.
 */
export async function ensureBrainCollection(): Promise<void> {
  const c = getClient();
  if (!c) {
    logger.info('QDRANT_URL not set — skipping ensureBrainCollection');
    return;
  }
  try {
    const exists = await c.collectionExists(BRAIN_COLLECTION);
    if (exists.exists) return;
    await c.createCollection(BRAIN_COLLECTION, {
      vectors: { size: EMBEDDING_DIMS, distance: 'Cosine' },
    });
    logger.info(
      { collection: BRAIN_COLLECTION },
      'Brain Qdrant collection created',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'ensureBrainCollection failed (non-fatal)',
    );
  }
}

/**
 * Upsert a single KU vector to Qdrant. The payload MUST carry model_version
 * so retrieval can filter by it. We default it from `getEmbeddingModelVersion()`
 * if the caller forgets — cheaper than silently writing an unfilterable point.
 *
 * The Qdrant point ID is a UUIDv5 derived deterministically from the ULID
 * (see `kuPointId`); the original ULID is preserved in `payload.ku_id` so
 * searches can map results back to the logical KU id.
 */
export async function upsertKu(input: UpsertKuInput): Promise<void> {
  const c = getClient();
  if (!c) return;
  const payload: KuPayload = {
    ...input.payload,
    ku_id: input.kuId,
    model_version: input.payload.model_version ?? getEmbeddingModelVersion(),
  };
  await c.upsert(BRAIN_COLLECTION, {
    wait: true,
    points: [
      {
        id: kuPointId(input.kuId),
        vector: input.vector,
        payload: payload as Record<string, unknown>,
      },
    ],
  });
}

/**
 * Merge extra fields into an existing Qdrant point's payload. Used by the
 * brain miniapp's "mark important" feedback — we flip a single boolean on
 * the point without re-embedding. No-op if QDRANT_URL is not set.
 *
 * Qdrant's `setPayload` preserves other payload fields; callers only need
 * to pass the keys they want to add/overwrite.
 */
export async function setPayload(
  kuId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.setPayload(BRAIN_COLLECTION, {
    wait: true,
    payload,
    points: [kuPointId(kuId)],
  });
}

/**
 * Semantic search against the brain collection. `filter.modelVersion` is
 * required — callers should pass `getEmbeddingModelVersion()`. Returns
 * a flat list of hits, each with a string id matching the KU row.
 */
export async function searchSemantic(
  queryVector: number[],
  filter: SearchFilter,
  topK: number,
): Promise<BrainSearchHit[]> {
  const c = getClient();
  if (!c) return [];
  // TODO(P2): v2 §6 requires filtering out superseded KUs on the Qdrant side
  // to preserve top-K budget after RRF. P1 has no supersession logic yet
  // (consolidation lands in P2), so all live KUs are returned. SQLite-side
  // filter in retrieve.ts:loadKuRows ensures correct results; Qdrant filter
  // will be added alongside the P2 consolidation worker that sets
  // superseded_at. Track: design-doc §6.
  const must: Array<Record<string, unknown>> = [
    { key: 'model_version', match: { value: filter.modelVersion } },
  ];
  if (filter.account) {
    must.push({ key: 'account', match: { value: filter.account } });
  }
  if (filter.scope) {
    must.push({ key: 'scope', match: { value: filter.scope } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = (await c.search(BRAIN_COLLECTION, {
    vector: queryVector,
    limit: topK,
    filter: { must },
    with_payload: true,
  })) as Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown> | null;
  }>;

  return results.map((r) => {
    const payload = (r.payload ?? {}) as KuPayload;
    // The Qdrant point id is a UUIDv5 — map back to the logical ULID
    // carried in payload.ku_id. If ku_id is missing (legacy/bad point),
    // fall back to the UUID so the caller at least gets a stable string.
    const logicalId =
      typeof payload.ku_id === 'string' && payload.ku_id.length > 0
        ? payload.ku_id
        : String(r.id);
    return {
      id: logicalId,
      score: r.score,
      payload,
    };
  });
}
