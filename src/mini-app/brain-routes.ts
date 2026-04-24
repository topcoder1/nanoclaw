/**
 * Brain miniapp sub-router. Mounted at `/brain` by `createMiniAppServer`.
 *
 * Routes (filled in across commits 4-8):
 *   GET  /brain                    → home (stats + search + recent activity)
 *   GET  /brain/search?q=…         → relevance-ranked search via recall()
 *   GET  /brain/entities[?type=…]  → entity directory
 *   GET  /brain/entities/:id       → entity detail (aliases + timeline)
 *   GET  /brain/ku/:id             → KU detail + feedback buttons
 *   GET  /brain/review             → needs_review queue
 *   GET  /brain/timeline           → expanded /brainstream w/ pagination
 *
 *   POST /api/brain/ku/:id/important → toggle the important flag
 *   POST /api/brain/ku/:id/approve   → clear needs_review, raise confidence
 *   POST /api/brain/ku/:id/reject    → set superseded_at (soft delete)
 *   GET  /api/brain/status           → fingerprint for polling refresh
 *
 * Data source: `brain.db` via `getBrainDb()`. Dependency is injected so
 * tests can seed a fresh database without touching the singleton.
 */

import express from 'express';
import type Database from 'better-sqlite3';

import { getBrainDb } from '../brain/db.js';

import { brainShell } from './templates/brain-layout.js';

export interface BrainRoutesOptions {
  /**
   * Brain DB handle. Defaults to the singleton from `getBrainDb()` so
   * production code doesn't need to wire it. Tests pass a fresh in-memory
   * or tmp-file DB.
   */
  brainDb?: Database.Database;
}

/**
 * Return the count of KUs currently in the review queue. Used by the
 * shared nav to show a badge on the "Review" tab.
 */
function getReviewCount(db: Database.Database): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_units
         WHERE needs_review = 1 AND superseded_at IS NULL`,
      )
      .get() as { n: number };
    return row.n;
  } catch {
    // Missing table / fresh install — no review queue yet.
    return 0;
  }
}

/**
 * Build the `/brain` express.Router. Mounted at `/brain` in server.ts.
 */
export function createBrainRoutes(
  opts: BrainRoutesOptions = {},
): express.Router {
  const router = express.Router();
  const getDb = (): Database.Database => opts.brainDb ?? getBrainDb();

  // --- Home placeholder — the real implementation lands in commit 4. ----
  router.get('/', (_req, res) => {
    const db = getDb();
    const reviewCount = getReviewCount(db);
    const body = `
<h1>🧠 Brain</h1>
<div class="card">
  <p class="meta">Coming next — brain dashboard, search, and feedback controls.</p>
</div>`;
    res.type('html').send(
      brainShell('Brain', body, {
        activeNav: 'home',
        reviewCount,
      }),
    );
  });

  return router;
}
