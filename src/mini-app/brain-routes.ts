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
import { markImportant } from '../brain/important.js';
import { AsyncWriteQueue } from '../brain/queue.js';
import { recall, type RecallResult } from '../brain/retrieve.js';
import { logger } from '../logger.js';

import { escapeHtml } from './templates/escape.js';
import { brainShell, confidenceBar, formatAge } from './templates/brain-layout.js';

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

  // --- GET /brain/entities — directory ---------------------------------
  router.get('/entities', (req, res) => {
    const db = getDb();
    const reviewCount = getReviewCount(db);

    const type =
      typeof req.query.type === 'string' &&
      ['person', 'company', 'project', 'product', 'topic'].includes(
        req.query.type,
      )
        ? req.query.type
        : '';
    const rawPage =
      typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : 1;
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const PAGE_SIZE = 50;
    const offset = (page - 1) * PAGE_SIZE;

    const whereType = type ? 'WHERE e.entity_type = ?' : '';
    const countParams: unknown[] = type ? [type] : [];
    const listParams: unknown[] = type
      ? [type, PAGE_SIZE, offset]
      : [PAGE_SIZE, offset];

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM entities e ${whereType}`)
        .get(...countParams) as { n: number }
    ).n;

    const rows = db
      .prepare(
        `SELECT e.entity_id, e.entity_type, e.canonical,
                COALESCE(cnt.n, 0) AS ku_count
           FROM entities e
           LEFT JOIN (
             SELECT entity_id, COUNT(*) AS n FROM ku_entities GROUP BY entity_id
           ) cnt ON cnt.entity_id = e.entity_id
           ${whereType}
           ORDER BY ku_count DESC, e.entity_id
           LIMIT ? OFFSET ?`,
      )
      .all(...listParams) as Array<{
      entity_id: string;
      entity_type: string;
      canonical: string | null;
      ku_count: number;
    }>;

    const tabs = ['', 'person', 'company', 'project', 'product', 'topic']
      .map((t) => {
        const label =
          t === ''
            ? 'All'
            : t.charAt(0).toUpperCase() + t.slice(1) + 's';
        const href = t ? `/brain/entities?type=${t}` : '/brain/entities';
        const active = t === type ? ' class="active"' : '';
        return `<a href="${href}"${active}>${label}</a>`;
      })
      .join(' · ');

    const listHtml = rows.length
      ? `<ul>${rows.map(renderEntityRow).join('')}</ul>`
      : '<p class="empty">No entities match this filter yet.</p>';

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pager =
      totalPages > 1
        ? `<p class="meta">Page ${page} of ${totalPages} · ` +
          (page > 1
            ? `<a href="?${type ? `type=${type}&` : ''}page=${page - 1}">← prev</a>`
            : '') +
          (page > 1 && page < totalPages ? ' · ' : '') +
          (page < totalPages
            ? `<a href="?${type ? `type=${type}&` : ''}page=${page + 1}">next →</a>`
            : '') +
          '</p>'
        : '';

    const body = `
<h1>Entities (${total})</h1>
<div class="card"><p class="meta">${tabs}</p></div>
<div class="card">${listHtml}</div>
${pager}`;
    res.type('html').send(
      brainShell('Entities — Brain', body, {
        activeNav: 'entities',
        reviewCount,
      }),
    );
  });

  // --- GET /brain/entities/:id — detail page ---------------------------
  router.get('/entities/:id', (req, res) => {
    const db = getDb();
    const reviewCount = getReviewCount(db);
    const id = req.params.id;

    const entity = db
      .prepare(
        `SELECT entity_id, entity_type, canonical, created_at, updated_at
           FROM entities WHERE entity_id = ?`,
      )
      .get(id) as
      | {
          entity_id: string;
          entity_type: string;
          canonical: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!entity) {
      res.status(404).type('html').send(
        brainShell('Not found — Brain', `
<h1>Entity not found</h1>
<div class="card"><p class="meta">No entity with id <code>${escapeHtml(id)}</code>.</p></div>`, {
          activeNav: 'entities',
          reviewCount,
        }),
      );
      return;
    }

    const aliases = db
      .prepare(
        `SELECT field_name, field_value, valid_from, valid_until, confidence
           FROM entity_aliases WHERE entity_id = ?
           ORDER BY COALESCE(valid_until, '9999') DESC, valid_from DESC`,
      )
      .all(id) as Array<{
      field_name: string;
      field_value: string;
      valid_from: string;
      valid_until: string | null;
      confidence: number;
    }>;

    const rels = db
      .prepare(
        `SELECT rel_id, from_entity_id, to_entity_id, relationship,
                valid_from, valid_until, confidence,
                CASE WHEN from_entity_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction
           FROM entity_relationships
          WHERE from_entity_id = ? OR to_entity_id = ?
          ORDER BY valid_from DESC`,
      )
      .all(id, id, id) as Array<{
      rel_id: string;
      from_entity_id: string;
      to_entity_id: string;
      relationship: string;
      valid_from: string;
      valid_until: string | null;
      confidence: number;
      direction: 'outgoing' | 'incoming';
    }>;

    const timeline = db
      .prepare(
        `SELECT ku.id, ku.text, ku.source_type, ku.recorded_at,
                ku.confidence, ku.superseded_at
           FROM ku_entities ke
           JOIN knowledge_units ku ON ku.id = ke.ku_id
          WHERE ke.entity_id = ?
          ORDER BY ku.recorded_at DESC
          LIMIT 100`,
      )
      .all(id) as Array<{
      id: string;
      text: string;
      source_type: string;
      recorded_at: string;
      confidence: number;
      superseded_at: string | null;
    }>;

    const displayName = renderEntityDisplayName(entity);

    const aliasesHtml = aliases.length
      ? `<ul>${aliases
          .map(
            (a) =>
              `<li>
                <span class="pill">${escapeHtml(a.field_name)}</span>
                <strong>${escapeHtml(a.field_value)}</strong>
                <span class="meta">· from ${escapeHtml(a.valid_from)}${a.valid_until ? ` until ${escapeHtml(a.valid_until)}` : ''} · confidence ${a.confidence.toFixed(2)}</span>
              </li>`,
          )
          .join('')}</ul>`
      : '<p class="empty">No aliases.</p>';

    const relsHtml = rels.length
      ? `<ul>${rels
          .map((r) => {
            const other = r.direction === 'outgoing' ? r.to_entity_id : r.from_entity_id;
            const arrow = r.direction === 'outgoing' ? '→' : '←';
            return `<li>
              ${arrow} <span class="pill">${escapeHtml(r.relationship)}</span>
              <a href="/brain/entities/${escapeHtml(other)}">${escapeHtml(other)}</a>
              <span class="meta">· from ${escapeHtml(r.valid_from)}${r.valid_until ? ` until ${escapeHtml(r.valid_until)}` : ''}</span>
            </li>`;
          })
          .join('')}</ul>`
      : '<p class="empty">No relationships.</p>';

    const timelineHtml = timeline.length
      ? `<ul>${timeline
          .map((k) => {
            const snippet = k.text.length > 80 ? k.text.slice(0, 80) + '…' : k.text;
            const muted = k.superseded_at ? ' style="opacity:0.55"' : '';
            return `<li${muted}>
              <a class="row-link" href="/brain/ku/${escapeHtml(k.id)}">
                <div class="snippet"><strong>${escapeHtml(snippet)}</strong></div>
                <div class="meta">
                  <span class="pill source">${escapeHtml(k.source_type)}</span>
                  ${confidenceBar(k.confidence)}
                  <span>· ${formatAge(k.recorded_at)}</span>
                  ${k.superseded_at ? '<span class="pill">superseded</span>' : ''}
                </div>
              </a>
            </li>`;
          })
          .join('')}</ul>`
      : '<p class="empty">No KUs mention this entity yet.</p>';

    const body = `
<h1>${escapeHtml(displayName)} <span class="pill ${escapeHtml(entity.entity_type)}">${escapeHtml(entity.entity_type)}</span></h1>
<div class="card"><p class="meta">
  id: <code>${escapeHtml(entity.entity_id)}</code> ·
  created ${escapeHtml(entity.created_at)} ·
  updated ${escapeHtml(entity.updated_at)}
</p></div>
<h2>Aliases</h2>
<div class="card">${aliasesHtml}</div>
<h2>Relationships</h2>
<div class="card">${relsHtml}</div>
<h2>Timeline</h2>
<div class="card">${timelineHtml}</div>`;
    res.type('html').send(
      brainShell(`${displayName} — Brain`, body, {
        activeNav: 'entities',
        reviewCount,
      }),
    );
  });

  // --- KU detail + feedback --------------------------------------------
  // Access-count bumps happen on the page-render router (read side). The
  // feedback POSTs live on the parallel API router at /api/brain — see
  // createBrainApiRoutes below.
  const accessBumpQueue = makeAccessBumpQueue(() => getDb());

  // GET /brain/ku/:id — detail page
  router.get('/ku/:id', (req, res) => {
    const db = getDb();
    const reviewCount = getReviewCount(db);
    const id = req.params.id;

    const row = db
      .prepare(
        `SELECT id, text, source_type, source_ref, account, scope, confidence,
                valid_from, valid_until, recorded_at, superseded_at, topic_key,
                tags, extracted_by, extraction_chain, metadata,
                access_count, last_accessed_at, needs_review, important
           FROM knowledge_units WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          text: string;
          source_type: string;
          source_ref: string | null;
          account: string;
          scope: string | null;
          confidence: number;
          valid_from: string;
          valid_until: string | null;
          recorded_at: string;
          superseded_at: string | null;
          topic_key: string | null;
          tags: string | null;
          extracted_by: string | null;
          extraction_chain: string | null;
          metadata: string | null;
          access_count: number;
          last_accessed_at: string | null;
          needs_review: number;
          important: number;
        }
      | undefined;

    if (!row) {
      res.status(404).type('html').send(
        brainShell('Not found — Brain', `
<h1>KU not found</h1>
<div class="card"><p class="meta">No KU with id <code>${escapeHtml(id)}</code>.</p></div>`, {
          reviewCount,
        }),
      );
      return;
    }

    // Side effect: bump access_count + last_accessed_at. Same behavior as
    // recall() — this is how the brain measures "which KUs get looked at".
    accessBumpQueue
      .enqueue({ id: row.id, ts: new Date().toISOString() })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), id: row.id },
          '/brain/ku: access bump failed',
        ),
      );

    const linkedEntities = db
      .prepare(
        `SELECT e.entity_id, e.entity_type, e.canonical, ke.role
           FROM ku_entities ke
           JOIN entities e ON e.entity_id = ke.entity_id
          WHERE ke.ku_id = ?`,
      )
      .all(row.id) as Array<{
      entity_id: string;
      entity_type: string;
      canonical: string | null;
      role: string;
    }>;

    // extraction_chain is a JSON array of source-KU ids
    let chainIds: string[] = [];
    if (row.extraction_chain) {
      try {
        const parsed = JSON.parse(row.extraction_chain);
        if (Array.isArray(parsed)) {
          chainIds = parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        /* malformed — ignore */
      }
    }

    const needsReview = row.needs_review === 1;
    const isImportant = row.important === 1;
    const isSuperseded = row.superseded_at !== null;
    const deepLink = sourceDeepLink(row.source_type, row.source_ref);

    const entityPills = linkedEntities.length
      ? linkedEntities
          .map((e) => {
            const name = renderEntityDisplayName({
              entity_id: e.entity_id,
              canonical: e.canonical,
            });
            return `<a href="/brain/entities/${escapeHtml(e.entity_id)}" class="pill ${escapeHtml(e.entity_type)}" title="${escapeHtml(e.role)}">${escapeHtml(name)}</a>`;
          })
          .join(' ')
      : '<span class="meta">none</span>';

    const chainHtml = chainIds.length
      ? chainIds
          .map(
            (cid) =>
              `<a href="/brain/ku/${escapeHtml(cid)}"><code>${escapeHtml(cid)}</code></a>`,
          )
          .join(', ')
      : '';

    const feedbackButtons = `
<div id="feedback" style="margin-top:16px">
  <button class="feedback-btn${isImportant ? ' active' : ''}" id="btn-important" data-on="${isImportant ? '1' : '0'}">
    ⭐ ${isImportant ? 'Important' : 'Mark important'}
  </button>
  ${needsReview ? '<button class="feedback-btn approve" id="btn-approve">🟢 Approve</button>' : ''}
  <button class="feedback-btn reject" id="btn-reject"${isSuperseded ? ' disabled' : ''}>${isSuperseded ? '🔴 Rejected' : '🔴 Reject'}</button>
  <span id="feedback-msg" class="meta" style="margin-left:10px"></span>
</div>`;

    const body = `
<h1>${escapeHtml((row.text.split('\n')[0] || row.id).slice(0, 120))}</h1>
<div class="card">
  <p class="meta">
    <span class="pill source">${escapeHtml(row.source_type)}</span>
    <span class="pill">${escapeHtml(row.account)}</span>
    ${isSuperseded ? '<span class="pill">superseded</span>' : ''}
    ${needsReview ? '<span class="pill">needs_review</span>' : ''}
    ${isImportant ? '<span class="pill">⭐ important</span>' : ''}
    ${confidenceBar(row.confidence)}
    <span>confidence ${row.confidence.toFixed(2)}</span>
    · valid_from ${escapeHtml(row.valid_from)}
    · recorded_at ${escapeHtml(row.recorded_at)}
    · accessed ${row.access_count}×
  </p>
  ${row.scope ? `<p class="meta">scope: <code>${escapeHtml(row.scope)}</code></p>` : ''}
  ${row.topic_key ? `<p class="meta">topic: <code>${escapeHtml(row.topic_key)}</code></p>` : ''}
  ${deepLink ? `<p><a href="${escapeHtml(deepLink)}" target="_blank" rel="noopener">Open source →</a></p>` : ''}
</div>
<div class="card">
  <pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(row.text)}</pre>
</div>
<h2>Entities</h2>
<div class="card">${entityPills}</div>
${chainHtml ? `<h2>Extraction chain</h2>\n<div class="card"><p class="meta">${chainHtml}</p></div>` : ''}
${feedbackButtons}
<script>
(function(){
  const id=${JSON.stringify(row.id)};
  const msg=document.getElementById('feedback-msg');
  async function post(path){
    const r=await fetch('/api/brain/ku/'+encodeURIComponent(id)+path,{method:'POST',headers:{'content-type':'application/json'}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }
  const imp=document.getElementById('btn-important');
  if(imp){
    imp.addEventListener('click',async()=>{
      imp.disabled=true;msg.textContent='';
      try{
        const j=await post('/important');
        imp.dataset.on=j.important?'1':'0';
        imp.classList.toggle('active',!!j.important);
        imp.textContent=j.important?'⭐ Important':'⭐ Mark important';
        msg.textContent='saved';
      }catch(e){msg.textContent=e.message;}finally{imp.disabled=false;}
    });
  }
  const app=document.getElementById('btn-approve');
  if(app){
    app.addEventListener('click',async()=>{
      app.disabled=true;msg.textContent='';
      try{
        await post('/approve');
        app.style.display='none';
        msg.textContent='approved';
      }catch(e){msg.textContent=e.message;app.disabled=false;}
    });
  }
  const rej=document.getElementById('btn-reject');
  if(rej && !rej.disabled){
    rej.addEventListener('click',async()=>{
      if(!confirm('Reject this KU? It will be excluded from retrieval.'))return;
      rej.disabled=true;msg.textContent='';
      try{
        await post('/reject');
        rej.textContent='🔴 Rejected';
        msg.textContent='rejected — reload to refresh header';
      }catch(e){msg.textContent=e.message;rej.disabled=false;}
    });
  }
})();
</script>`;
    res.type('html').send(
      brainShell(`KU ${row.id.slice(0, 8)} — Brain`, body, {
        reviewCount,
      }),
    );
  });

  // --- GET /brain/search — relevance-ranked search via recall() ---------
  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const account =
      req.query.account === 'personal' || req.query.account === 'work'
        ? req.query.account
        : 'work';
    const source = typeof req.query.source === 'string' ? req.query.source : '';
    const entity = typeof req.query.entity === 'string' ? req.query.entity : '';
    const fromStr = typeof req.query.from === 'string' ? req.query.from : '';
    const toStr = typeof req.query.to === 'string' ? req.query.to : '';
    const rawLimit =
      typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 20;

    const db = getDb();
    const reviewCount = getReviewCount(db);

    const filtersHtml = renderSearchFiltersForm({
      q,
      source,
      entity,
      account,
      from: fromStr,
      to: toStr,
      limit,
    });

    if (!q) {
      const body = `
<h1>Search the brain</h1>
${filtersHtml}
<div class="card"><p class="empty">Enter a query above to search the brain.</p></div>`;
      res.type('html').send(
        brainShell('Search — Brain', body, {
          activeNav: 'search',
          reviewCount,
        }),
      );
      return;
    }

    // recall() does RRF + rerank + recency + access + important. We fetch
    // a bit more than `limit` so post-filters (source/from/to) have room.
    let results: RecallResult[] = [];
    try {
      results = await recall(q, { account, limit: Math.max(limit, 50) });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), q },
        '/brain/search: recall failed',
      );
    }

    const fromMs = fromStr ? Date.parse(fromStr) : null;
    const toMs = toStr ? Date.parse(toStr) : null;

    const entityLinkedKuIds = entity
      ? new Set(
          (
            db
              .prepare(`SELECT ku_id FROM ku_entities WHERE entity_id = ?`)
              .all(entity) as Array<{ ku_id: string }>
          ).map((r) => r.ku_id),
        )
      : null;

    const filtered = results
      .filter((r) => (source ? r.source_type === source : true))
      .filter((r) => {
        if (!fromMs && !toMs) return true;
        const ts = Date.parse(r.recorded_at);
        if (!Number.isFinite(ts)) return false;
        if (fromMs !== null && Number.isFinite(fromMs) && ts < fromMs) return false;
        if (toMs !== null && Number.isFinite(toMs) && ts > toMs) return false;
        return true;
      })
      .filter((r) => (entityLinkedKuIds ? entityLinkedKuIds.has(r.ku_id) : true))
      .slice(0, limit);

    const resultsHtml = filtered.length
      ? `<ul>${filtered.map(renderSearchRow).join('')}</ul>`
      : '<p class="empty">No results.</p>';

    const body = `
<h1>Search: ${escapeHtml(q)}</h1>
${filtersHtml}
<div class="card">
  <p class="meta">${filtered.length} result${filtered.length === 1 ? '' : 's'} (of ${results.length} candidate${results.length === 1 ? '' : 's'})</p>
  ${resultsHtml}
</div>`;
    res.type('html').send(
      brainShell(`Search — ${q}`, body, {
        activeNav: 'search',
        reviewCount,
      }),
    );
  });

  return router;
}

function renderSearchFiltersForm(params: {
  q: string;
  source: string;
  entity: string;
  account: string;
  from: string;
  to: string;
  limit: number;
}): string {
  return `
<form class="searchbox" action="/brain/search" method="get">
  <input type="text" name="q" value="${escapeHtml(params.q)}" placeholder="Search…" autofocus>
  <button type="submit">Search</button>
</form>
<div class="card">
  <form action="/brain/search" method="get" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px">
    <input type="hidden" name="q" value="${escapeHtml(params.q)}">
    <label>source
      <select name="source">
        <option value=""${params.source === '' ? ' selected' : ''}>any</option>
        <option value="email"${params.source === 'email' ? ' selected' : ''}>email</option>
        <option value="gong"${params.source === 'gong' ? ' selected' : ''}>gong</option>
        <option value="hubspot"${params.source === 'hubspot' ? ' selected' : ''}>hubspot</option>
        <option value="tracked_item"${params.source === 'tracked_item' ? ' selected' : ''}>tracked_item</option>
        <option value="manual"${params.source === 'manual' ? ' selected' : ''}>manual</option>
        <option value="attachment"${params.source === 'attachment' ? ' selected' : ''}>attachment</option>
        <option value="browser"${params.source === 'browser' ? ' selected' : ''}>browser</option>
      </select>
    </label>
    <label>account
      <select name="account">
        <option value="work"${params.account === 'work' ? ' selected' : ''}>work</option>
        <option value="personal"${params.account === 'personal' ? ' selected' : ''}>personal</option>
      </select>
    </label>
    <label>entity <input type="text" name="entity" value="${escapeHtml(params.entity)}" placeholder="entity_id" style="width:160px"></label>
    <label>from <input type="date" name="from" value="${escapeHtml(params.from)}"></label>
    <label>to <input type="date" name="to" value="${escapeHtml(params.to)}"></label>
    <label>limit <input type="number" name="limit" value="${params.limit}" min="1" max="50" style="width:60px"></label>
    <button type="submit">Apply filters</button>
  </form>
</div>`;
}

/** Parse entity.canonical JSON and fall back to entity_id on error. */
function renderEntityDisplayName(entity: {
  entity_id: string;
  canonical: string | null;
}): string {
  if (!entity.canonical) return entity.entity_id;
  try {
    const parsed = JSON.parse(entity.canonical) as {
      name?: string;
      domain?: string;
      email?: string;
    };
    return parsed.name || parsed.domain || parsed.email || entity.entity_id;
  } catch {
    return entity.entity_id;
  }
}

function renderEntityRow(row: {
  entity_id: string;
  entity_type: string;
  canonical: string | null;
  ku_count: number;
}): string {
  const name = renderEntityDisplayName(row);
  return `<li>
    <a class="row-link" href="/brain/entities/${escapeHtml(row.entity_id)}">
      <div>
        <strong>${escapeHtml(name)}</strong>
        <span class="pill ${escapeHtml(row.entity_type)}">${escapeHtml(row.entity_type)}</span>
        <span class="meta">· ${row.ku_count} KU${row.ku_count === 1 ? '' : 's'}</span>
      </div>
    </a>
  </li>`;
}

function renderSearchRow(r: RecallResult): string {
  const first = r.text.replace(/\s+/g, ' ').trim();
  const subject = first.length > 80 ? first.slice(0, 80) + '…' : first;
  const age = formatAge(r.recorded_at);
  // The `finalScore` blend produces values in [0, 1]; we use it as a rough
  // proxy for confidence in the row since the raw KU confidence is not
  // exposed by recall(). It's a visualization, not a claim.
  return `<li>
    <a class="row-link" href="/brain/ku/${escapeHtml(r.ku_id)}">
      <div><strong>${escapeHtml(subject)}</strong> <span class="age">· ${age}</span></div>
      <div class="meta">
        <span class="pill source">${escapeHtml(r.source_type)}</span>
        ${r.important ? '<span class="pill" title="Marked important">⭐</span>' : ''}
        ${confidenceBar(r.finalScore)}
        <span>score ${r.finalScore.toFixed(2)}</span>
      </div>
    </a>
  </li>`;
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
  const reviewWriteQueue = makeReviewWriteQueue(() => getDb());

  router.get('/status', (_req, res) => {
    const db = getDb();
    res.json(getStatusFingerprint(db));
  });

  // POST /api/brain/ku/:id/important — toggle the important flag.
  // Returns the new value so the client can update its button state
  // without reloading.
  router.post('/ku/:id/important', async (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const row = db
      .prepare(`SELECT important FROM knowledge_units WHERE id = ?`)
      .get(id) as { important: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'ku_not_found' });
      return;
    }
    const next = row.important === 1 ? false : true;
    try {
      await markImportant(id, next);
      res.json({ important: next });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id },
        '/api/brain/ku/:id/important failed',
      );
      res.status(500).json({ error: 'important_write_failed' });
    }
  });

  // POST /api/brain/ku/:id/approve — clear needs_review + raise confidence.
  router.post('/ku/:id/approve', async (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const row = db
      .prepare(`SELECT id FROM knowledge_units WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'ku_not_found' });
      return;
    }
    try {
      await reviewWriteQueue.enqueue({ kind: 'approve', id });
      res.json({ ok: true });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id },
        '/api/brain/ku/:id/approve failed',
      );
      res.status(500).json({ error: 'approve_write_failed' });
    }
  });

  // POST /api/brain/ku/:id/reject — soft-delete (superseded_at = now). We
  // never hard-delete so audit trail + bitemporal history stays intact.
  router.post('/ku/:id/reject', async (req, res) => {
    const db = getDb();
    const id = req.params.id;
    const row = db
      .prepare(`SELECT id FROM knowledge_units WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'ku_not_found' });
      return;
    }
    try {
      await reviewWriteQueue.enqueue({
        kind: 'reject',
        id,
        ts: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id },
        '/api/brain/ku/:id/reject failed',
      );
      res.status(500).json({ error: 'reject_write_failed' });
    }
  });

  return router;
}

// --- Write-queue factories ---------------------------------------------

interface AccessBump {
  id: string;
  ts: string;
}

function makeAccessBumpQueue(
  getDb: () => Database.Database,
): AsyncWriteQueue<AccessBump> {
  return new AsyncWriteQueue<AccessBump>(
    async (batch) => {
      const db = getDb();
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
    { maxBatchSize: 20, maxLatencyMs: 50 },
  );
}

type ReviewWrite =
  | { kind: 'approve'; id: string }
  | { kind: 'reject'; id: string; ts: string };

function makeReviewWriteQueue(
  getDb: () => Database.Database,
): AsyncWriteQueue<ReviewWrite> {
  return new AsyncWriteQueue<ReviewWrite>(
    async (batch) => {
      const db = getDb();
      const approveStmt = db.prepare(
        `UPDATE knowledge_units
           SET needs_review = 0, confidence = 1.0 WHERE id = ?`,
      );
      const rejectStmt = db.prepare(
        `UPDATE knowledge_units SET superseded_at = ? WHERE id = ?`,
      );
      const txn = db.transaction((writes: ReviewWrite[]) => {
        for (const w of writes) {
          if (w.kind === 'approve') {
            approveStmt.run(w.id);
          } else {
            rejectStmt.run(w.ts, w.id);
          }
        }
      });
      txn(batch);
    },
    { maxBatchSize: 20, maxLatencyMs: 50 },
  );
}

/**
 * Best-effort deep link for a source_ref. Email threads open in Gmail;
 * other sources fall through (null) — UI hides the link when absent.
 */
function sourceDeepLink(
  sourceType: string,
  sourceRef: string | null,
): string | null {
  if (!sourceRef) return null;
  if (sourceType === 'email') {
    // Gmail thread deep link. Works for both accounts since it's anchored
    // by thread id; the user's active Gmail account resolves it.
    return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(sourceRef)}`;
  }
  return null;
}
