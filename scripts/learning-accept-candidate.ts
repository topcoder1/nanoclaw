/**
 * Apply a consolidation candidate produced by scripts/learning-consolidate.ts.
 *
 * Saves the proposed procedure and renames each replaced original to
 * <name>.deprecated.json so it stops participating in matching while
 * remaining on disk for audit.
 *
 * Usage:
 *   npx tsx scripts/learning-accept-candidate.ts <candidate-path>
 *   npx tsx scripts/learning-accept-candidate.ts <candidate-path> --dry-run
 */

import { acceptCandidate } from '../src/learning/accept-candidate.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const candidatePath = positional[0];

if (!candidatePath) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: learning-accept-candidate.ts <candidate-path> [--dry-run]',
  );
  process.exit(1);
}

try {
  const result = acceptCandidate(candidatePath, {
    dryRun: flags.has('--dry-run'),
  });
  // eslint-disable-next-line no-console
  console.log(
    `${result.dryRun ? '[dry-run] ' : ''}Accepted: ${result.proposedName}\n` +
      `  deprecated: ${result.deprecated.length === 0 ? '(none)' : result.deprecated.join(', ')}\n` +
      `  missing:    ${result.missing.length === 0 ? '(none)' : result.missing.join(', ')}`,
  );
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
