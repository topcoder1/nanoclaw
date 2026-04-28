/**
 * Production Google Drive fetcher used by the brain ingest pipeline.
 *
 * Reads OAuth credentials from `~/.config/google-drive-mcp/`, which is
 * the credential layout established by the gdrive-* MCP servers (one
 * `<alias>-token.json` per Google account, sharing one
 * `oauth-credentials.json`). Brain consumes those tokens directly so
 * the running nanoclaw process can pull Drive content without touching
 * the MCP layer at runtime.
 *
 * Account routing: the email's `account` field (e.g. `whoisxml`,
 * `attaxion`, `personal`, `dev`) maps 1:1 to the matching token file.
 * If a Drive link came in via an account whose token doesn't have
 * access, the fetch returns null — callers log warn and skip.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from './logger.js';

import type {
  BrainDriveFetcher,
  DriveDocContent,
  DriveDocKind,
  DriveLink,
} from './brain/drive-resolver.js';

const CRED_DIR = path.join(os.homedir(), '.config', 'google-drive-mcp');

// Per-account OAuth client cache. Built lazily on first fetch and
// reused — google-auth-library handles token refresh internally and
// emits a 'tokens' event we use to persist refreshed tokens.
const clientCache = new Map<string, OAuth2Client>();

interface InstalledOAuthCreds {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: { client_id: string; client_secret: string; redirect_uris?: string[] };
}

function loadOauthClient(account: string): OAuth2Client | null {
  const cached = clientCache.get(account);
  if (cached) return cached;

  const credsPath = path.join(CRED_DIR, 'oauth-credentials.json');
  const tokenPath = path.join(CRED_DIR, `${account}-token.json`);
  if (!fs.existsSync(credsPath) || !fs.existsSync(tokenPath)) {
    logger.debug(
      { account, credsPath, tokenPath },
      'drive-fetcher: missing creds for account — skipping',
    );
    return null;
  }

  let creds: InstalledOAuthCreds;
  let token: Record<string, unknown>;
  try {
    creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (err) {
    logger.warn(
      { account, err: err instanceof Error ? err.message : String(err) },
      'drive-fetcher: failed to parse credentials JSON',
    );
    return null;
  }

  const installed = creds.installed ?? creds.web;
  if (!installed?.client_id || !installed?.client_secret) {
    logger.warn({ account }, 'drive-fetcher: malformed oauth credentials');
    return null;
  }

  const client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0],
  );
  client.setCredentials(token);
  client.on('tokens', (next) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      Object.assign(current, next);
      fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2));
    } catch (err) {
      logger.warn(
        { account, err: err instanceof Error ? err.message : String(err) },
        'drive-fetcher: failed to persist refreshed token',
      );
    }
  });
  clientCache.set(account, client);
  return client;
}

const EXPORT_MIME: Record<DriveDocKind, string | null> = {
  document: 'text/plain',
  presentation: 'text/plain',
  spreadsheet: 'text/csv',
  // Generic Drive files (PDFs, images, plain text) — not exportable;
  // use files.get(alt='media') instead.
  file: null,
};

async function exportText(
  drive: drive_v3.Drive,
  link: DriveLink,
): Promise<string> {
  const mime = EXPORT_MIME[link.kind];
  if (mime) {
    const res = await drive.files.export(
      { fileId: link.fileId, mimeType: mime },
      { responseType: 'text' },
    );
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }
  // Generic file — only attempt if the file's own mimeType is text-like.
  // Avoid blindly downloading binary blobs; they'd just fill brain.db
  // with garbage. A future enhancement could OCR PDFs, but v1 stays
  // conservative.
  const meta = await drive.files.get({
    fileId: link.fileId,
    fields: 'mimeType',
  });
  const ftype = meta.data.mimeType ?? '';
  if (!ftype.startsWith('text/')) return '';
  const res = await drive.files.get(
    { fileId: link.fileId, alt: 'media' },
    { responseType: 'text' },
  );
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}

/**
 * Map an email's `account` field — which can be either an alias
 * ('whoisxml', 'attaxion', 'personal', 'dev') or a raw address
 * ('topcoder1@gmail.com', 'jonathan.zhang@whoisxmlapi.com', etc.) —
 * onto the credential file alias used by ~/.config/google-drive-mcp.
 */
function aliasFromAccount(rawAccount: string): string {
  if (!rawAccount) return 'personal';
  if (KNOWN_ALIASES.has(rawAccount)) return rawAccount;
  const lower = rawAccount.toLowerCase();
  if (lower.includes('@')) {
    const local = lower.split('@')[0];
    const domain = lower.split('@')[1] ?? '';
    if (domain === 'gmail.com') return 'personal';
    if (domain === 'whoisxmlapi.com') {
      // dev@whoisxmlapi.com is a separate token; everything else is whoisxml.
      return local === 'dev' ? 'dev' : 'whoisxml';
    }
    if (domain === 'attaxion.com') return 'attaxion';
  }
  return 'personal';
}

const KNOWN_ALIASES = new Set(['personal', 'whoisxml', 'attaxion', 'dev']);

/**
 * Order of accounts to attempt for a given primary alias. The primary
 * alias goes first; the rest are fallbacks for cases where a doc is
 * shared with a different account than the email landed in (e.g. a
 * vendor invite arrives at the work address but the doc was shared
 * with the personal address).
 */
function fallbackOrder(primary: string): string[] {
  const all = ['personal', 'whoisxml', 'attaxion', 'dev'];
  return [primary, ...all.filter((a) => a !== primary)];
}

async function tryFetch(
  alias: string,
  link: DriveLink,
): Promise<DriveDocContent | null> {
  const client = loadOauthClient(alias);
  if (!client) return null;
  const drive = google.drive({ version: 'v3', auth: client });

  let title = '';
  try {
    const meta = await drive.files.get({
      fileId: link.fileId,
      fields: 'name',
    });
    title = meta.data.name ?? '';
  } catch (err) {
    // Permission denied or 404 — try next account.
    logger.debug(
      {
        alias,
        fileId: link.fileId,
        err: err instanceof Error ? err.message : String(err),
      },
      'drive-fetcher: metadata fetch failed for alias',
    );
    return null;
  }

  let text = '';
  try {
    text = await exportText(drive, link);
  } catch (err) {
    logger.warn(
      {
        alias,
        fileId: link.fileId,
        kind: link.kind,
        err: err instanceof Error ? err.message : String(err),
      },
      'drive-fetcher: export failed',
    );
    return null;
  }

  return { title, text };
}

export const productionDriveFetcher: BrainDriveFetcher = async (
  rawAccount,
  link,
) => {
  const primary = aliasFromAccount(rawAccount);
  for (const alias of fallbackOrder(primary)) {
    const result = await tryFetch(alias, link);
    if (result && result.text && result.text.trim().length > 0) {
      if (alias !== primary) {
        logger.info(
          {
            primary,
            alias,
            fileId: link.fileId,
            kind: link.kind,
          },
          'drive-fetcher: served via fallback account',
        );
      }
      return result;
    }
  }
  return null;
};
