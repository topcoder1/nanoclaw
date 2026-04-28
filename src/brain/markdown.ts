/**
 * Tiny Telegram-Markdown-V1 escaper shared across brain reports.
 *
 * Escapes `_ * \` [ ] ( )` so user-provided text (KU content, entity
 * names, email subjects) can't break the surrounding report. A stray `*`
 * in a KU snippet otherwise silently italicizes the rest of the message.
 *
 * `]` and `)` matter specifically when escaped text is dropped inside a
 * Markdown link's text or URL — e.g. `📎 [${escapeMarkdown(subject)}](url)`
 * in recall-command.ts:formatSourceLink. An email subject like
 * `Re: [JIRA-1234] notes` would otherwise close the link text early at
 * the unescaped `]` after "JIRA-1234" and render `](url)` as literal
 * trailing characters. Real-world subjects with bracketed tags (JIRA,
 * `[External]`, `[Action Required]`) are common enough that this is a
 * visible bug rather than a theoretical edge case.
 *
 * Scope is deliberately narrow: callers wrap formatting characters
 * themselves (*bold*, `code`); only the content fields should go
 * through escapeMarkdown().
 */

export function escapeMarkdown(s: string): string {
  return s.replace(/([_*`\[\]()])/g, '\\$1');
}
