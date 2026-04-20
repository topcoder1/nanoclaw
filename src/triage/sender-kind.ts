export type SenderKind = 'human' | 'bot' | 'unknown';
export type Subtype = 'transactional' | null;

export interface SenderInput {
  from: string;
  headers: Record<string, string>;
}

export interface SubtypeInput {
  from: string;
  gmailCategory: string | null;
  subject: string;
  body: string;
}

const BOT_LOCALPART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|bounce|bounces|notification[s]?|notify|info|support|alert[s]?|team|mailer[-_]daemon|postmaster|hello|news(?:letter)?)$/i;

const BOT_DOMAINS = [
  /(^|\.)mailchimp\.com$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)amazonses\.com$/i,
  /(^|\.)mailgun\.org$/i,
  /(^|\.)postmark(?:app)?\.com$/i,
  /(^|\.)klaviyo\.com$/i,
  /(^|\.)hubspotemail\.net$/i,
];

export function classifySender(input: SenderInput): SenderKind {
  const headers = normalizeHeaders(input.headers);
  if (headers['list-unsubscribe']) return 'bot';
  if (headers['list-id']) return 'bot';
  if ((headers.precedence || '').toLowerCase() === 'bulk') return 'bot';

  const email = (input.from || '').toLowerCase();
  const at = email.indexOf('@');
  if (at === -1) return 'unknown';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (BOT_LOCALPART.test(local)) return 'bot';
  for (const re of BOT_DOMAINS) if (re.test(domain)) return 'bot';

  return 'human';
}

const TRANSACTIONAL_DOMAINS = [
  /(^|\.)stripe\.com$/i,
  /(^|\.)square(?:up)?\.com$/i,
  /(^|\.)apple\.com$/i,
  /(^|\.)amazon\.com$/i,
  /(^|\.)shopify\.com$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)intuit\.com$/i,
  /(^|\.)chase\.com$/i,
];

const TRANSACTIONAL_KEYWORDS = [
  /verification code/i,
  /one[- ]?time code/i,
  /\b2fa\b/i,
  /your receipt/i,
  /order confirmation/i,
  /payment received/i,
  /\btransaction\b/i,
  /\binvoice\b/i,
];

export function classifySubtype(input: SubtypeInput): Subtype {
  let signals = 0;
  const cat = input.gmailCategory || '';
  if (cat === 'CATEGORY_UPDATES') signals += 1;
  // Deliberately NOT counting CATEGORY_PROMOTIONS here — promotions are
  // marketing, not transactional. Newsletters hit that category too.

  const email = (input.from || '').toLowerCase();
  const at = email.indexOf('@');
  const domain = at === -1 ? '' : email.slice(at + 1);
  for (const re of TRANSACTIONAL_DOMAINS) {
    if (re.test(domain)) {
      signals += 1;
      break;
    }
  }

  const haystack = `${input.subject || ''}\n${input.body || ''}`;
  for (const re of TRANSACTIONAL_KEYWORDS) {
    if (re.test(haystack)) {
      signals += 1;
      break;
    }
  }

  return signals >= 2 ? 'transactional' : null;
}

function normalizeHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw || {})) out[k.toLowerCase()] = raw[k];
  return out;
}
