/**
 * Golden-set evaluation harness (v2 §10).
 *
 * 25 query templates in `golden-set.json` covering recency / historical /
 * entity_lookup / multi_hop / bitemporal / cross_source / precision /
 * fuzzy / negation. Instantiation against real user data is done with
 * the user at P1 closeout — this module just owns:
 *
 *   - `seedTemplates()` → loaded template list
 *   - `runEval(queries, expected)` → precision@10 / recall@10 / MRR
 *
 * All math is standard IR; the job of this file is *correctness* so that
 * measured scores are trustworthy, not to pass any particular threshold.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface GoldenTemplate {
  id: number;
  category: string;
  template: string;
  expected_capabilities: string[];
}

export interface EvalQuery {
  queryId: string;
  /** Ordered list of KU ids returned by the system. */
  retrievedKuIds: string[];
}

export interface EvalPerQueryMetrics {
  queryId: string;
  precisionAt10: number;
  recallAt10: number;
  reciprocalRank: number;
  relevantCount: number;
  retrievedCount: number;
}

export interface EvalReport {
  precisionAt10: number;
  recallAt10: number;
  mrr: number;
  perQuery: EvalPerQueryMetrics[];
}

// -------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedTemplates: GoldenTemplate[] | null = null;

/**
 * Load and return the 25 golden templates. Cached after first read.
 */
export function seedTemplates(): GoldenTemplate[] {
  if (cachedTemplates) return cachedTemplates;
  // Look adjacent to this module (works in dev via tsx, and in build because
  // we copy src/brain/*.json via tsc's resolveJsonModule — but at runtime
  // non-imported JSON isn't copied, so fall back to the src tree).
  const adjacent = path.join(__dirname, 'golden-set.json');
  const srcPath = path.resolve(process.cwd(), 'src', 'brain', 'golden-set.json');
  const target = fs.existsSync(adjacent) ? adjacent : srcPath;
  const raw = fs.readFileSync(target, 'utf8');
  cachedTemplates = JSON.parse(raw) as GoldenTemplate[];
  if (cachedTemplates.length !== 25) {
    throw new Error(
      `golden-set.json expected 25 templates, got ${cachedTemplates.length}`,
    );
  }
  return cachedTemplates;
}

/** @internal — tests only. */
export function _resetSeedCache(): void {
  cachedTemplates = null;
}

/**
 * Compute precision@10, recall@10, MRR for one query.
 *   precision@10 = |relevant ∩ top10| / 10
 *   recall@10    = |relevant ∩ top10| / |relevant|  (0 if no relevant docs)
 *   reciprocal   = 1 / rank of first relevant doc (1-indexed); 0 if none
 */
export function scoreOneQuery(
  retrieved: string[],
  expected: Set<string>,
): EvalPerQueryMetrics {
  const top = retrieved.slice(0, 10);
  const hits = top.filter((id) => expected.has(id));
  const precisionAt10 = hits.length / 10;
  const recallAt10 = expected.size > 0 ? hits.length / expected.size : 0;

  let reciprocalRank = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.has(retrieved[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }
  return {
    queryId: '',
    precisionAt10,
    recallAt10,
    reciprocalRank,
    relevantCount: expected.size,
    retrievedCount: retrieved.length,
  };
}

/**
 * Run eval over a batch of queries. `expected` maps queryId → Set of KU ids
 * that are relevant. Returns macro-averages and per-query detail.
 */
export async function runEval(
  queries: EvalQuery[],
  expected: Map<string, Set<string>>,
): Promise<EvalReport> {
  const perQuery: EvalPerQueryMetrics[] = queries.map((q) => {
    const exp = expected.get(q.queryId) ?? new Set<string>();
    const m = scoreOneQuery(q.retrievedKuIds, exp);
    return { ...m, queryId: q.queryId };
  });

  const n = perQuery.length || 1;
  const precisionAt10 =
    perQuery.reduce((s, m) => s + m.precisionAt10, 0) / n;
  const recallAt10 = perQuery.reduce((s, m) => s + m.recallAt10, 0) / n;
  const mrr = perQuery.reduce((s, m) => s + m.reciprocalRank, 0) / n;

  return { precisionAt10, recallAt10, mrr, perQuery };
}
