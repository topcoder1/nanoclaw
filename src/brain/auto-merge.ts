/**
 * Auto-merge engine. Nightly sweep that finds duplicate entities by
 * deterministic SQL rules and either silently merges them (high confidence)
 * or persists chat suggestions for operator review (medium confidence).
 *
 * Spec: docs/superpowers/specs/2026-04-28-auto-merge-design.md
 */

/**
 * Return the two entity ids in lex-smaller-first order. Throws if equal —
 * callers should never construct a pair from the same id.
 */
export function lexOrdered(a: string, b: string): [string, string] {
  if (a === b) {
    throw new Error(`lexOrdered: refusing equal pair ${a}`);
  }
  return a < b ? [a, b] : [b, a];
}

/**
 * Normalize a phone string to E.164-ish form. Strips all non-digit chars
 * (except a leading `+`), then re-prefixes `+` if missing. Returns null
 * if no digits remain or the input lacks any digit characters at all.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasDigits = /\d/.test(trimmed);
  if (!hasDigits) return null;
  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  // If the original started with '+' OR begins with a country code (11 digits
  // starting with 1 for NANP), keep it. Otherwise also prefix '+' so all forms
  // collapse — the test fixtures show '16263483472' and '+16263483472' must
  // collide.
  if (startsWithPlus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}
