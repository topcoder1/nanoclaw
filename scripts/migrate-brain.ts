/**
 * CLI wrapper for the knowledge_facts → knowledge_units migration.
 *
 * Usage:
 *   npx tsx scripts/migrate-brain.ts --dry-run     # preview only, no inserts
 *   npx tsx scripts/migrate-brain.ts               # perform the migration
 *
 * Idempotent — safe to re-run. Never mutates the legacy messages.db.
 */

import { migrateKnowledgeFacts } from '../src/brain/migrate-knowledge-facts.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const report = await migrateKnowledgeFacts({ dryRun });
/* eslint-disable no-console */
console.log('--- migrate-brain report ---');
console.log(`mode:                  ${dryRun ? 'DRY RUN' : 'APPLY'}`);
console.log(`legacyPath:            ${report.legacyPath}`);
console.log(`legacyRowsTotal:       ${report.legacyRowsTotal}`);
console.log(`alreadyMigrated:       ${report.alreadyMigrated}`);
console.log(`inserted${dryRun ? ' (planned)' : ''}:           ${report.inserted}`);
console.log(`skippedEmpty:          ${report.legacyRowsSkippedEmpty}`);
console.log(`qdrantWritten:         ${report.qdrantWritten}`);
console.log(`qdrantFailed:          ${report.qdrantFailed}`);
console.log(`trackedItemsLinked:    ${report.trackedItemsLinked}`);
console.log(`commitmentsLinked:     ${report.commitmentsLinked}`);
console.log(`actedEmailsLinked:     ${report.actedEmailsLinked}`);
console.log(`errors:                ${report.errors.length}`);
if (report.errors.length > 0) {
  for (const e of report.errors) console.log(`  - ${e}`);
}
console.log(`startedAt:             ${report.startedAt}`);
console.log(`finishedAt:            ${report.finishedAt}`);
/* eslint-enable no-console */
if (report.errors.length > 0) process.exit(1);
