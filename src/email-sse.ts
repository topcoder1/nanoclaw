/**
 * SSE client for real-time email triage notifications from superpilot.
 *
 * Maintains one persistent SSE connection per configured service token.
 * When new triaged emails arrive, writes IPC trigger files for the agent.
 * Each connection has independent reconnect/backoff state.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import type Database from 'better-sqlite3';

import {
  DATA_DIR,
  EMAIL_INTELLIGENCE_ENABLED,
  SSE_CONNECTIONS,
  SUPERPILOT_API_URL,
} from './config.js';
import { eventBus } from './event-bus.js';
import type { EmailReceivedEvent } from './events.js';
import type { GmailOps } from './gmail-ops.js';
import { logger } from './logger.js';
import type { EmailTriggerDebouncer } from './email-trigger-debouncer.js';
import { isThreadMuted } from './triage/mute-filter.js';
import { classifySender, classifySubtype } from './triage/sender-kind.js';

const SSE_RECONNECT_MIN_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 300_000; // 5 minutes max backoff

/** Per-connection state for independent reconnect/backoff. */
interface SSEConnection {
  label: string;
  token: string;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  currentRequest: ReturnType<typeof https.get> | null;
}

let running = false;
const connections: SSEConnection[] = [];

let debouncer: EmailTriggerDebouncer | null = null;

export function setEmailTriggerDebouncer(d: EmailTriggerDebouncer): void {
  debouncer = d;
}

export function getEmailTriggerDebouncer(): EmailTriggerDebouncer | null {
  return debouncer;
}

/**
 * Start SSE connections to superpilot.
 * Call once at startup — reconnects are handled internally.
 * Spawns one connection per configured service token.
 */
export function startEmailSSE(): void {
  if (!EMAIL_INTELLIGENCE_ENABLED) {
    logger.debug('Email intelligence disabled, skipping SSE connections');
    return;
  }

  if (SSE_CONNECTIONS.length === 0) {
    logger.warn('No NANOCLAW_SERVICE_TOKEN configured, skipping SSE');
    return;
  }

  running = true;

  for (const { token, label } of SSE_CONNECTIONS) {
    const conn: SSEConnection = {
      label,
      token,
      reconnectMs: SSE_RECONNECT_MIN_MS,
      reconnectTimer: null,
      currentRequest: null,
    };
    connections.push(conn);
    connect(conn);
  }

  logger.info(
    { count: connections.length, labels: connections.map((c) => c.label) },
    'SSE connections started',
  );
}

/**
 * Stop all SSE connections.
 */
export function stopEmailSSE(): void {
  running = false;
  for (const conn of connections) {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.currentRequest) {
      conn.currentRequest.destroy();
      conn.currentRequest = null;
    }
  }
  connections.length = 0;
}

function connect(conn: SSEConnection): void {
  if (!running) return;

  const url = new URL(`${SUPERPILOT_API_URL}/nanoclaw/events`);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      Accept: 'text/event-stream',
      'x-service-token': conn.token,
      'Cache-Control': 'no-cache',
    },
  };

  logger.info(
    { url: url.toString(), label: conn.label },
    'SSE connecting to superpilot',
  );

  conn.currentRequest = mod.get(options, (res) => {
    if (res.statusCode !== 200) {
      logger.warn(
        { statusCode: res.statusCode, label: conn.label },
        'SSE connection rejected',
      );
      res.destroy();
      scheduleReconnect(conn);
      return;
    }

    // Connected successfully — reset backoff
    conn.reconnectMs = SSE_RECONNECT_MIN_MS;
    logger.info({ label: conn.label }, 'SSE connected to superpilot');

    let buffer = '';

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse SSE events from buffer
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // Keep incomplete event in buffer

      for (const part of parts) {
        if (!part.trim() || part.startsWith(':')) continue; // Skip heartbeats/comments

        const lines = part.split('\n');
        let eventType = '';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          }
        }

        if (eventType === 'triaged_emails' && data) {
          handleTriagedEmails(data, conn.label);
        }
      }
    });

    res.on('end', () => {
      logger.info({ label: conn.label }, 'SSE connection closed by server');
      scheduleReconnect(conn);
    });

    res.on('error', (err) => {
      logger.warn(
        { err: err.message, label: conn.label },
        'SSE connection error',
      );
      scheduleReconnect(conn);
    });
  });

  conn.currentRequest.on('error', (err) => {
    logger.warn({ err: err.message, label: conn.label }, 'SSE request error');
    scheduleReconnect(conn);
  });
}

function scheduleReconnect(conn: SSEConnection): void {
  if (!running) return;

  conn.currentRequest = null;
  logger.info(
    { reconnectMs: conn.reconnectMs, label: conn.label },
    'SSE reconnecting',
  );

  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    connect(conn);
  }, conn.reconnectMs);

  // Exponential backoff
  conn.reconnectMs = Math.min(conn.reconnectMs * 2, SSE_RECONNECT_MAX_MS);
}

export function writeIpcTrigger(
  emails: Array<{
    thread_id: string;
    account: string;
    subject?: string;
    sender?: string;
    snippet?: string;
  }>,
  label: string,
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'tasks');
  fs.mkdirSync(ipcDir, { recursive: true });

  const payload = {
    type: 'email_trigger',
    emails: emails.map((e) => ({
      thread_id: e.thread_id,
      account: e.account || 'unknown',
      subject: e.subject || '',
      sender: e.sender || '',
      snippet: e.snippet || '',
    })),
    triggered_at: new Date().toISOString(),
    source: 'sse',
    connection: label,
  };

  const filename = `sse_trigger_${Date.now()}.json`;
  fs.writeFileSync(
    path.join(ipcDir, filename),
    JSON.stringify(payload, null, 2),
  );
  logger.info(
    { count: emails.length, filename, label },
    'SSE email trigger written',
  );
}

function handleTriagedEmails(data: string, label: string): void {
  try {
    const parsed = JSON.parse(data);
    const rawEmails = parsed.emails;
    if (!rawEmails || rawEmails.length === 0) return;

    // Upstream data-quality probe. The classifier-pipeline-v1 rollout
    // revealed that ~99% of SuperPilot SSE events arrive with empty
    // subject/sender/snippet — the classifier runs before Gmail indexing
    // catches up. Counting here lets us watch the ratio over time and
    // decide when/if to request the upstream fix.
    const n = rawEmails.length;
    let withSubject = 0;
    let withSender = 0;
    let withSnippet = 0;
    for (const e of rawEmails as Array<{
      subject?: string;
      sender?: string;
      snippet?: string;
    }>) {
      if (e.subject && e.subject.length > 0) withSubject++;
      if (e.sender && e.sender.length > 0) withSender++;
      if (e.snippet && e.snippet.length > 0) withSnippet++;
    }
    logger.info(
      { label, total: n, withSubject, withSender, withSnippet },
      'SSE triaged_emails field-presence',
    );

    // Drop test-fixture triggers at the edge. Dev harnesses and QA scripts
    // fire thread_ids like `test-approval-v2`, `test-approval-verify`, etc.
    // that aren't real Gmail threads — processing them wakes the agent for
    // work it can't complete and produces misleading Telegram output.
    const emails = rawEmails.filter(
      (e: { thread_id?: string }) =>
        !!e.thread_id && !/^test-approval[-_]/i.test(e.thread_id),
    );
    if (emails.length === 0) {
      logger.info(
        { skipped: rawEmails.length, label },
        'Skipped SSE trigger — all emails matched test-fixture pattern',
      );
      return;
    }
    if (emails.length < rawEmails.length) {
      logger.info(
        {
          dropped: rawEmails.length - emails.length,
          kept: emails.length,
          label,
        },
        'Filtered test-fixture emails from SSE trigger',
      );
    }

    // Buffer emails in debouncer (merges rapid-fire triggers into one IPC file)
    // or write IPC directly if no debouncer is configured
    if (debouncer) {
      debouncer.add(
        emails.map(
          (e: {
            thread_id: string;
            account: string;
            subject?: string;
            sender?: string;
            snippet?: string;
          }) => ({
            thread_id: e.thread_id,
            account: e.account || 'unknown',
            subject: e.subject || '',
            sender: e.sender || '',
            snippet: e.snippet || '',
          }),
        ),
        label,
      );
    } else {
      writeIpcTrigger(emails, label);
    }

    // Emit structured event for the event router / proactive monitor
    const emailEvent: EmailReceivedEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {
        count: emails.length,
        emails: emails.map(
          (e: {
            thread_id: string;
            account: string;
            subject?: string;
            sender?: string;
            snippet?: string;
          }) => ({
            thread_id: e.thread_id,
            account: e.account || 'unknown',
            subject: e.subject || '',
            sender: e.sender || '',
            snippet: e.snippet || '',
          }),
        ),
        connection: label,
      },
    };
    eventBus.emit('email.received', emailEvent);
  } catch (err) {
    logger.warn(
      { err: String(err), label },
      'Failed to process SSE triaged_emails event',
    );
  }
}

/**
 * The shape of a single incoming email as consumed by the intake-level
 * pipeline. Richer than the SSE payload (`SSEEmail`) — carries raw
 * headers, full body, and Gmail's category label so the sender/subtype
 * classifiers can do their best work.
 */
export interface IncomingEmailEvent {
  threadId: string;
  account: string;
  messageId?: string;
  subject?: string;
  from?: string;
  headers?: Record<string, string>;
  body?: string;
  gmailCategory?: string | null;
  snippet?: string;
  superpilotLabel?: string | null;
  groupName?: string;
}

export interface ProcessIncomingEmailOpts {
  db: Database.Database;
  gmailOps: Pick<GmailOps, 'archiveThread'>;
  event: IncomingEmailEvent;
}

export type ProcessIncomingEmailResult = {
  action: 'inserted' | 'muted_skip' | 'already_tracked';
};

/**
 * Testable intake seam for incoming emails. Applies the mute filter
 * first (muted threads archive and return without inserting), then —
 * for fresh threads — writes a `tracked_items` row populated with the
 * sender_kind + subtype heuristics so downstream rendering can
 * classification-aware group/display items.
 *
 * This is deliberately a thin, dependency-injected wrapper. The
 * production SSE hot path still flows through {@link classifyFromSSE}
 * in `sse-classifier.ts`, which applies the same mute check and
 * populates the same heuristic columns via the global DB handle.
 * `processIncomingEmail` exists so the mute-filter + classification
 * wiring can be unit-tested end-to-end without standing up the full
 * classifier pipeline or the global singleton DB.
 */
export async function processIncomingEmail(
  opts: ProcessIncomingEmailOpts,
): Promise<ProcessIncomingEmailResult> {
  const { db, gmailOps, event } = opts;

  // Mute check runs first — BEFORE any classification, DB write, or
  // event emission. Muted threads must produce zero side-effects
  // besides archive + log.
  if (event.threadId && isThreadMuted(db, event.threadId)) {
    logger.info(
      {
        thread_id: event.threadId,
        component: 'triage',
        event: 'muted_skip',
      },
      'Muted thread — skipping intake',
    );
    try {
      if (event.account) {
        await gmailOps.archiveThread(event.account, event.threadId);
      }
    } catch (err) {
      // Archive failure is non-fatal: the item is already skipped; we
      // just leave the thread in the inbox. Logging lets operators
      // catch persistent failures (e.g. revoked token).
      logger.error(
        { err, thread_id: event.threadId, component: 'triage' },
        'Muted thread archive failed — left in inbox',
      );
    }
    return { action: 'muted_skip' };
  }

  const sourceId = `gmail:${event.threadId}`;

  // Short-circuit if this thread is already tracked. Matches the
  // dedup behavior in classifyFromSSE so reconnect/replay storms
  // don't double-insert.
  const existing = db
    .prepare(`SELECT 1 FROM tracked_items WHERE source = ? AND source_id = ?`)
    .get('gmail', sourceId);
  if (existing) {
    return { action: 'already_tracked' };
  }

  const from = event.from ?? '';
  const subject = event.subject ?? '';
  const body = event.body ?? '';
  const senderKind = classifySender({
    from,
    headers: event.headers ?? {},
  });
  const subtype = classifySubtype({
    from,
    gmailCategory: event.gmailCategory ?? null,
    subject,
    body,
  });

  const now = Date.now();
  const itemId = `intake-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Direct INSERT against the passed DB handle so this seam is
  // independent of the global singleton used by `insertTrackedItem`.
  // Kept in sync with the main INSERT in tracked-items.ts.
  db.prepare(
    `INSERT OR IGNORE INTO tracked_items (
      id, source, source_id, group_name, state, classification,
      superpilot_label, trust_tier, title, summary, thread_id,
      detected_at, pushed_at, resolved_at, resolution_method,
      digest_count, telegram_message_id, classification_reason, metadata,
      confidence, model_tier, action_intent,
      facts_extracted_json, repo_candidates_json, reasons_json,
      reminded_at, sender_kind, subtype
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )`,
  ).run(
    itemId,
    'gmail',
    sourceId,
    event.groupName ?? 'main',
    'detected',
    null,
    event.superpilotLabel ?? null,
    null,
    subject || '(no subject)',
    null,
    event.threadId,
    now,
    null,
    null,
    null,
    0,
    null,
    null,
    JSON.stringify({ account: event.account, sender: from }),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    senderKind,
    subtype,
  );

  return { action: 'inserted' };
}
