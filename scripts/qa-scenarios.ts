/**
 * QA scenarios CLI — thin CLI entry around the library module
 * `scripts/qa/scenarios.ts`. The split mirrors qa-check.ts /
 * scripts/qa/invariants.ts: keep scenario execution a pure function
 * (`runAll`) so the scenarios-monitor can import it without triggering
 * a second run on import.
 *
 * Usage: npm run qa:scenarios
 * Exit:  0 = all pass, 1 = any fail, 2 = runner crashed
 */
import {
  runAll,
  formatReport,
  SCENARIO_DIR,
} from './qa/scenarios.js';

async function main(): Promise<void> {
  try {
    const results = await runAll();
    if (results.length === 0) {
      process.stdout.write(`no scenarios in ${SCENARIO_DIR}\n`);
      process.exit(0);
    }
    process.stdout.write(formatReport(results) + '\n');
    const failed = results.filter((r) => !r.ok).length;
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(
      `QA scenarios runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  }
}

main();
