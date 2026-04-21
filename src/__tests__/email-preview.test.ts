import { describe, it, expect } from 'vitest';
import {
  truncatePreview,
  plaintextPreview,
  cacheEmailBody,
  getCachedEmailBody,
  cacheEmailMeta,
  getCachedEmailMeta,
} from '../email-preview.js';
import type { EmailMeta } from '../gmail-ops.js';

describe('truncatePreview', () => {
  it('returns full text if under limit', () => {
    const text = 'Short email body.';
    expect(truncatePreview(text, 500)).toBe(text);
  });

  it('truncates at word boundary', () => {
    const text = 'word '.repeat(200); // 1000 chars
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550); // some slack for suffix
    expect(preview).toContain('— truncated');
    expect(preview).not.toMatch(/\s— truncated/); // no trailing space before truncation marker
  });

  it('handles text with no spaces', () => {
    const text = 'a'.repeat(600);
    const preview = truncatePreview(text, 500);
    expect(preview.length).toBeLessThanOrEqual(550);
  });
});

describe('plaintextPreview', () => {
  it('strips HTML tags from transactional email bodies', () => {
    const html =
      '<html><body><p>Hello <b>topcoder1</b>,</p><p>Your order is pending.</p></body></html>';
    const preview = plaintextPreview(html, 500);
    expect(preview).not.toMatch(/<[a-z]/i);
    expect(preview).toContain('Hello');
    expect(preview).toContain('Your order is pending');
  });

  it('decodes common HTML entities', () => {
    const html = 'Tom &amp; Jerry &lt;3 &nbsp; fun';
    expect(plaintextPreview(html, 500)).toBe('Tom & Jerry <3   fun');
  });

  it('drops script/style content entirely', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script>visible</body></html>';
    const preview = plaintextPreview(html, 500);
    expect(preview).not.toMatch(/color:red|alert/);
    expect(preview).toContain('visible');
  });

  it('converts <br> to newlines so preview keeps some structure', () => {
    const html = 'line1<br>line2<br/>line3';
    expect(plaintextPreview(html, 500)).toBe('line1\nline2\nline3');
  });

  it('still truncates at the requested char cap', () => {
    const html = '<p>' + 'word '.repeat(400) + '</p>';
    const preview = plaintextPreview(html, 100);
    expect(preview.length).toBeLessThanOrEqual(150);
    expect(preview).toContain('— truncated');
  });
});

describe('email cache metadata', () => {
  const sampleMeta: EmailMeta = {
    subject: 'Test Subject',
    from: 'sender@example.com',
    to: 'me@example.com',
    date: 'Thu, 1 Jan 2026 00:00:00 +0000',
    body: 'Full email body text',
  };

  it('cacheEmailMeta stores and getCachedEmailMeta retrieves full metadata', () => {
    const id = `test-meta-${Date.now()}`;
    cacheEmailMeta(id, sampleMeta);
    const result = getCachedEmailMeta(id);
    expect(result).toEqual(sampleMeta);
  });

  it('getCachedEmailBody works with metadata cache entries (returns body from meta entry)', () => {
    const id = `test-body-from-meta-${Date.now()}`;
    cacheEmailMeta(id, sampleMeta);
    const body = getCachedEmailBody(id);
    expect(body).toBe(sampleMeta.body);
  });

  it('cacheEmailBody (legacy) still works — getCachedEmailMeta returns null for body-only entries', () => {
    const id = `test-body-only-${Date.now()}`;
    cacheEmailBody(id, 'plain body only');
    expect(getCachedEmailBody(id)).toBe('plain body only');
    expect(getCachedEmailMeta(id)).toBeNull();
  });

  it('getCachedEmailMeta returns null for unknown id', () => {
    expect(getCachedEmailMeta('nonexistent-id')).toBeNull();
  });

  it('cacheEmailMeta with cc field preserves cc in retrieved meta', () => {
    const id = `test-cc-${Date.now()}`;
    const metaWithCc: EmailMeta = { ...sampleMeta, cc: 'cc@example.com' };
    cacheEmailMeta(id, metaWithCc);
    const result = getCachedEmailMeta(id);
    expect(result?.cc).toBe('cc@example.com');
  });
});
