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
