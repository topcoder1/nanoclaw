import { describe, expect, it } from 'vitest';

import { escapeMarkdown } from '../markdown.js';

describe('brain/markdown — escapeMarkdown', () => {
  it('escapes the four core formatting chars (_ * ` [) for non-link contexts', () => {
    expect(escapeMarkdown('_underscore_')).toBe('\\_underscore\\_');
    expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    expect(escapeMarkdown('[bracket')).toBe('\\[bracket');
  });

  it('escapes ] and ) so subjects survive embedding in [text](url)', () => {
    // Regression — pre-fix the regex was /([_*`\[])/, so ] and ) leaked
    // through and broke any Markdown link whose text came from user
    // content with bracketed tags or parens.
    expect(escapeMarkdown('Re: [JIRA-1234] notes')).toBe(
      'Re: \\[JIRA-1234\\] notes',
    );
    expect(escapeMarkdown('[External] Action required')).toBe(
      '\\[External\\] Action required',
    );
    expect(escapeMarkdown('Closing paren) here')).toBe('Closing paren\\) here');
    expect(escapeMarkdown('(parenthetical aside)')).toBe(
      '\\(parenthetical aside\\)',
    );
  });

  it('produces a Telegram-renderable link when interpolated as link text', () => {
    const subject = 'Re: [JIRA-1234] urgent (P0) issue';
    const url = 'https://example.com/x';
    const link = `[${escapeMarkdown(subject)}](${url})`;
    // The link's text portion must contain only escaped brackets/parens
    // so Telegram's parser doesn't terminate it early.
    expect(link).toBe(
      '[Re: \\[JIRA-1234\\] urgent \\(P0\\) issue](https://example.com/x)',
    );
    // Sanity: there should be exactly one unescaped `]` in the whole
    // link string — the one that closes the link text.
    const unescapedClosingBrackets = link.replace(/\\]/g, '').match(/]/g) ?? [];
    expect(unescapedClosingBrackets.length).toBe(1);
  });

  it('passes through plain text untouched', () => {
    expect(escapeMarkdown('Hello, world.')).toBe('Hello, world.');
    expect(escapeMarkdown('')).toBe('');
  });

  it('handles strings containing all special chars at once', () => {
    const s = '_*`[](){}';
    // Only _, *, `, [, ], (, ) get escaped; { and } are not part of V1
    // and pass through untouched.
    expect(escapeMarkdown(s)).toBe('\\_\\*\\`\\[\\]\\(\\){}');
  });
});
