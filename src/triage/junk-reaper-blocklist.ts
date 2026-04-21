import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';

export const BLOCKLIST_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'junk-reaper-blocklist.json',
);

/**
 * Domain patterns whose senders should be archived but NEVER auto-unsubscribed.
 * Transactional / account-security / own-org senders go here: they legitimately
 * carry List-Unsubscribe headers for mass emails but the unsub endpoint may
 * opt the user out of important notices (receipts, security alerts, invoices).
 */
export const DEFAULT_BLOCKLIST: string[] = [
  // GitHub (security, PATs, notifications)
  '*@github.com',
  '*@noreply.github.com',
  // U.S. Bank / mortgage
  '*@usbank.com',
  '*@notifications.usbank.com',
  // Intuit / QuickBooks / TurboTax invoices
  '*@intuit.com',
  '*@notification.intuit.com',
  // Stripe receipts
  '*@stripe.com',
  '*@notifications.stripe.com',
  // Other major banks
  '*@chase.com',
  '*@wellsfargo.com',
  '*@bankofamerica.com',
  // Apple (ID, receipts)
  '*@appleid.apple.com',
  '*@apple.com',
  // PayPal
  '*@paypal.com',
  '*@service.paypal.com',
  // Google (account / security). Safer to block whole domain.
  '*@google.com',
  '*@accounts.google.com',
  // User's own orgs
  '*@attaxion.com',
  '*@whoisxmlapi.com',
  '*@inboxsuperpilot.com',
  // E-signature
  '*@docusign.net',
  '*@adobesign.com',
  // Amazon orders / security
  '*@amazon.com',
  '*@amazon.*',
  // LinkedIn (security + connection notices)
  '*@linkedin.com',
];

const EMAIL_BRACKET_RE = /<([^>]+)>/;
const EMAIL_RAW_RE = /([^\s<>,;"']+@[^\s<>,;"']+)/;

/**
 * Extracts the email address from an RFC 5322 From header. Returns null if
 * the header is missing or unparseable.
 */
function parseEmail(fromHeader: string | undefined | null): string | null {
  if (!fromHeader) return null;
  const bracket = fromHeader.match(EMAIL_BRACKET_RE);
  if (bracket) {
    const candidate = bracket[1].trim();
    if (candidate.includes('@')) return candidate.toLowerCase();
  }
  const raw = fromHeader.match(EMAIL_RAW_RE);
  if (raw) return raw[1].trim().toLowerCase();
  return null;
}

/**
 * Compiles a pattern like `*@domain.com` or `*@*.domain.com` into a regex
 * anchored to the entire email. Patterns without `*` are treated as literal.
 */
function compilePattern(pattern: string): RegExp {
  const lowered = pattern.toLowerCase().trim();
  // Escape regex metachars except `*`, then replace `*` with `[^@.]*` for the
  // local part wildcard and `[^@]*` for domain-label wildcards. Simpler: treat
  // every `*` as "any run of chars except @ or .". This matches `*@domain.com`
  // against `foo@domain.com` and `*@*.domain.com` against `foo@bar.domain.com`
  // but NOT against `foo@domain.com` (no subdomain) and NOT against
  // `foo@evil-domain.com` (no dot boundary).
  let re = '';
  for (const ch of lowered) {
    if (ch === '*') re += '[^@.]*';
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}

/**
 * Returns true if the From header matches any blocklist pattern.
 *
 * why: unparseable From returns TRUE — if we can't tell who sent it, don't
 * risk hitting an unsub endpoint that could silence a transactional sender.
 */
export function isBlocklisted(
  fromHeader: string | undefined | null,
  patterns: string[],
): boolean {
  const email = parseEmail(fromHeader);
  if (!email) return true;
  for (const p of patterns) {
    if (compilePattern(p).test(email)) return true;
  }
  return false;
}

/**
 * Loads the blocklist. User file is merged ADDITIVELY onto defaults (user
 * cannot remove default protections). Missing file → defaults. Malformed
 * file → warn + defaults.
 */
export function loadBlocklist(configPath: string = BLOCKLIST_PATH): string[] {
  let userPatterns: string[] = [];
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        userPatterns = parsed;
      } else {
        logger.warn(
          { path: configPath },
          'Junk reaper blocklist: malformed (not a string array), using defaults',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { path: configPath, err },
      'Junk reaper blocklist: read/parse failed, using defaults',
    );
  }
  const merged = new Set<string>([...DEFAULT_BLOCKLIST, ...userPatterns]);
  return Array.from(merged);
}
