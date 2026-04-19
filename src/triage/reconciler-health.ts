import { sendTelegramMessage } from '../channels/telegram.js';
import { readEnvValue } from '../env.js';
import { logger } from '../logger.js';
import { getReconcilerStatus } from './gmail-reconciler.js';

/**
 * Watches the Gmail reconciler for staleness and posts a Telegram alert
 * when it has not ticked within `staleThresholdMs`. Runs in-process so a
 * fully wedged nanoclaw is caught by launchd (which restarts us), while
 * a silently stuck reconciler gets surfaced here.
 *
 * Dedupe strategy: once we alert, suppress further alerts until we see
 * a fresh tick. This prevents N alerts every minute during a prolonged
 * outage — one alert on transition → stuck, one "recovered" message on
 * transition → healthy.
 */

export const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
export const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

export interface ReconcilerHealthDeps {
  intervalMs?: number;
  staleThresholdMs?: number;
  getChatId?: () => string | undefined;
  send?: (chatId: string, text: string) => Promise<unknown>;
  now?: () => number;
}

export interface ReconcilerHealthState {
  alerted: boolean;
  lastAlertAt: number | null;
}

export function startReconcilerHealthWatcher(
  deps: ReconcilerHealthDeps = {},
): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const threshold = deps.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const getChatId =
    deps.getChatId ?? (() => readEnvValue('EMAIL_INTEL_TG_CHAT_ID'));
  const send = deps.send ?? sendTelegramMessage;
  const now = deps.now ?? Date.now;

  const state: ReconcilerHealthState = { alerted: false, lastAlertAt: null };

  const tick = async () => {
    const chatId = getChatId();
    if (!chatId) return;
    const s = getReconcilerStatus();
    // Never ticked yet — not stale, just warming up.
    if (s.lastTickAt === null) return;

    const ageMs = now() - s.lastTickAt;
    const stale = ageMs >= threshold;

    if (stale && !state.alerted) {
      state.alerted = true;
      state.lastAlertAt = now();
      const ageMin = Math.round(ageMs / 60000);
      try {
        await send(
          chatId,
          `⚠️ Gmail reconciler stale — last tick ${ageMin} min ago (threshold ${Math.round(threshold / 60000)} min).`,
        );
        logger.warn(
          { ageMs, threshold },
          'Reconciler health: stale alert dispatched',
        );
      } catch (err) {
        logger.error(
          { err: String(err) },
          'Reconciler health: alert send failed',
        );
      }
      return;
    }

    if (!stale && state.alerted) {
      state.alerted = false;
      try {
        await send(chatId, `✅ Gmail reconciler recovered — ticking again.`);
        logger.info('Reconciler health: recovery alert dispatched');
      } catch (err) {
        logger.error(
          { err: String(err) },
          'Reconciler health: recovery alert send failed',
        );
      }
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
