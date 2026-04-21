/**
 * E-signature invite detector.
 *
 * Two-phase detection:
 *   1. `looksLikeSignInvite({from, subject})` — cheap sender/subject heuristic,
 *      suitable for list-render paths where we only have metadata, not body.
 *   2. `detectSignUrl({from, subject, body})` — extracts a specific signing URL
 *      from the body. Requires the full email body.
 *
 * Covers: DocuSign, Adobe Sign (Acrobat Sign / EchoSign), Dropbox Sign (HelloSign),
 * PandaDoc, SignNow. The Sign button is a deep link to the vendor — it never
 * auto-signs. Review + consent still happens on the vendor's page.
 */
export type SignVendor =
  | 'docusign'
  | 'adobe_sign'
  | 'dropbox_sign'
  | 'pandadoc'
  | 'signnow';

export interface SignDetection {
  vendor: SignVendor;
  signUrl: string;
}

interface VendorProfile {
  vendor: SignVendor;
  // Sender matches — either localpart@domain substring, or plain domain. Case-insensitive.
  senderPatterns: RegExp[];
  // URL patterns inside the body, ranked most-specific first.
  urlPatterns: RegExp[];
}

const VENDORS: VendorProfile[] = [
  {
    vendor: 'docusign',
    senderPatterns: [/\bdocusign\.(net|com)\b/i, /\bdse[_\w-]*@/i],
    urlPatterns: [
      /https?:\/\/[\w.-]*docusign\.net\/(?:Signing|Member|EmailStart)[^\s"'<>)]*/i,
      /https?:\/\/(?:app|account|secure)[\w.-]*\.docusign\.com\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*docusign\.(?:net|com)\/[^\s"'<>)]+/i,
    ],
  },
  {
    vendor: 'adobe_sign',
    senderPatterns: [
      /\badobesign\.com\b/i,
      /\bechosign\.com\b/i,
      /\b(?:echosign|adobesign)@/i,
    ],
    urlPatterns: [
      /https?:\/\/secure[\w.-]*\.adobesign\.com\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*adobesign\.com\/public\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*\.echosign\.com\/[^\s"'<>)]+/i,
      /https?:\/\/[\w.-]*adobesign\.com\/[^\s"'<>)]+/i,
    ],
  },
  {
    vendor: 'dropbox_sign',
    senderPatterns: [
      /\bhellosign\.com\b/i,
      /\bsign\.dropbox\.com\b/i,
      /\b(?:noreply|no-reply)@(?:mail\.)?hellosign\.com\b/i,
    ],
    urlPatterns: [
      /https?:\/\/app\.hellosign\.com\/editor\/[^\s"'<>)]*/i,
      /https?:\/\/app\.sign\.dropbox\.com\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*hellosign\.com\/[^\s"'<>)]+/i,
    ],
  },
  {
    vendor: 'pandadoc',
    senderPatterns: [/\bpandadoc\.com\b/i],
    urlPatterns: [
      /https?:\/\/app\.pandadoc\.com\/[^\s"'<>)]*/i,
      /https?:\/\/sign\.pandadoc\.com\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*pandadoc\.com\/[^\s"'<>)]+/i,
    ],
  },
  {
    vendor: 'signnow',
    senderPatterns: [/\bsignnow\.com\b/i],
    urlPatterns: [
      /https?:\/\/app\.signnow\.com\/document\/[^\s"'<>)]*/i,
      /https?:\/\/[\w.-]*signnow\.com\/[^\s"'<>)]+/i,
    ],
  },
];

const SUBJECT_HINT =
  /\b(?:please\s+(?:docu)?sign|signature\s+(?:requested|required)|invited\s+to\s+sign|sign\s+(?:this|the|electronic)|e[- ]?sign(?:ature)?|awaiting\s+your\s+signature|complete\s+with\s+docusign)\b/i;

function matchVendorBySender(from: string): VendorProfile | null {
  for (const v of VENDORS) {
    if (v.senderPatterns.some((re) => re.test(from))) return v;
  }
  return null;
}

/**
 * Cheap heuristic — returns the vendor (or null) using only sender + subject.
 * Use for list-render paths where body is unavailable.
 */
export function looksLikeSignInvite(input: {
  from: string;
  subject: string;
}): SignVendor | null {
  const byVendor = matchVendorBySender(input.from || '');
  if (byVendor) return byVendor.vendor;
  // Fallback: explicit signing language in the subject. Can't attribute a
  // vendor, but we still know it's a signing invite — caller can show the
  // button and lazy-resolve the URL.
  if (SUBJECT_HINT.test(input.subject || '')) return null;
  return null;
}

/**
 * Fuller check used by the row render — true when we either recognize the
 * vendor by sender OR the subject clearly indicates a signing invite.
 */
export function isSignInvite(input: {
  from: string;
  subject: string;
}): boolean {
  if (matchVendorBySender(input.from || '')) return true;
  return SUBJECT_HINT.test(input.subject || '');
}

/**
 * Full detection. Runs the sender match first to pick a vendor, then scans
 * the body for the first matching signing URL. Falls back to scanning all
 * vendors' URL patterns if the sender didn't match (handles forwarded or
 * white-labeled sends).
 */
export function detectSignUrl(input: {
  from: string;
  subject: string;
  body: string;
}): SignDetection | null {
  const body = input.body || '';
  if (!body) return null;

  const preferred = matchVendorBySender(input.from || '');
  const order = preferred
    ? [preferred, ...VENDORS.filter((v) => v !== preferred)]
    : VENDORS;

  for (const profile of order) {
    for (const re of profile.urlPatterns) {
      const m = body.match(re);
      if (m) {
        return { vendor: profile.vendor, signUrl: stripTrailingPunct(m[0]) };
      }
    }
  }
  return null;
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[).,;:!?>\]]+$/, '');
}
