import express from 'express';
import type Database from 'better-sqlite3';
import { renderTaskDetail } from './templates/task-detail.js';
import { renderEmailFull } from './templates/email-full.js';
import { renderDraftDiff } from './templates/draft-diff.js';
import { escapeHtml } from './templates/escape.js';
import { renderProfileForm } from './templates/signer-profile.js';
import { getProfile, upsertProfile } from '../signer/profile.js';
import {
  getCachedEmailBody,
  cacheEmailBody,
  getCachedEmailMeta,
  cacheEmailMeta,
} from '../email-preview.js';
import type { GmailOps } from '../gmail-ops.js';
import type { DraftEnrichmentWatcher } from '../draft-enrichment.js';
import { logger } from '../logger.js';
import type { TaskStep, TaskLog } from './templates/task-detail.js';
import { PendingSendRegistry } from './pending-send.js';
import { createActionsRouter } from './actions.js';
import {
  detectSignUrl,
  isSignInvite,
  type SignDetection,
} from '../triage/sign-detector.js';

export interface MiniAppServerOpts {
  port: number;
  db: Database.Database;
  gmailOps?: GmailOps;
  draftWatcher?: DraftEnrichmentWatcher;
  eventBus?: import('../event-bus.js').EventBus;
  pendingSendRegistry?: PendingSendRegistry;
  fetchImpl?: typeof globalThis.fetch;
  spawnAgentTask?: import('./actions.js').SpawnAgentTask;
}

export function createMiniAppServer(opts: MiniAppServerOpts): express.Express {
  const registry = opts.pendingSendRegistry ?? new PendingSendRegistry();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    createActionsRouter({
      db: opts.db,
      gmailOps: opts.gmailOps,
      fetchImpl: opts.fetchImpl,
      pendingSendRegistry: registry,
      eventBus: opts.eventBus,
      spawnAgentTask: opts.spawnAgentTask,
    }),
  );

  // Root page — opened when user taps the "📱 App" menu button in Telegram.
  // Lists the attention and archive queues with live counts. The archive
  // queue supports bulk-select + "Archive selected" (POST /api/archive/bulk).
  app.get('/', (_req, res) => {
    const attention = opts.db
      .prepare(
        `SELECT id, title, detected_at, metadata FROM tracked_items
         WHERE state IN ('pushed','pending','held')
           AND (queue = 'attention'
                OR (queue IS NULL AND classification = 'push'))
         ORDER BY detected_at DESC
         LIMIT 20`,
      )
      .all() as Array<{
      id: string;
      title: string;
      detected_at: number;
      metadata: string | null;
    }>;
    const archive = opts.db
      .prepare(
        `SELECT id, title, action_intent, detected_at, metadata FROM tracked_items
         WHERE state = 'queued'
           AND (queue = 'archive_candidate'
                OR (queue IS NULL AND classification = 'digest'))
         ORDER BY detected_at DESC
         LIMIT 50`,
      )
      .all() as Array<{
      id: string;
      title: string;
      action_intent: string | null;
      detected_at: number;
      metadata: string | null;
    }>;

    const extractAccount = (metadata: string | null): string => {
      if (!metadata) return '';
      try {
        const m = JSON.parse(metadata) as { account?: string };
        return m.account ?? '';
      } catch (err) {
        logger.debug(
          { err, component: 'mini-app' },
          'tracked_items.metadata JSON.parse failed (home listing)',
        );
        return '';
      }
    };
    const parseMetadata = (
      metadata: string | null,
    ): { sender?: string; sign?: SignDetection } => {
      if (!metadata) return {};
      try {
        return JSON.parse(metadata) as {
          sender?: string;
          sign?: SignDetection;
        };
      } catch {
        return {};
      }
    };

    const esc = escapeHtml;
    const formatAge = (detectedAt: number) => {
      // Floor (not round) so a 59-minute-old item reads "59m" not "1h" —
      // "time elapsed so far" should never overshoot the actual elapsed
      // time.
      const mins = Math.floor((Date.now() - detectedAt) / 60_000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days}d`;
      const weeks = Math.floor(days / 7);
      return `${weeks}w`;
    };
    const emailHref = (id: string, metadata: string | null) => {
      const account = extractAccount(metadata);
      const qs = account ? `?account=${encodeURIComponent(account)}` : '';
      return `/email/${esc(id)}${qs}`;
    };
    const attentionRow = (it: {
      id: string;
      title: string;
      detected_at: number;
      metadata: string | null;
    }) => {
      const age = formatAge(it.detected_at);
      const meta = parseMetadata(it.metadata);
      const signable = isSignInvite({
        from: meta.sender ?? '',
        subject: it.title ?? '',
      });
      const signBtn = signable
        ? ` <a class="sign-btn" href="/api/email/${esc(it.id)}/sign" target="_blank" rel="noopener" title="Open signing page">✍ Sign</a>`
        : '';
      return `<li><a class="title" href="${emailHref(it.id, it.metadata)}">${esc(it.title || '(no subject)')}</a>${signBtn} <span class="age">${age}</span></li>`;
    };
    const archiveRow = (it: {
      id: string;
      title: string;
      detected_at: number;
      metadata: string | null;
    }) => {
      const age = formatAge(it.detected_at);
      return `<li><label class="check"><input type="checkbox" class="sel" value="${esc(it.id)}"><a class="title" href="${emailHref(it.id, it.metadata)}">${esc(it.title || '(no subject)')}</a> <span class="age">${age}</span></label></li>`;
    };

    res.type('html').send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nanoclaw</title>
<style>
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px 16px 80px;background:#f4f6f8;color:#111}
h1{font-size:18px;margin:0 0 16px}
h2{font-size:15px;margin:20px 0 8px;color:#444;display:flex;align-items:center;gap:10px}
h2 .tools{font-size:12px;font-weight:400;color:#0366d6;cursor:pointer;user-select:none}
ul{list-style:none;padding:0;margin:0;background:#fff;border-radius:10px;overflow:hidden}
li{border-bottom:1px solid #eee}
li:last-child{border-bottom:none}
li a.title{color:#0366d6;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li a{color:#0366d6;text-decoration:none}
.sign-btn{flex:none;background:#1f6feb;color:#fff!important;padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap}
.sign-btn:hover{background:#388bfd}
.age{color:#888;font-size:12px;flex:none}
.empty{color:#888;font-style:italic;padding:10px 14px;background:#fff;border-radius:10px}
#attention li{padding:10px 14px;display:flex;justify-content:space-between;gap:8px;align-items:baseline}
#archive label.check{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer}
#archive input.sel{width:18px;height:18px;flex:none;cursor:pointer}
#bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e3e6ea;padding:10px 16px;display:flex;gap:10px;align-items:center;box-shadow:0 -2px 8px rgba(0,0,0,0.04)}
#bar .count{font-size:14px;color:#444;flex:1}
#bar button{background:#d9534f;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer}
#bar button:disabled{background:#c6c9cd;cursor:not-allowed}
</style></head><body>
<h1>nanoclaw</h1>
<h2>📥 Attention (${attention.length})</h2>
${attention.length === 0 ? '<div class="empty">Inbox is clear.</div>' : `<ul id="attention">${attention.map(attentionRow).join('')}</ul>`}
<h2>🗂 Archive queue (${archive.length}) ${archive.length > 0 ? '<span class="tools" id="sel-all">Select all</span> <span class="tools" id="sel-none">Clear</span>' : ''}</h2>
${archive.length === 0 ? '<div class="empty">Nothing queued for archive.</div>' : `<ul id="archive">${archive.map(archiveRow).join('')}</ul>`}
${
  archive.length > 0
    ? `<div id="bar">
<span class="count" id="count">0 selected</span>
<button id="go" disabled>🗃 Archive selected</button>
</div>
<script>
(function(){
  const boxes=()=>[...document.querySelectorAll('input.sel')];
  const selected=()=>boxes().filter(b=>b.checked).map(b=>b.value);
  const count=document.getElementById('count');
  const go=document.getElementById('go');
  function refresh(){
    const n=selected().length;
    count.textContent=n+' selected';
    go.disabled=n===0;
    go.textContent=n===0?'🗃 Archive selected':'🗃 Archive '+n;
  }
  document.getElementById('archive').addEventListener('change',refresh);
  document.getElementById('sel-all').addEventListener('click',()=>{boxes().forEach(b=>b.checked=true);refresh();});
  document.getElementById('sel-none').addEventListener('click',()=>{boxes().forEach(b=>b.checked=false);refresh();});
  // Prevent link clicks from toggling the checkbox label.
  document.querySelectorAll('#archive a').forEach(a=>a.addEventListener('click',e=>e.stopPropagation()));
  go.addEventListener('click',async()=>{
    const ids=selected();
    if(ids.length===0)return;
    go.disabled=true;go.textContent='Archiving…';
    try{
      const r=await fetch('/api/archive/bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemIds:ids})});
      if(!r.ok)throw new Error('HTTP '+r.status);
      location.reload();
    }catch(err){go.disabled=false;go.textContent='Retry — '+err.message;}
  });
})();
</script>`
    : ''
}
</body></html>`);
  });

  // Bulk archive — takes a list of tracked_item ids, archives each thread
  // in Gmail (removes INBOX label), then resolves the local row. Items
  // whose Gmail archive fails stay queued so the user can retry. Requires
  // gmailOps to be wired up; otherwise falls back to local-only resolve
  // for backwards compatibility.
  app.post('/api/archive/bulk', async (req, res) => {
    const body = req.body as { itemIds?: unknown } | undefined;
    const ids = Array.isArray(body?.itemIds)
      ? (body!.itemIds as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : [];
    if (ids.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'itemIds required (non-empty string[])',
        code: 'INVALID_BODY',
      });
      return;
    }
    // Cap per-request batch size. Each id triggers a Gmail API call; without
    // a cap a single request can wedge the event loop and burn through the
    // account's per-minute rate budget.
    const MAX_BULK = 100;
    if (ids.length > MAX_BULK) {
      res.status(413).json({
        ok: false,
        error: `Too many itemIds: ${ids.length} > ${MAX_BULK}`,
        code: 'BATCH_TOO_LARGE',
      });
      return;
    }

    const placeholders = ids.map(() => '?').join(',');
    const rows = opts.db
      .prepare(
        `SELECT id, thread_id, metadata FROM tracked_items
         WHERE state = 'queued'
           AND id IN (${placeholders})
           AND (queue = 'archive_candidate'
                OR (queue IS NULL AND classification = 'digest'))`,
      )
      .all(...ids) as Array<{
      id: string;
      thread_id: string | null;
      metadata: string | null;
    }>;

    const succeededIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];

    for (const row of rows) {
      let account: string | null = null;
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata) as { account?: string };
          account = meta.account ?? null;
        } catch (err) {
          logger.debug(
            { err, id: row.id, component: 'mini-app' },
            'tracked_items.metadata JSON.parse failed (bulk archive)',
          );
        }
      }

      if (!opts.gmailOps || !account || !row.thread_id) {
        failures.push({
          id: row.id,
          error: !opts.gmailOps
            ? 'gmail_unavailable'
            : !account
              ? 'missing_account'
              : 'missing_thread_id',
        });
        continue;
      }

      try {
        await opts.gmailOps.archiveThread(account, row.thread_id);
        succeededIds.push(row.id);
      } catch (err) {
        failures.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let archived = 0;
    if (succeededIds.length > 0) {
      const ph = succeededIds.map(() => '?').join(',');
      const info = opts.db
        .prepare(
          `UPDATE tracked_items
           SET state = 'resolved',
               resolution_method = 'miniapp:bulk_archive',
               resolved_at = ?
           WHERE state = 'queued'
             AND id IN (${ph})`,
        )
        .run(Date.now(), ...succeededIds);
      archived = info.changes;
    }

    logger.info(
      {
        requested: ids.length,
        matched: rows.length,
        archived,
        failed: failures.length,
      },
      'Mini-app bulk archive',
    );
    res.json({
      ok: true,
      archived,
      requested: ids.length,
      failed: failures.length,
      failures: failures.slice(0, 10),
    });
  });

  function lookupDraftAccount(draftId: string): string | null {
    const row = opts.db
      .prepare('SELECT account FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as { account: string } | undefined;
    return row?.account ?? null;
  }

  app.get('/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId) as Record<string, string> | undefined;

    if (!row) {
      res.status(404).send('Task not found');
      return;
    }

    const html = renderTaskDetail({
      taskId: row.task_id,
      title: row.title,
      status: row.status as 'active' | 'blocked' | 'complete',
      steps: JSON.parse(row.steps_json) as TaskStep[],
      logs: JSON.parse(row.log_json) as TaskLog[],
      startedAt: row.started_at,
    });

    res.type('html').send(html);
  });

  // SSE endpoint for live task updates
  app.get('/api/task/:taskId/stream', (req, res) => {
    const { taskId } = req.params;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send current state immediately
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);
    if (row) {
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    }

    // Poll for changes every 2 seconds
    const intervalId = setInterval(() => {
      const current = opts.db
        .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
        .get(taskId) as Record<string, string> | undefined;
      if (current) {
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        // Stop polling if task is complete
        if (current.status === 'complete') {
          res.write('event: complete\ndata: {}\n\n');
          clearInterval(intervalId);
          res.end();
        }
      }
    }, 2000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(intervalId);
    });
  });

  app.get('/api/task/:taskId/state', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);

    if (!row) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json(row);
  });

  // --- Health endpoints ---
  // Quick liveness check for the Gmail→local reconciler: shows last-tick
  // timestamp, duration, counts, and totals since process start. Returns
  // 503 if the reconciler has never run yet.
  app.get('/api/health/reconciler', async (_req, res) => {
    const { getReconcilerStatus } =
      await import('../triage/gmail-reconciler.js');
    const s = getReconcilerStatus();
    if (s.lastTickAt === null) {
      res.status(503).json({ status: 'pending', ...s });
      return;
    }
    const ageMs = Date.now() - s.lastTickAt;
    res.json({
      status: ageMs < 5 * 60 * 1000 ? 'ok' : 'stale',
      lastTickAgeMs: ageMs,
      ...s,
    });
  });

  // --- Email full view ---
  app.get('/email/:emailId', async (req, res) => {
    const { emailId } = req.params;
    let account = (req.query.account as string) || '';

    // The URL's emailId is usually nanoclaw's internal tracked_items.id
    // (e.g. "sse-1776537105419-552jdw"), not a Gmail message id. Look the
    // row up so we can (a) use metadata.account when ?account= is missing,
    // and (b) extract the real Gmail thread/message id from source_id
    // ("gmail:19da1d9492...") for the API call below. Match by id first,
    // then thread_id, then source_id — any of those could be the URL id
    // depending on how the link was generated.
    let gmailId: string | null = null;
    try {
      const row = opts.db
        .prepare(
          `SELECT metadata, source_id, thread_id FROM tracked_items
           WHERE id = ? OR thread_id = ? OR source_id = ?
           ORDER BY detected_at DESC LIMIT 1`,
        )
        .get(emailId, emailId, emailId) as
        | {
            metadata: string | null;
            source_id: string | null;
            thread_id: string | null;
          }
        | undefined;
      if (row) {
        if (!account && row.metadata) {
          try {
            const m = JSON.parse(row.metadata) as { account?: string };
            if (m.account) account = m.account;
          } catch (err) {
            logger.debug(
              { err, emailId, component: 'mini-app' },
              'tracked_items.metadata JSON.parse failed (email view)',
            );
          }
        }
        // source_id is canonical; thread_id is a fallback. Strip the
        // "gmail:" prefix so the Gmail API accepts it.
        const raw = row.source_id || row.thread_id || '';
        gmailId = raw.startsWith('gmail:') ? raw.slice('gmail:'.length) : raw;
      }
    } catch (err) {
      // tracked_items table may not exist in minimal test DBs; legacy
      // callers can still pass a raw Gmail message id in the URL.
      logger.debug(
        { err, emailId, component: 'mini-app' },
        'tracked_items lookup failed (email view) — falling back to URL id',
      );
    }

    // Cache lookup uses the URL id since that's stable.
    let meta = getCachedEmailMeta(emailId);

    // If we resolved a gmail id and still don't have meta, try it. The
    // helper tries messages.get first, then falls back to threads.get
    // when the id is a thread id (which is what source_id carries).
    const idForGmail = gmailId || emailId;
    if (!meta && opts.gmailOps && account) {
      try {
        meta = await opts.gmailOps.getMessageMeta(account, idForGmail);
        if (meta) cacheEmailMeta(emailId, meta);
      } catch (err) {
        logger.warn(
          { emailId, idForGmail, err },
          'Failed to fetch email meta for Mini App',
        );
      }
    }

    if (!meta) {
      let body = getCachedEmailBody(emailId);
      if (!body && opts.gmailOps && account) {
        try {
          body = await opts.gmailOps.getMessageBody(account, idForGmail);
          if (body) cacheEmailBody(emailId, body);
        } catch (err) {
          logger.warn(
            { emailId, idForGmail, err },
            'Failed to fetch email body for Mini App',
          );
        }
      }
      meta = {
        subject: '',
        from: '',
        to: '',
        date: '',
        body: body || 'Email body could not be loaded.',
      };
    }

    // Classification / sender fields for the context-aware action row.
    let classification: string | null = null;
    let senderKind: string | null = null;
    let subtype: string | null = null;
    try {
      const row2 = opts.db
        .prepare(
          `SELECT classification, sender_kind, subtype FROM tracked_items
           WHERE id = ? OR thread_id = ? OR source_id = ?
           ORDER BY detected_at DESC LIMIT 1`,
        )
        .get(emailId, emailId, emailId) as
        | {
            classification: string | null;
            sender_kind: string | null;
            subtype: string | null;
          }
        | undefined;
      if (row2) {
        classification = row2.classification;
        senderKind = row2.sender_kind;
        subtype = row2.subtype;
      }
    } catch (err) {
      logger.debug(
        { err, emailId, component: 'mini-app' },
        'classification/sender lookup failed — defaulting to null',
      );
    }
    const metaHeaders = (meta as { headers?: Record<string, string> })?.headers;
    const hasUnsubscribeHeader = !!(
      metaHeaders?.['List-Unsubscribe'] || metaHeaders?.['list-unsubscribe']
    );

    // Opportunistic sign-URL caching — if the body looks like a signature
    // invite, persist the detection into metadata so the Attention list
    // can offer an immediate deep link on next render. Fire-and-forget;
    // the detail page render does not depend on it.
    let signableDetected = false;
    if (meta.body) {
      try {
        const detection = detectSignUrl({
          from: meta.from || '',
          subject: meta.subject || '',
          body: meta.body,
        });
        if (detection) {
          signableDetected = true;
          const row = opts.db
            .prepare(
              `SELECT id, metadata FROM tracked_items
               WHERE id = ? OR thread_id = ? OR source_id = ?
               ORDER BY detected_at DESC LIMIT 1`,
            )
            .get(emailId, emailId, emailId) as
            | { id: string; metadata: string | null }
            | undefined;
          if (row) {
            let parsed: Record<string, unknown> = {};
            if (row.metadata) {
              try {
                parsed = JSON.parse(row.metadata);
              } catch {
                parsed = {};
              }
            }
            const existing = (parsed as { sign?: SignDetection }).sign;
            if (!existing || existing.signUrl !== detection.signUrl) {
              const updated = { ...parsed, sign: detection };
              opts.db
                .prepare(`UPDATE tracked_items SET metadata = ? WHERE id = ?`)
                .run(JSON.stringify(updated), row.id);
            }
          }
        }
      } catch (err) {
        logger.debug(
          { err, emailId, component: 'mini-app' },
          'sign-detector cache-on-view failed',
        );
      }
    }

    const signable =
      signableDetected ||
      isSignInvite({ from: meta.from || '', subject: meta.subject || '' });

    const html = renderEmailFull({
      subject: meta.subject || `Email ${emailId}`,
      from: meta.from || '',
      to: meta.to || '',
      date: meta.date || '',
      body: meta.body || 'Email body could not be loaded.',
      cc: meta.cc,
      attachments: [],
      emailId,
      account,
      gmailId: gmailId || undefined,
      classification:
        classification as import('./templates/action-row.js').Classification,
      senderKind: senderKind as import('./templates/action-row.js').SenderKind,
      subtype: subtype as import('./templates/action-row.js').Subtype,
      hasUnsubscribeHeader,
      signable,
    });
    res.type('html').send(html);
  });

  // Resolves the e-signature URL for a tracked item. Returns the cached
  // detection from metadata.sign if present, otherwise fetches the body
  // once, runs the detector, and persists the hit so the Attention list
  // can surface an immediate deep-link next render. Returns null when no
  // signing URL is recognizable — caller should 302 to the email detail
  // page as a fallback.
  async function resolveSignDetection(
    emailId: string,
  ): Promise<SignDetection | null> {
    const row = opts.db
      .prepare(
        `SELECT id, metadata, source_id, thread_id, title FROM tracked_items
         WHERE id = ? OR thread_id = ? OR source_id = ?
         ORDER BY detected_at DESC LIMIT 1`,
      )
      .get(emailId, emailId, emailId) as
      | {
          id: string;
          metadata: string | null;
          source_id: string | null;
          thread_id: string | null;
          title: string | null;
        }
      | undefined;
    if (!row) return null;

    let parsed: {
      account?: string;
      sender?: string;
      sign?: SignDetection;
      [k: string]: unknown;
    } = {};
    if (row.metadata) {
      try {
        parsed = JSON.parse(row.metadata);
      } catch {
        parsed = {};
      }
    }
    if (parsed.sign?.signUrl) return parsed.sign;

    if (!opts.gmailOps || !parsed.account) return null;

    const raw = row.source_id || row.thread_id || '';
    const gmailId = raw.startsWith('gmail:') ? raw.slice('gmail:'.length) : raw;

    let body = getCachedEmailBody(emailId);
    if (!body) {
      try {
        body = await opts.gmailOps.getMessageBody(parsed.account, gmailId);
        if (body) cacheEmailBody(emailId, body);
      } catch (err) {
        logger.warn(
          { emailId, err, component: 'mini-app' },
          'sign-resolve: body fetch failed',
        );
        return null;
      }
    }
    if (!body) return null;

    const detection = detectSignUrl({
      from: parsed.sender ?? '',
      subject: row.title ?? '',
      body,
    });
    if (!detection) return null;

    const updated = { ...parsed, sign: detection };
    opts.db
      .prepare(`UPDATE tracked_items SET metadata = ? WHERE id = ?`)
      .run(JSON.stringify(updated), row.id);

    return detection;
  }

  // Sign redirect — resolves the signing URL (cached or lazy-fetched) and
  // 302s to the vendor page. Never signs anything itself; the vendor
  // still requires the user to review + click Sign on their page.
  app.get('/api/email/:emailId/sign', async (req, res) => {
    const { emailId } = req.params;
    try {
      const detection = await resolveSignDetection(emailId);
      if (detection) {
        res.redirect(302, detection.signUrl);
        return;
      }
      // Fallback: open the full email so the user can click the link themselves.
      res.redirect(302, `/email/${encodeURIComponent(emailId)}`);
    } catch (err) {
      logger.warn(
        { emailId, err, component: 'mini-app' },
        'sign-redirect failed',
      );
      res.redirect(302, `/email/${encodeURIComponent(emailId)}`);
    }
  });

  // --- Archive email API ---
  // Resolve `account` and Gmail thread id from tracked_items by emailId.
  // We do NOT trust the request body for either field — a caller who knows
  // an emailId should not be able to archive a thread in an arbitrary
  // account by supplying its alias in the POST payload.
  app.post('/api/email/:emailId/archive', async (req, res) => {
    const { emailId } = req.params;
    if (!opts.gmailOps) {
      res.status(503).json({
        ok: false,
        error: 'Gmail not configured',
        code: 'GMAIL_UNAVAILABLE',
      });
      return;
    }
    let account: string | null = null;
    let resolvedThreadId: string | null = null;
    try {
      const row = opts.db
        .prepare(
          `SELECT metadata, source_id, thread_id FROM tracked_items
           WHERE id = ? OR thread_id = ? OR source_id = ?
           ORDER BY detected_at DESC LIMIT 1`,
        )
        .get(emailId, emailId, emailId) as
        | {
            metadata: string | null;
            source_id: string | null;
            thread_id: string | null;
          }
        | undefined;
      if (row) {
        if (row.metadata) {
          try {
            const m = JSON.parse(row.metadata) as { account?: string };
            account = m.account ?? null;
          } catch (err) {
            logger.debug(
              { err, emailId, component: 'mini-app' },
              'tracked_items.metadata JSON.parse failed (archive)',
            );
          }
        }
        const raw = row.source_id || row.thread_id || '';
        resolvedThreadId = raw.startsWith('gmail:')
          ? raw.slice('gmail:'.length)
          : raw || null;
      }
    } catch (err) {
      logger.debug(
        { err, emailId, component: 'mini-app' },
        'tracked_items lookup failed (archive)',
      );
    }
    if (!account || !resolvedThreadId) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    try {
      await opts.gmailOps.archiveThread(account, resolvedThreadId);
      // `success: true` kept for backward compat with existing clients;
      // new `ok: true` matches the reply-send spec.
      res.json({ ok: true, success: true });
    } catch (err) {
      logger.error({ emailId, err }, 'Mini app archive failed');
      res.status(500).json({
        ok: false,
        error: 'Archive failed',
        code: 'GMAIL_API_ERROR',
      });
    }
  });

  // --- Draft diff view ---
  app.get('/draft-diff/:draftId', (req, res) => {
    const { draftId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as
      | { account: string; original_body: string; enriched_at: string }
      | undefined;

    if (!row) {
      res.status(404).send('Draft not found');
      return;
    }

    const html = renderDraftDiff({
      draftId,
      account: row.account,
      originalBody: row.original_body,
      enrichedBody: null,
      enrichedAt: row.enriched_at,
    });
    res.type('html').send(html);
  });

  // --- Draft revert API ---
  app.post('/api/draft/:draftId/revert', async (req, res) => {
    const { draftId } = req.params;
    if (!opts.draftWatcher) {
      res.status(503).json({
        ok: false,
        success: false,
        error: 'Draft watcher not configured',
        code: 'WATCHER_UNAVAILABLE',
      });
      return;
    }
    try {
      const success = await opts.draftWatcher.revert(draftId);
      // `success` kept for backward compat; `ok` mirrors the reply-send spec.
      res.json({ ok: success, success });
    } catch (err) {
      logger.error({ draftId, err }, 'Draft revert failed');
      res.status(500).json({
        ok: false,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        code: 'INTERNAL',
      });
    }
  });

  // --- Reply view (render) ---
  app.get('/reply/:draftId', async (req, res) => {
    const { draftId } = req.params;
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res
        .type('html')
        .send(
          '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
        );
      return;
    }
    if (!opts.gmailOps) {
      res.status(500).type('html').send('Gmail ops not configured');
      return;
    }
    try {
      const ctx = await opts.gmailOps.getDraftReplyContext(account, draftId);
      if (!ctx) {
        res
          .type('html')
          .send(
            '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
          );
        return;
      }
      const html = renderEmailFull({
        mode: 'reply',
        draftId,
        account,
        subject: ctx.incoming.subject,
        from: ctx.incoming.from,
        to: ctx.incoming.to,
        cc: ctx.incoming.cc,
        date: ctx.incoming.date,
        body: ctx.body,
        attachments: [],
      });
      res.type('html').send(html);
    } catch (err) {
      logger.error({ draftId, err }, 'Failed to render /reply');
      res.status(500).type('html').send('Failed to load draft');
    }
  });

  // --- Save draft body ---
  app.patch('/api/draft/:draftId/save', async (req, res) => {
    const { draftId } = req.params;
    const body = req.body?.body;
    if (typeof body !== 'string') {
      res.status(400).json({
        ok: false,
        error: 'body field must be a string',
        code: 'INVALID_BODY',
      });
      return;
    }
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res.status(404).json({
        ok: false,
        error: 'Draft not found',
        code: 'DRAFT_NOT_FOUND',
      });
      return;
    }
    if (!opts.gmailOps) {
      res
        .status(500)
        .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
      return;
    }
    try {
      await opts.gmailOps.updateDraft(account, draftId, body);
      logger.info(
        { account, draftId, bodyLen: body.length, component: 'mini-app' },
        'Draft save via mini-app',
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error(
        { account, draftId, err, component: 'mini-app' },
        'Draft save failed from mini-app',
      );
      res.status(500).json({
        ok: false,
        error: 'Gmail API error',
        code: 'GMAIL_API_ERROR',
      });
    }
  });

  // --- Schedule send with 10s undo window ---
  app.post('/api/draft/:draftId/send', async (req, res) => {
    const { draftId } = req.params;
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res.status(404).json({
        ok: false,
        error: 'Draft not found',
        code: 'DRAFT_NOT_FOUND',
      });
      return;
    }
    if (!opts.gmailOps) {
      res
        .status(500)
        .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
      return;
    }
    const delayMs = 10_000;
    const { sendAt } = registry.schedule(
      draftId,
      account,
      delayMs,
      async (id, acct) => {
        try {
          await opts.gmailOps!.sendDraft(acct, id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { account: acct, draftId: id, err, component: 'mini-app' },
            'Draft send failed',
          );
          opts.eventBus?.emit('email.draft.send_failed', {
            type: 'email.draft.send_failed',
            source: 'mini-app',
            timestamp: Date.now(),
            payload: { draftId: id, account: acct, error: message },
          });
        }
      },
    );
    logger.info(
      { account, draftId, sendAt, delayMs, component: 'mini-app' },
      'Draft send scheduled',
    );
    res.json({ ok: true, sendAt });
  });

  // --- Cancel pending send ---
  app.post('/api/draft/:draftId/send/cancel', (req, res) => {
    const { draftId } = req.params;
    const cancelled = registry.cancel(draftId);
    if (cancelled) {
      logger.info({ draftId, component: 'mini-app' }, 'Draft send cancelled');
    }
    res.json({ ok: true, cancelled });
  });

  // --- Signer profile settings page ---
  app.get('/signer/profile', (_req, res) => {
    const profile = getProfile(opts.db);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderProfileForm(profile));
  });

  app.post('/signer/profile', (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    if (!body.fullName || !body.initials) {
      res.status(400).send('fullName and initials are required');
      return;
    }
    upsertProfile(opts.db, {
      fullName: body.fullName,
      initials: body.initials,
      title: body.title || null,
      address: body.address || null,
      phone: body.phone || null,
    });
    res.redirect('/signer/profile');
  });

  return app;
}

export function startMiniAppServer(opts: MiniAppServerOpts): {
  server: ReturnType<express.Application['listen']>;
  registry: PendingSendRegistry;
} {
  const registry = new PendingSendRegistry();
  const app = createMiniAppServer({ ...opts, pendingSendRegistry: registry });
  const server = app.listen(opts.port, () => {
    logger.info({ port: opts.port }, 'Mini App server started');
  });
  return { server, registry };
}
