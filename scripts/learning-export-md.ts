/**
 * Export learned procedures to markdown.
 *
 * Usage:
 *   npx tsx scripts/learning-export-md.ts                  # stdout, all groups
 *   npx tsx scripts/learning-export-md.ts <groupId>        # stdout, group-scoped
 *   npx tsx scripts/learning-export-md.ts <groupId> --write  # writes groups/<id>/PROCEDURES.md
 */

import {
  exportProceduresMarkdown,
  writeProceduresMarkdown,
} from '../src/learning/procedures-markdown.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const groupId = positional[0];

if (flags.has('--write')) {
  if (!groupId) {
    // eslint-disable-next-line no-console
    console.error('--write requires a groupId');
    process.exit(1);
  }
  const filePath = writeProceduresMarkdown(groupId);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${filePath}`);
} else {
  const md = exportProceduresMarkdown({ groupId });
  // eslint-disable-next-line no-console
  console.log(md);
}
