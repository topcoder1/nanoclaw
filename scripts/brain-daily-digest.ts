/**
 * Manual daily-digest runner. Prints the Markdown to stdout.
 *
 * Usage:
 *   npx tsx scripts/brain-daily-digest.ts
 *
 * The automatic version runs via `startDigestSchedule('daily', …)` when the
 * `BRAIN_DIGEST_CADENCE=daily` env var is set (see src/index.ts). This CLI
 * is for out-of-band runs or testing during the 30-day measurement phase.
 */

import {
  collectWeeklyDigest,
  formatWeeklyDigestMarkdown,
} from '../src/brain/weekly-digest.js';

const summary = collectWeeklyDigest({ cadence: 'daily' });
const md = formatWeeklyDigestMarkdown(summary);
// eslint-disable-next-line no-console
console.log(md);
