/**
 * Vitest setup — pins env vars that tests implicitly depend on, so a
 * developer's `.env` (which is gitignored) doesn't make the test suite
 * green or red based on local config.
 *
 * Runs once per test process, before any test module imports. Keep it
 * tiny — anything more elaborate belongs in per-file `beforeEach` hooks.
 *
 * History: this file was added 2026-04-25 after a session-cleanup pass
 * exposed that ~50 brain-miniapp tests would silently fail whenever
 * TELEGRAM_INITDATA_REQUIRED=true was set in `.env`. The tests assumed
 * the middleware was off; the env var made the assumption false. Pinning
 * here makes the suite hermetic against `.env` drift.
 */

// Brain miniapp tests construct an Express app with createMiniAppServer()
// and supertest its /brain HTML routes. When TELEGRAM_INITDATA_REQUIRED
// is true, every request gets the bootstrap-HTML page or a 401 instead of
// the expected route output. Pin to "false" so the routes are reachable.
//
// Tests that specifically want to exercise the auth path (e.g.
// `createTelegramAuthMiddleware` cases in mini-app-telegram-auth.test.ts)
// build their own express() instance with the middleware mounted directly
// — they don't depend on this flag.
process.env.TELEGRAM_INITDATA_REQUIRED = 'false';
