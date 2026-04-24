/**
 * Hybrid retrieval over the brain (v2 §6).
 *
 *   query → embed(query,'query') → queryVector
 *   FTS5 BM25 top 100  ──┐
 *   Qdrant top 100 (model_version filtered) ──┤
 *                                             │→ RRF(k=60) top 50
 *                                             │→ cross-encoder rerank
 *                                             │→ final = 0.7·rank + 0.15·recency
 *                                                      + 0.1·access + 0.05·important
 *                                                recency   = exp(-ln2 · (now-recorded_at)/halfLife)
 *                                                access    = min(log2(1+access_count)/5, 1)
 *                                                important = ku.important ? 1 : 0
 *   → top N
 *
 * Always filters superseded_at IS NULL and model_version = active.
 * After returning, bumps access_count / last_accessed_at on every hit
 * via the shared write queue.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import {
  embedText as embedTextForRetrieval,
  getEmbeddingModelVersion,
} from './embed.js';
import { AsyncWriteQueue } from './queue.js';
import { searchSemantic, type BrainSearchHit } from './qdrant.js';
import { rerank, type RerankResult } from './rerank.js';

// --- Types -----------------------------------------------------------------

export interface RecallOptions {
  account?: 'personal' | 'work';
  scope?: string;
  limit?: number;
  halfLifeDays?: number;
  /** Override "now" for determinism in tests. Epoch ms. */
  nowMs?: number;
}

export interface RecallResult {
  ku_id: string;
  text: string;
  source_type: string;
  source_ref: string | null;
  account: 'personal' | 'work';
  valid_from: string;
  recorded_at: string;
  topic_key: string | null;
  important: boolean;
  finalScore: number;
  rankScore: number;
  recencyScore: number;
  accessScore: number;
  importantScore: number;
}

// --- RRF + scoring helpers --------------------------------------------------

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank_i(d)) across sources.
 * Ranks are 0-indexed inside each list (top doc = rank 0).
 */
export function rrf(
  lists: string[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const inc = 1 / (k + i);
      scores.set(id, (scores.get(id) ?? 0) + inc);
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** recency = exp(-ln(2) · age / halfLife). Both in ms. */
export function recencyScore(
  recordedAtMs: number,
  nowMs: number,
  halfLifeMs: number,
): number {
  const age = Math.max(0, nowMs - recordedAtMs);
  return Math.exp((-Math.LN2 * age) / halfLifeMs);
}

/** access = min(log2(1 + access_count) / 5, 1). */
export function accessScore(count: number): number {
  return Math.min(Math.log2(1 + Math.max(0, count)) / 5, 1);
}

/**
 * Blend ranker + recency + access-count + user-marked-important into a
 * single score in roughly [0, 1]. Weights sum to 1 so no axis dominates;
 * 5% for `important` is a deliberately small nudge — enough to break ties
 * and surface curated KUs, not enough to override a genuinely better hit.
 */
export function finalScore(
  rank: number,
  recency: number,
  access: number,
  important = 0,
): number {
  return 0.7 * rank + 0.15 * recency + 0.1 * access + 0.05 * important;
}

// --- FTS5 helper -----------------------------------------------------------

interface KuRow {
  id: string;
  text: string;
  source_type: string;
  source_ref: string | null;
  account: 'personal' | 'work';
  valid_from: string;
  recorded_at: string;
  topic_key: string | null;
  access_count: number;
  important: number;
  bm25: number | null;
}

function ftsSearchTopN(
  db: Database.Database,
  query: string,
  n: number,
  opts: { account?: string; scope?: string },
): KuRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Tokenize: OR-of-quoted tokens (same strategy as knowledge-store.ts).
  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');

  const filters: string[] = [];
  const params: unknown[] = [tokens];
  if (opts.account) {
    filters.push('ku.account = ?');
    params.push(opts.account);
  }
  if (opts.scope) {
    // Simple P1: scope is JSON array — check substring match. For strict
    // containment, P2 can parse JSON. Good enough for single-tag queries.
    filters.push(`(ku.scope IS NOT NULL AND ku.scope LIKE '%"' || ? || '"%')`);
    params.push(opts.scope);
  }
  filters.push('ku.superseded_at IS NULL');

  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const sql = `
    SELECT ku.id, ku.text, ku.source_type, ku.source_ref, ku.account,
           ku.valid_from, ku.recorded_at, ku.topic_key, ku.access_count,
           ku.important, bm25(ku_fts) AS bm25
    FROM ku_fts
    JOIN knowledge_units ku ON ku.rowid = ku_fts.rowid
    WHERE ku_fts MATCH ? ${where}
    ORDER BY bm25
    LIMIT ?`;
  params.push(n);
  return db.prepare(sql).all(...params) as KuRow[];
}

function loadKuRows(db: Database.Database, ids: string[]): Map<string, KuRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  // TODO(P2): v2 §6 requires Qdrant-side filtering of superseded KUs to
  // preserve the top-K budget after RRF. P1 has no supersession yet
  // (consolidation lands in P2), so this SQLite-side filter is sufficient
  // for correctness — Qdrant hits that point at superseded rows are
  // dropped here before rerank. Will move to Qdrant payload filter
  // alongside the P2 consolidation worker. See qdrant.ts:searchSemantic.
  const rows = db
    .prepare(
      `SELECT id, text, source_type, source_ref, account, valid_from,
              recorded_at, topic_key, access_count, important,
              NULL as bm25
       FROM knowledge_units
       WHERE id IN (${placeholders}) AND superseded_at IS NULL`,
    )
    .all(...ids) as KuRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

// --- Access-count write queue ---------------------------------------------

interface AccessBump {
  id: string;
  ts: string;
}
let accessQueue: AsyncWriteQueue<AccessBump> | null = null;

function getAccessQueue(): AsyncWriteQueue<AccessBump> {
  if (accessQueue) return accessQueue;
  const db = getBrainDb();
  accessQueue = new AsyncWriteQueue<AccessBump>(
    async (batch) => {
      const stmt = db.prepare(
        `UPDATE knowledge_units
           SET access_count = access_count + 1,
               last_accessed_at = ?
         WHERE id = ?`,
      );
      const txn = db.transaction((bumps: AccessBump[]) => {
        for (const b of bumps) stmt.run(b.ts, b.id);
      });
      txn(batch);
    },
    { maxBatchSize: 50, maxLatencyMs: 50 },
  );
  return accessQueue;
}

/** @internal — tests only. */
export async function _shutdownAccessQueue(): Promise<void> {
  if (accessQueue) {
    await accessQueue.shutdown();
    accessQueue = null;
  }
}

// --- Main entry point ------------------------------------------------------

export async function recall(
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult[]> {
  const db = getBrainDb();
  const limit = opts.limit ?? 10;
  const halfLifeMs = (opts.halfLifeDays ?? 180) * 24 * 60 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();
  const modelVersion = getEmbeddingModelVersion();

  // Stage 1: parallel FTS + Qdrant.
  const ftsRows = ftsSearchTopN(db, query, 100, {
    account: opts.account,
    scope: opts.scope,
  });
  const ftsIds = ftsRows.map((r) => r.id);

  let qdrantHits: BrainSearchHit[] = [];
  try {
    const queryVector = await embedTextForRetrieval(query, 'query');
    qdrantHits = await searchSemantic(
      queryVector,
      {
        account: opts.account,
        scope: opts.scope,
        modelVersion,
      },
      100,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'recall: semantic search failed — falling back to FTS-only',
    );
  }
  const qdrantIds = qdrantHits.map((h) => h.id);

  // Stage 2: RRF merge top 50.
  const fused = rrf([ftsIds, qdrantIds]).slice(0, 50);
  if (fused.length === 0) return [];

  // Load KU rows for everyone we're considering.
  const rowMap = loadKuRows(
    db,
    fused.map((f) => f.id),
  );

  // Stage 3: rerank. Drop anything we couldn't load (superseded after FTS).
  const candidates = fused
    .filter((f) => rowMap.has(f.id))
    .map((f) => ({ id: f.id, text: rowMap.get(f.id)!.text }));
  let reranked: RerankResult[] = [];
  try {
    reranked = await rerank(query, candidates, candidates.length);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'recall: rerank failed — using RRF score as rankScore',
    );
    // Build a degraded reranked list using the RRF score.
    const rrfScores = new Map(fused.map((f) => [f.id, f.score]));
    reranked = candidates.map((c) => ({
      id: c.id,
      text: c.text,
      score: rrfScores.get(c.id) ?? 0,
    }));
    reranked.sort((a, b) => b.score - a.score);
  }

  // Stage 4: blend with recency + access into final score.
  const results: RecallResult[] = reranked.map((r) => {
    const row = rowMap.get(r.id)!;
    const recordedAtMs = Date.parse(row.recorded_at);
    const recency = Number.isFinite(recordedAtMs)
      ? recencyScore(recordedAtMs, nowMs, halfLifeMs)
      : 0;
    const access = accessScore(row.access_count ?? 0);
    const important = row.important === 1;
    const importantBoost = important ? 1 : 0;
    return {
      ku_id: row.id,
      text: row.text,
      source_type: row.source_type,
      source_ref: row.source_ref,
      account: row.account,
      valid_from: row.valid_from,
      recorded_at: row.recorded_at,
      topic_key: row.topic_key,
      important,
      rankScore: r.score,
      recencyScore: recency,
      accessScore: access,
      importantScore: importantBoost,
      finalScore: finalScore(r.score, recency, access, importantBoost),
    };
  });

  results.sort((a, b) => b.finalScore - a.finalScore);
  const top = results.slice(0, limit);

  // Stage 5: bump access_count on the returned hits (async, best-effort).
  const nowIso = new Date(nowMs).toISOString();
  for (const hit of top) {
    getAccessQueue()
      .enqueue({ id: hit.ku_id, ts: nowIso })
      .catch((err) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            id: hit.ku_id,
          },
          'recall: access bump failed',
        );
      });
  }

  return top;
}
