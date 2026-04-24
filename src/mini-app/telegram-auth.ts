/**
 * Telegram WebApp `initData` HMAC-SHA256 validator + Express middleware.
 *
 * Telegram signs every WebApp open with an HMAC over the query-string-like
 * `initData` payload using a secret derived from the bot token. We verify
 * it per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
 *
 *   secret_key        = HMAC_SHA256(key="WebAppData",           msg=bot_token)
 *   data_check_string = sort(k=v pairs excluding "hash")
 *                         joined with "\n"
 *   expected_hash     = HMAC_SHA256(key=secret_key, msg=data_check_string).hex()
 *   verify            = timingSafeEqual(expected_hash, received_hash)
 *
 * Replay protection: reject payloads whose `auth_date` is older than
 * `maxAgeSec` (default 1h).
 *
 * The middleware is opt-in via `TELEGRAM_INITDATA_REQUIRED=true`. When
 * off, routes keep their current trust model (Cloudflare Access in prod).
 */

import crypto from 'crypto';
import type express from 'express';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  [k: string]: unknown;
}

export interface VerifyOk {
  ok: true;
  user: TelegramUser | null;
  authDateMs: number;
}

export interface VerifyErr {
  ok: false;
  error:
    | 'missing_initdata'
    | 'missing_hash'
    | 'missing_auth_date'
    | 'bad_hash'
    | 'expired'
    | 'bad_token';
}

export type VerifyResult = VerifyOk | VerifyErr;

export const DEFAULT_INITDATA_MAX_AGE_SEC = 3600;

/**
 * Verify a raw `initData` string against the supplied bot token.
 * Pure function — no side effects. Used directly by the middleware
 * and by tests.
 */
export function verifyInitData(
  raw: string | undefined | null,
  botToken: string,
  maxAgeSec = DEFAULT_INITDATA_MAX_AGE_SEC,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!botToken) return { ok: false, error: 'bad_token' };
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'missing_initdata' };
  }

  // URLSearchParams preserves the order Telegram supplied, including the
  // `hash` key we need to split off before hashing.
  const params = new URLSearchParams(raw);
  const received = params.get('hash');
  if (!received) return { ok: false, error: 'missing_hash' };
  const authDateStr = params.get('auth_date');
  if (!authDateStr) return { ok: false, error: 'missing_auth_date' };
  const authDateSec = Number.parseInt(authDateStr, 10);
  if (!Number.isFinite(authDateSec)) {
    return { ok: false, error: 'missing_auth_date' };
  }
  const authDateMs = authDateSec * 1000;
  if (nowMs - authDateMs > maxAgeSec * 1000) {
    return { ok: false, error: 'expired' };
  }

  // Build data_check_string: every k=v pair except `hash`, joined by \n,
  // sorted alphabetically by key.
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Constant-time compare. timingSafeEqual throws when lengths differ,
  // so we normalise via Buffer and check length up front.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad_hash' };
  }

  // Parse the user blob if present. Telegram sends it as a JSON-encoded
  // string in the `user` param. Malformed JSON → user=null but still ok.
  let user: TelegramUser | null = null;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      user = null;
    }
  }

  return { ok: true, user, authDateMs };
}

export interface TelegramAuthOptions {
  /** Bot token resolver — function so tests can override without env. */
  getBotToken: () => string;
  /** Replay window in seconds. Defaults to 1h. */
  maxAgeSec?: number;
  /** Clock override for tests. */
  nowFn?: () => number;
}

// Express request augmentation — kept scoped to this middleware so it
// doesn't leak onto every request type project-wide.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      telegramUser?: TelegramUser | null;
    }
  }
}

/**
 * Minimal HTML page that reads `Telegram.WebApp.initData` from the URL
 * fragment (the only place Telegram delivers it) and reloads the current
 * URL with `?tgWebAppData=...` appended so the next request carries the
 * payload as a query param — which the server can actually see, unlike
 * fragments which browsers never send.
 *
 * Served on unauthenticated HTML GETs so the middleware can bootstrap
 * auth on the very first page load. The reload is one-shot: if initData
 * is already in the query string we skip the rewrite to avoid loops.
 */
const BOOTSTRAP_HTML = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brain · authorizing…</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font:14px -apple-system,system-ui,sans-serif;background:#f4f6f8;color:#666;padding:40px;text-align:center}</style>
</head><body>
Authorizing…
<script>
(function(){
  try {
    var tg = window.Telegram && window.Telegram.WebApp;
    var existing = new URLSearchParams(location.search).get('tgWebAppData');
    if (existing) return; // already have it and still 401 → don't loop
    var initData = tg && tg.initData;
    if (!initData) {
      document.body.innerText = 'Not in Telegram. Open this page from the Mini App.';
      return;
    }
    var sep = location.search ? '&' : '?';
    var next = location.pathname + location.search + sep +
               'tgWebAppData=' + encodeURIComponent(initData) +
               location.hash;
    location.replace(next);
  } catch(e) {
    document.body.innerText = 'Auth bootstrap error: ' + String(e);
  }
})();
</script>
</body></html>`;

/**
 * Express middleware that rejects requests lacking a valid Telegram
 * `initData` payload. Reads from either the `x-telegram-init-data` header
 * or the `tgWebAppData` query param.
 *
 * Telegram delivers initData in the URL **fragment** (`#tgWebAppData=…`),
 * which browsers never send to the server. So the first GET of an HTML
 * page has no initData. We serve a tiny bootstrap HTML that reads the
 * fragment client-side and redirects to the same URL with the initData
 * appended as a query param — from then on the middleware sees it and
 * lets the user through.
 *
 * JSON API endpoints (`/api/*`) always 401 on failure — the browser JS
 * wrapper in `brain-layout.ts` attaches the header on every fetch.
 *
 * On success, attaches `req.telegramUser`.
 */
export function createTelegramAuthMiddleware(
  opts: TelegramAuthOptions,
): express.RequestHandler {
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_INITDATA_MAX_AGE_SEC;
  const nowFn = opts.nowFn ?? (() => Date.now());
  return (req, res, next) => {
    const headerVal = req.header('x-telegram-init-data');
    const queryVal =
      typeof req.query.tgWebAppData === 'string'
        ? (req.query.tgWebAppData as string)
        : undefined;
    const raw = headerVal ?? queryVal;
    const result = verifyInitData(raw, opts.getBotToken(), maxAgeSec, nowFn());
    if (!result.ok) {
      // GET HTML pages get the fragment-reading bootstrap ONLY when the
      // client hasn't already supplied initData (i.e. truly first navigation
      // from Telegram). If initData WAS supplied but failed verification
      // (tampered, expired, wrong token) we 401 — the bootstrap redirecting
      // back into a failing payload would infinite-loop.
      const hasAttemptedAuth = raw !== undefined && raw !== '';
      const isHtmlNav =
        req.method === 'GET' &&
        !req.path.startsWith('/api/') &&
        (req.accepts(['html', 'json']) === 'html' ||
          // Some Telegram WebView builds omit Accept — default to HTML
          // if the Sec-Fetch-Dest header hints at document navigation.
          req.header('sec-fetch-dest') === 'document' ||
          !req.header('accept'));
      if (isHtmlNav && !hasAttemptedAuth) {
        res.status(200).type('html').send(BOOTSTRAP_HTML);
        return;
      }
      res.status(401).json({ error: result.error });
      return;
    }
    req.telegramUser = result.user;
    next();
  };
}
