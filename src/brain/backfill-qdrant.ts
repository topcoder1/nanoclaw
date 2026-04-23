/**
 * One-shot: add `model_version: 'openai:text-embedding-3-small:1536'` to any
 * point in the `nanoclaw_knowledge` Qdrant collection that lacks it.
 *
 * Idempotent — points that already have the field are skipped.
 *
 * Usage:
 *   npm exec tsx src/brain/backfill-qdrant.ts
 *   (or `node --loader tsx src/brain/backfill-qdrant.ts`)
 *
 * Env:
 *   QDRANT_URL   (from config.ts / .env)
 *
 * Design reference: .omc/design/brain-architecture-v2.md §4 Phase A.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

import { QDRANT_URL } from '../config.js';
import { logger } from '../logger.js';

const COLLECTION_NAME = 'nanoclaw_knowledge';
const MODEL_VERSION = 'openai:text-embedding-3-small:1536';
const SCROLL_PAGE_SIZE = 256;

export interface BackfillResult {
  updated: number;
  skipped: number;
  total: number;
}

/**
 * Run the backfill. Returns counts so callers (and tests) can assert.
 */
export async function backfillModelVersion(
  client: QdrantClient,
  collection: string = COLLECTION_NAME,
): Promise<BackfillResult> {
  let updated = 0;
  let skipped = 0;
  let total = 0;

  let offset: string | number | undefined = undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // @qdrant/js-client-rest scroll: page through all points with payload.
    // We don't need vectors for the backfill — only the payload.
    const page = await client.scroll(collection, {
      limit: SCROLL_PAGE_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    const points = page.points ?? [];
    total += points.length;

    const toUpdate: Array<string | number> = [];
    for (const p of points) {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      if (payload['model_version'] === MODEL_VERSION) {
        skipped++;
        continue;
      }
      toUpdate.push(p.id);
    }

    if (toUpdate.length > 0) {
      await client.setPayload(collection, {
        payload: { model_version: MODEL_VERSION },
        points: toUpdate,
        wait: true,
      });
      updated += toUpdate.length;
    }

    const next = page.next_page_offset as string | number | null | undefined;
    if (next === null || next === undefined) break;
    offset = next;
  }

  return { updated, skipped, total };
}

async function main(): Promise<void> {
  if (!QDRANT_URL) {
    logger.error('QDRANT_URL not set — cannot backfill');
    process.exit(1);
  }
  const client = new QdrantClient({ url: QDRANT_URL });

  const exists = await client.collectionExists(COLLECTION_NAME);
  if (!exists.exists) {
    logger.warn(
      { collection: COLLECTION_NAME },
      'Collection does not exist — nothing to backfill',
    );
    return;
  }

  logger.info({ collection: COLLECTION_NAME }, 'Backfill started');
  const result = await backfillModelVersion(client, COLLECTION_NAME);
  logger.info(
    { updated: result.updated, skipped: result.skipped, total: result.total },
    'Backfill complete',
  );
}

// Entry point when run directly (tsx / node). Import-only usage (tests)
// skips this.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-qdrant.ts') ||
  process.argv[1]?.endsWith('backfill-qdrant.js');

if (isMain) {
  main().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Backfill failed');
    process.exit(1);
  });
}
