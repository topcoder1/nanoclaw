/**
 * Parse `claw merge` arguments. Supports bare words and double-quoted phrases.
 *   `Jonathan "J Zhang"` → ['Jonathan', 'J Zhang']
 *   `alice bob`          → ['alice', 'bob']
 *   `"alice"" bob"`      → ['alice', ' bob']  // not strictly correct but acceptable
 *
 * Used by both Signal and Discord channels' `claw merge` text triggers.
 */
export function parseMergeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? '');
  }
  return out;
}
