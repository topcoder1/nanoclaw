/**
 * Manual weekly-digest runner. Prints the Markdown to stdout.
 *
 * Usage:
 *   npx tsx scripts/brain-weekly-digest.ts
 *
 * The automatic version runs via `startWeeklyDigestSchedule` from
 * src/index.ts; this CLI is for out-of-band runs or testing.
 */

import {
  collectWeeklyDigest,
  formatWeeklyDigestMarkdown,
} from '../src/brain/weekly-digest.js';

const summary = collectWeeklyDigest();
const md = formatWeeklyDigestMarkdown(summary);
// eslint-disable-next-line no-console
console.log(md);
