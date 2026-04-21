import type { EmailMeta } from './gmail-ops.js';

/**
 * In-memory cache for fetched email bodies and metadata.
 * Key: emailId, Value: { body, meta?, fetchedAt }
 */
interface CacheEntry {
  body: string;
  meta?: EmailMeta;
  fetchedAt: number;
}

const emailCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Truncate email body for inline preview.
 * Breaks at word boundary, appends truncation marker.
 */
export function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let cutoff = text.lastIndexOf(' ', maxChars);
  if (cutoff === -1) cutoff = maxChars;

  return text.slice(0, cutoff).trimEnd() + '— truncated —';
}

/**
 * Prepare a preview for inline channel rendering. Strips HTML tags and
 * decodes common entities so transactional HTML-only emails don't blow
 * up Telegram's HTML parse_mode (which only allows b/i/u/s/code/pre/a).
 */
export function plaintextPreview(body: string, maxChars: number): string {
  const stripped = body
    // Remove script/style blocks including contents.
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    // Convert <br> and </p> to newlines before stripping all tags.
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    // Decode a small set of common entities — good enough for previews.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncatePreview(stripped, maxChars);
}

/**
 * Get email body from cache, or return null if not cached / expired.
 */
export function getCachedEmailBody(emailId: string): string | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.body;
}

/**
 * Store email body in cache.
 */
export function cacheEmailBody(emailId: string, body: string): void {
  emailCache.set(emailId, { body, fetchedAt: Date.now() });
}

/**
 * Clear expired entries from cache.
 */
export function cleanupCache(): void {
  const now = Date.now();
  for (const [id, entry] of emailCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS) {
      emailCache.delete(id);
    }
  }
}

/**
 * Store full email metadata in cache (body is extracted from meta).
 */
export function cacheEmailMeta(emailId: string, meta: EmailMeta): void {
  emailCache.set(emailId, { body: meta.body, meta, fetchedAt: Date.now() });
}

/**
 * Get full email metadata from cache, or return null if not cached / expired.
 */
export function getCachedEmailMeta(emailId: string): EmailMeta | null {
  const entry = emailCache.get(emailId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    emailCache.delete(emailId);
    return null;
  }
  return entry.meta || null;
}
