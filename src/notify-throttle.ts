const lastSent = new Map<string, number>();

/**
 * Coalesce repeated identical alerts. Returns true and records the timestamp
 * the first time `key` is seen, or after `ttlMs` has elapsed since the last
 * accepted call. Returns false in between so the caller can drop the send.
 *
 * In-memory only — the map clears on process restart, which is fine for
 * rate-limiting transient error pings (a restart doesn't typically reproduce
 * the same flood pattern within seconds).
 */
export function shouldNotify(
  key: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < ttlMs) return false;
  lastSent.set(key, now);
  return true;
}

/** @internal — for tests. */
export function _resetNotifyThrottle(): void {
  lastSent.clear();
}
