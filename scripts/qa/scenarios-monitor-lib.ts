/**
 * Pure helpers for the scenarios monitor. Extracted from
 * `scripts/qa-monitor-scenarios.ts` so unit tests can exercise the
 * transition-detection and card-formatting logic without importing the
 * CLI module (which executes `main()` on import).
 */
import type { ScenarioResult } from './scenarios.js';

export interface PersistedState {
  runAt: number;
  byScenario: Record<string, 'pass' | 'fail'>;
}

export function verdict(r: ScenarioResult): 'pass' | 'fail' {
  return r.ok ? 'pass' : 'fail';
}

/**
 * Diff the current run against persisted state. Returns only rows that
 * transitioned — steady state (all pass or same set of fails) yields
 * empty arrays, which the monitor treats as "silent, no alert".
 */
export function diffRuns(
  current: ScenarioResult[],
  prev: PersistedState,
): { regressed: ScenarioResult[]; recovered: ScenarioResult[] } {
  const regressed: ScenarioResult[] = [];
  const recovered: ScenarioResult[] = [];
  for (const r of current) {
    const was = prev.byScenario[r.name];
    const now = verdict(r);
    if (was === 'pass' && now === 'fail') regressed.push(r);
    if (was === 'fail' && now === 'pass') recovered.push(r);
  }
  return { regressed, recovered };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Compose a Markdown Telegram card listing regressions (with scenario
 * description + first two failure lines each) followed by recoveries.
 * Returns null when there's nothing to say so the caller can skip the
 * send entirely.
 */
export function formatTransitionMessage(
  regressed: ScenarioResult[],
  recovered: ScenarioResult[],
): string | null {
  if (regressed.length === 0 && recovered.length === 0) return null;
  const parts: string[] = [];
  if (regressed.length > 0) {
    parts.push(`⚠️ *QA scenario regression* (${regressed.length})`);
    for (const r of regressed) {
      parts.push(`• \`${r.name}\``);
      if (r.description) {
        parts.push(`    _${truncate(r.description, 160)}_`);
      }
      for (const f of r.failures.slice(0, 2)) {
        parts.push(`    ↳ ${truncate(f, 160)}`);
      }
      if (r.failures.length > 2) {
        parts.push(`    ↳ … +${r.failures.length - 2} more`);
      }
    }
  }
  if (recovered.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`✅ *QA scenario recovery* (${recovered.length})`);
    for (const r of recovered) {
      parts.push(`• \`${r.name}\``);
    }
  }
  return parts.join('\n');
}
