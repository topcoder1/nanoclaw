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

import { escapeHtml } from './templates/escape.js';
import { brainShell, formatAge } from './templates/brain-layout.js';

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
interface HomeStats {
  kuLive: number;
  kuSuperseded: number;
  entityTotal: number;
  rawLast24h: number;
  costMtdUsd: number;
}

/**
 * Aggregate the small set of numbers shown on `/brain`. Each query is
 * indexed and cheap; no caching needed — the home page itself polls
 * every 15s via /api/brain/status which is even cheaper.
 */
function getHomeStats(db: Database.Database, nowMs: number): HomeStats {
  const ku = db
    .prepare(
      `SELECT
         SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN superseded_at IS NOT NULL THEN 1 ELSE 0 END) AS sup
       FROM knowledge_units`,
    )
    .get() as { live: number | null; sup: number | null };
  const ent = db
    .prepare(`SELECT COUNT(*) AS n FROM entities`)
    .get() as { n: number };
  const sinceIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const raw = db
    .prepare(
      `SELECT COUNT(*) AS n FROM raw_events WHERE received_at >= ?`,
    )
    .get(sinceIso) as { n: number };
  const ym = new Date(nowMs).toISOString().slice(0, 7); // YYYY-MM
  const cost = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM cost_log WHERE substr(day, 1, 7) = ?`,
    )
    .get(ym) as { total: number };
  return {
    kuLive: ku.live ?? 0,
    kuSuperseded: ku.sup ?? 0,
    entityTotal: ent.n,
    rawLast24h: raw.n,
    costMtdUsd: cost.total,
  };
}

interface RecentRawRow {
  id: string;
  source_type: string;
  source_ref: string;
  received_at: string;
}

function getRecentRaw(db: Database.Database, limit: number): RecentRawRow[] {
  return db
    .prepare(
      `SELECT id, source_type, source_ref, received_at
         FROM raw_events
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(limit) as RecentRawRow[];
}

/**
 * Fingerprint the brain state — used by the home page's polling script
 * to detect when the page should reload. Counts + most recent ids capture
 * every meaningful change at minimal cost.
 */
function getStatusFingerprint(db: Database.Database): {
  ku: number;
  entities: number;
  review: number;
  recent: string[];
} {
  const ku = db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_units WHERE superseded_at IS NULL`,
    )
    .get() as { n: number };
  const ent = db
    .prepare(`SELECT COUNT(*) AS n FROM entities`)
    .get() as { n: number };
  const review = db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_units
        WHERE needs_review = 1 AND superseded_at IS NULL`,
    )
    .get() as { n: number };
  const recent = db
    .prepare(
      `SELECT id FROM raw_events ORDER BY received_at DESC LIMIT 10`,
    )
    .all() as Array<{ id: string }>;
  return {
    ku: ku.n,
    entities: ent.n,
    review: review.n,
    recent: recent.map((r) => r.id),
  };
}

export function createBrainRoutes(
  opts: BrainRoutesOptions = {},
): express.Router {
  const router = express.Router();
  const getDb = (): Database.Database => opts.brainDb ?? getBrainDb();

  // --- GET /brain — home dashboard --------------------------------------
  router.get('/', (_req, res) => {
    const db = getDb();
    const now = Date.now();
    const reviewCount = getReviewCount(db);
    const stats = getHomeStats(db, now);
    const recent = getRecentRaw(db, 5);
    const initial = getStatusFingerprint(db);

    const costStr = stats.costMtdUsd.toFixed(2);
    const recentRows = recent.length
      ? `<ul>${recent
          .map(
            (r) =>
              `<li>
                <span class="pill source">${escapeHtml(r.source_type)}</span>
                <span class="meta">${escapeHtml(r.source_ref)}</span>
                <span class="age">· ${formatAge(r.received_at, now)}</span>
              </li>`,
          )
          .join('')}</ul>`
      : '<p class="empty">No ingestion activity yet.</p>';

    const reviewBanner =
      reviewCount > 0
        ? `<div class="card"><a href="/brain/review">${reviewCount} KU${
            reviewCount === 1 ? '' : 's'
          } awaiting review →</a></div>`
        : '';

    const body = `
<h1>🧠 Brain</h1>
<form class="searchbox" action="/brain/search" method="get">
  <input type="text" name="q" placeholder="Search the brain…" autofocus>
  <button type="submit">Search</button>
</form>
${reviewBanner}
<div class="card">
  <strong>Stats</strong>
  <p class="meta">
    ${stats.kuLive} KU${stats.kuLive === 1 ? '' : 's'} live ·
    ${stats.kuSuperseded} superseded ·
    ${stats.entityTotal} entit${stats.entityTotal === 1 ? 'y' : 'ies'} ·
    ${stats.rawLast24h} raw event${stats.rawLast24h === 1 ? '' : 's'} in last 24h ·
    $${escapeHtml(costStr)} MTD
  </p>
</div>
<h2>Recent activity</h2>
<div class="card">
  ${recentRows}
  <p class="meta" style="margin-top:8px">
    <a href="/brain/timeline">Full timeline →</a>
  </p>
</div>
<script>
// Live refresh — poll fingerprint every 15s, reload if brain state changed.
// Same pattern as the existing /api/queue/status on the home page.
(function(){
  const initial=${JSON.stringify(initial)};
  let inFlight=false;
  async function check(){
    if(inFlight||document.hidden)return;
    inFlight=true;
    try{
      const r=await fetch('/api/brain/status',{cache:'no-store'});
      if(!r.ok)return;
      const j=await r.json();
      const changed=j.ku!==initial.ku||j.entities!==initial.entities||j.review!==initial.review||JSON.stringify(j.recent)!==JSON.stringify(initial.recent);
      if(changed)location.reload();
    }catch(_){}finally{inFlight=false;}
  }
  setInterval(check,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
  window.addEventListener('pageshow',check);
})();
</script>`;
    res.type('html').send(
      brainShell('Brain', body, {
        activeNav: 'home',
        reviewCount,
      }),
    );
  });

  return router;
}

/**
 * Separate helper so `server.ts` can mount `/api/brain/status` on the main
 * app (Express routers are path-scoped; a router mounted at `/brain` cannot
 * expose `/api/brain/...`). Keeps the single source of truth for the
 * fingerprint query in this module.
 */
export function createBrainApiRoutes(
  opts: BrainRoutesOptions = {},
): express.Router {
  const router = express.Router();
  const getDb = (): Database.Database => opts.brainDb ?? getBrainDb();
  router.get('/status', (_req, res) => {
    const db = getDb();
    res.json(getStatusFingerprint(db));
  });
  return router;
}
