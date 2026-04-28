/**
 * Per-(platform, chat_id) window state machine for chat → brain ingest.
 *
 * State is in-memory only. A process restart forfeits the current open
 * window for each chat (acceptable v1 — windows are short-lived). The
 * `flushAll('shutdown')` path is wired into stopBrainIngest so SIGTERM
 * still emits one event per open window before exit.
 */

import { eventBus } from '../event-bus.js';
import type { ChatWindowFlushedEvent } from '../events.js';
import { logger } from '../logger.js';
import {
  listChatMessages,
  type ChatMessageRow,
  registerChatMessageObserver,
} from '../chat-message-cache.js';

import {
  readChatIngestConfig,
  resolveGroupForChat,
} from './group-frontmatter.js';

// --- Defaults / env --------------------------------------------------------

const DEFAULT_IDLE_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_CAP = 50;
const DEFAULT_DAILY_FLUSH_HOUR = 23;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getIdleMs(): number {
  return envInt('WINDOW_IDLE_MS', DEFAULT_IDLE_MS);
}
export function getCap(): number {
  return envInt('WINDOW_CAP', DEFAULT_CAP);
}
export function getDailyFlushHour(): number {
  const h = envInt('WINDOW_DAILY_FLUSH_HOUR', DEFAULT_DAILY_FLUSH_HOUR);
  return h >= 0 && h < 24 ? h : DEFAULT_DAILY_FLUSH_HOUR;
}

// --- State -----------------------------------------------------------------

interface WindowState {
  platform: 'discord' | 'signal';
  chat_id: string;
  group_folder: string;
  group_jid: string;
  started_at: string; // ISO of first message
  last_at: string; // ISO of latest message
  message_ids: string[];
  excluded_message_ids: Set<string>;
  idle_ms: number;
  cap: number;
}

const windows = new Map<string, WindowState>();

function key(platform: string, chat_id: string): string {
  return `${platform}:${chat_id}`;
}

/**
 * Test helper — returns the live `WindowState` reference (not a copy) for
 * the given `(platform, chat_id)`, or `undefined` if no window is open.
 * Read-only by convention: callers must not mutate the returned object.
 */
export function _peekWindow(
  platform: 'discord' | 'signal',
  chat_id: string,
): WindowState | undefined {
  return windows.get(key(platform, chat_id));
}

/** Test helper — drop all windows. */
export function _resetWindowState(): void {
  windows.clear();
}

// --- noteMessage / noteSave -----------------------------------------------

/**
 * Called once per inbound chat message (registered as a chat-message-cache
 * observer). Opens a window if the chat is opted in; appends the id; flushes
 * on cap.
 */
export function noteMessage(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
  sent_at: string,
): void {
  const resolved = resolveGroupForChat(platform, chat_id);
  if (!resolved) return;
  const cfg = readChatIngestConfig(resolved.folder);
  if (cfg.brain_ingest !== 'window') return;

  const k = key(platform, chat_id);
  let w = windows.get(k);
  if (!w) {
    const idleMs =
      (cfg.window_idle_min ?? 0) > 0
        ? (cfg.window_idle_min as number) * 60_000
        : getIdleMs();
    const cap =
      (cfg.window_cap ?? 0) > 0 ? (cfg.window_cap as number) : getCap();
    w = {
      platform,
      chat_id,
      group_folder: resolved.folder,
      group_jid: resolved.jid,
      started_at: sent_at,
      last_at: sent_at,
      message_ids: [],
      excluded_message_ids: new Set(),
      idle_ms: idleMs,
      cap,
    };
    windows.set(k, w);
  }
  if (!w.message_ids.includes(message_id)) {
    w.message_ids.push(message_id);
  }
  w.last_at = sent_at;
  if (w.message_ids.length >= w.cap) {
    flushOne(w, 'cap');
  }
}

/**
 * Called when a single-message save fires inside an open window. Records the
 * id in the per-window excluded set so the flushed transcript skips it (avoids
 * double-ingest while preserving both signals).
 */
export function noteSave(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): void {
  const w = windows.get(key(platform, chat_id));
  if (!w) return;
  w.excluded_message_ids.add(message_id);
}

// --- Flushing --------------------------------------------------------------

/**
 * Emit a ChatWindowFlushedEvent for the given window and remove it from state.
 * Builds the transcript from cache, omitting excluded ids. Skips emission if
 * no non-excluded messages remain.
 */
function flushOne(
  w: WindowState,
  reason: ChatWindowFlushedEvent['flush_reason'],
): void {
  windows.delete(key(w.platform, w.chat_id));
  const includedIds = w.message_ids.filter(
    (id) => !w.excluded_message_ids.has(id),
  );
  if (includedIds.length === 0) {
    logger.info(
      { platform: w.platform, chat_id: w.chat_id, reason },
      'window-flusher: skip emit — all messages excluded',
    );
    return;
  }
  const allRows = listChatMessages(w.platform, w.chat_id, {
    limit: 500,
    sinceIso: w.started_at,
  });
  const byId = new Map(allRows.map((r) => [r.message_id, r]));
  const rows = includedIds
    .map((id) => byId.get(id))
    .filter((r): r is ChatMessageRow => Boolean(r))
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  if (rows.length === 0) {
    logger.warn(
      { platform: w.platform, chat_id: w.chat_id, reason },
      'window-flusher: skip emit — no cached rows for window ids (cache evicted?)',
    );
    return;
  }

  const transcript = rows
    .map((r) =>
      `[${r.sent_at}] ${r.sender_name ?? r.sender}: ${r.text ?? ''}`.trim(),
    )
    .join('\n');
  const participantSet = new Set<string>();
  for (const r of rows) participantSet.add(r.sender_name ?? r.sender);
  const participants = [...participantSet];

  const evt: ChatWindowFlushedEvent = {
    type: 'chat.window.flushed',
    source: w.platform,
    timestamp: Date.now(),
    platform: w.platform,
    chat_id: w.chat_id,
    window_started_at: w.started_at,
    window_ended_at: w.last_at,
    message_count: rows.length,
    transcript,
    message_ids: rows.map((r) => r.message_id),
    participants,
    flush_reason: reason,
    group_folder: w.group_folder,
    payload: {},
  };
  eventBus.emit('chat.window.flushed', evt);
}

/**
 * Walk every open window; emit on those whose last_at is older than idle_ms.
 * `now` is injectable for tests.
 */
export function flushIdle(now: number = Date.now()): void {
  for (const w of [...windows.values()]) {
    const lastMs = Date.parse(w.last_at);
    if (Number.isFinite(lastMs) && now - lastMs >= w.idle_ms) {
      flushOne(w, 'idle');
    }
  }
}

/** Flush every open window with the given reason. Used for daily/shutdown. */
export function flushAll(reason: ChatWindowFlushedEvent['flush_reason']): void {
  for (const w of [...windows.values()]) {
    flushOne(w, reason);
  }
}

// --- Lifecycle (timer + observer) wired in Task 5/6 ------------------------

let observerRegistered = false;

export function _registerObserver(): void {
  if (observerRegistered) return;
  registerChatMessageObserver((msg) => {
    if (msg.platform !== 'discord' && msg.platform !== 'signal') return;
    noteMessage(msg.platform, msg.chat_id, msg.message_id, msg.sent_at);
  });
  observerRegistered = true;
}

export function _unregisterObserver(): void {
  if (!observerRegistered) return;
  registerChatMessageObserver(null);
  observerRegistered = false;
}

// --- Daily flush + ticker --------------------------------------------------

let lastDailyFlushDay: string | null = null;

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Test/internal: run one daily-flush check at the given wall-clock instant. */
export function _runDailyCheck(now: number = Date.now()): void {
  const hour = new Date(now).getHours();
  if (hour < getDailyFlushHour()) return;
  const day = localDayKey(now);
  if (lastDailyFlushDay === day) return;
  lastDailyFlushDay = day;
  flushAll('daily');
}

let timer: NodeJS.Timeout | null = null;

export interface WindowFlusherOptions {
  /** Override the per-tick interval. Default: 60_000 (one minute). */
  tickIntervalMs?: number;
}

/**
 * Start the per-minute ticker and register the chat-message observer. Safe
 * to call multiple times — second call is a no-op.
 */
export function startWindowFlusher(opts: WindowFlusherOptions = {}): void {
  if (timer) return;
  _registerObserver();
  const interval = opts.tickIntervalMs ?? 60_000;
  timer = setInterval(() => {
    try {
      flushIdle();
      _runDailyCheck();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'window-flusher: tick failed',
      );
    }
  }, interval);
  // Don't keep the event loop alive on its own — tests and graceful
  // shutdown should not hang on this timer.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(
    { idle_ms: getIdleMs(), cap: getCap(), daily_hour: getDailyFlushHour() },
    'Window flusher started',
  );
}

/**
 * Stop the ticker and emit `flush_reason='shutdown'` for every still-open
 * window. Wired into stopBrainIngest in Task 6.
 */
export function stopWindowFlusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  _unregisterObserver();
  flushAll('shutdown');
  lastDailyFlushDay = null;
}
