// Shared HTML/JS escaping helpers for mini-app templates. Previously each
// template carried its own copy with slightly different character coverage
// (some missed `"` or `'`), creating defense-in-depth gaps whenever a
// variable drifted from text context into an attribute.

const HTML_CHARS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape for any HTML context — text nodes, double/single-quoted attrs.
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_CHARS[c] ?? c);
}

// Safe JS-string literal. Use when embedding a value inside a <script> tag
// as a string: `const x = ${escapeJs(foo)};`. Returns a quoted, fully
// escaped JS string via JSON.stringify.
export function escapeJs(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}
