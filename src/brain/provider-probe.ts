/**
 * Embedding-provider reachability probe (design §9).
 *
 * Periodically calls the embedding pipeline with a throwaway string and
 * — on success — stamps `system_state.provider_last_ok` with the current
 * ISO timestamp. The alert dispatcher reads that key and fires
 * `provider_unreachable` when it ages past the 15-minute threshold.
 *
 * We only touch system_state on SUCCESS. A failed probe is logged at warn
 * level but deliberately does NOT update provider_last_ok — staleness is
 * the signal the alert dispatcher is looking for.
 *
 * Cadence matches the design (every 5 min). The scheduler is registered
 * in src/index.ts alongside reconcile, backup, and the digest.
 */

import { logger } from '../logger.js';

import { embedText } from './embed.js';
import { getSystemState, setSystemState } from './metrics.js';

export const PROVIDER_LAST_OK_KEY = 'provider_last_ok';
export const DEFAULT_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Run one probe. Cheap embed on a 4-char string; success → stamp
 * provider_last_ok. Returns `true` on success, `false` on failure.
 */
export async function probeOnce(nowIso?: string): Promise<boolean> {
  try {
    await embedText('ping', 'query');
    const iso = nowIso ?? new Date().toISOString();
    setSystemState(PROVIDER_LAST_OK_KEY, iso, iso);
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'provider probe failed — provider_last_ok not updated',
    );
    return false;
  }
}

/** Epoch ms of the last successful probe, or null if never probed. */
export function getProviderLastOkMs(): number | null {
  const row = getSystemState(PROVIDER_LAST_OK_KEY);
  if (!row) return null;
  const ms = Date.parse(row.value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Start a simple probe schedule. Fires once immediately (unawaited) so the
 * first stamp lands fast at boot, then every `intervalMs`. Returns a stop
 * function that clears the timer.
 */
export function startProviderProbe(
  intervalMs: number = DEFAULT_PROBE_INTERVAL_MS,
): () => void {
  const run = (): void => {
    void probeOnce();
  };
  run();
  const handle = setInterval(run, intervalMs);
  return () => clearInterval(handle);
}
