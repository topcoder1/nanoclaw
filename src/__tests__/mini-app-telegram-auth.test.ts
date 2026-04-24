/**
 * Telegram WebApp initData HMAC validator + middleware tests.
 *
 * The algorithm is pinned by Telegram docs:
 *   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   expected   = HMAC_SHA256(key=secret_key, msg=sorted-k=v-joined-by-\n)
 *
 * We compute a known-good hash from a synthetic bot token + payload and
 * assert verifyInitData accepts it. Negative paths tamper with each field
 * separately to confirm each branch is reached.
 */

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';

import {
  verifyInitData,
  createTelegramAuthMiddleware,
} from '../mini-app/telegram-auth.js';

const BOT_TOKEN = '1234567890:TEST-TOKEN-AABBCCDDEEFF';

/**
 * Build a valid initData string using the documented Telegram algorithm.
 * `overrides` lets tests tamper with individual fields AFTER the hash was
 * computed (for negative paths).
 */
function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Serialise to query-string form (what Telegram sends). URLSearchParams
  // URL-encodes values — the verifier reads them back with the same API,
  // so the round-trip works.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

describe('verifyInitData', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const baseFields = {
    auth_date: String(nowSec),
    query_id: 'AAH-abc123',
    user: JSON.stringify({
      id: 424242,
      first_name: 'Test',
      username: 'tester',
    }),
  };

  it('accepts a freshly signed payload', () => {
    const raw = signInitData(baseFields);
    const r = verifyInitData(raw, BOT_TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user?.id).toBe(424242);
      expect(r.user?.first_name).toBe('Test');
    }
  });

  it('rejects a tampered hash (one byte flipped)', () => {
    const raw = signInitData(baseFields);
    const params = new URLSearchParams(raw);
    const h = params.get('hash')!;
    // Flip one hex nibble.
    const flipped = h.slice(0, -1) + (h[h.length - 1] === '0' ? '1' : '0');
    params.set('hash', flipped);
    const r = verifyInitData(params.toString(), BOT_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bad_hash');
  });

  it('rejects tampered data (field modified after signing)', () => {
    const raw = signInitData(baseFields);
    const params = new URLSearchParams(raw);
    params.set('query_id', 'ATTACKER-REPLACED');
    const r = verifyInitData(params.toString(), BOT_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bad_hash');
  });

  it('rejects an expired auth_date', () => {
    const oldSec = nowSec - 2 * 3600; // 2h ago
    const raw = signInitData({ ...baseFields, auth_date: String(oldSec) });
    const r = verifyInitData(raw, BOT_TOKEN, 3600);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('expired');
  });

  it('rejects a payload missing the hash param', () => {
    // Build params without the hash field entirely.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(baseFields)) params.set(k, v);
    const r = verifyInitData(params.toString(), BOT_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_hash');
  });

  it('rejects a payload missing auth_date', () => {
    // Construct + sign a payload that omits auth_date, then feed it to the
    // verifier. Signing is still valid so the failure is specifically
    // 'missing_auth_date', not 'bad_hash'.
    const fields = { query_id: 'AAH-abc' };
    const raw = signInitData(fields);
    const r = verifyInitData(raw, BOT_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_auth_date');
  });

  it('rejects an empty bot token', () => {
    const raw = signInitData(baseFields);
    const r = verifyInitData(raw, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bad_token');
  });
});

describe('createTelegramAuthMiddleware', () => {
  function buildApp(token = BOT_TOKEN): express.Express {
    const app = express();
    app.use(
      createTelegramAuthMiddleware({ getBotToken: () => token }),
    );
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('401 when no initData provided', async () => {
    const res = await request(buildApp()).get('/ok');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_initdata');
  });

  it('401 when hash tampered', async () => {
    const raw = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 1 }),
    });
    const params = new URLSearchParams(raw);
    const h = params.get('hash')!;
    params.set('hash', h.slice(0, -1) + (h[h.length - 1] === '0' ? '1' : '0'));

    const res = await request(buildApp())
      .get('/ok')
      .set('x-telegram-init-data', params.toString());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('bad_hash');
  });

  it('passes through with valid header initData', async () => {
    const raw = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 777 }),
    });
    const res = await request(buildApp())
      .get('/ok')
      .set('x-telegram-init-data', raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes through with valid tgWebAppData query param', async () => {
    const raw = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 777 }),
    });
    const res = await request(buildApp())
      .get('/ok')
      .query({ tgWebAppData: raw });
    expect(res.status).toBe(200);
  });
});

describe('TELEGRAM_INITDATA_REQUIRED wiring', () => {
  // Covers the server-level choice: when the env flag is OFF (default),
  // brain routes must be reachable without any initData. The positive path
  // (middleware enforcement) is already covered by the middleware tests
  // above; wiring it into server.ts conditionally is a boolean we verify
  // by assertion here.
  it('off by default — brain route reachable without initData', async () => {
    // Load the module fresh with the env var unset. createMiniAppServer
    // reads TELEGRAM_INITDATA_REQUIRED at module-load time via src/config.ts,
    // so this test simply asserts the default path is permissive. A more
    // integrated test would spawn a separate worker — out of scope here.
    const { TELEGRAM_INITDATA_REQUIRED } = await import('../config.js');
    expect(TELEGRAM_INITDATA_REQUIRED).toBe(false);
  });
});
