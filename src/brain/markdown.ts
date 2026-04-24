/**
 * Tiny Telegram-Markdown-V1 escaper shared across brain reports.
 *
 * V1 only treats `_ * \` [` as special outside code blocks; escaping those
 * four is enough to prevent user-provided text (KU content, entity names,
 * email subjects) from breaking up the surrounding report — a stray `*`
 * in a KU snippet otherwise silently italicizes the rest of the message.
 *
 * Scope is deliberately narrow: callers wrap formatting characters
 * themselves (*bold*, `code`); only the content fields should go through
 * escapeMarkdown().
 */

export function escapeMarkdown(s: string): string {
  return s.replace(/([_*`\[])/g, '\\$1');
}
