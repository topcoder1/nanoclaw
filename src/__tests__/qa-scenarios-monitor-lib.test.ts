/**
 * Unit tests for the scenarios-monitor pure helpers. Covers the two
 * decisions a cron run makes — which rows transitioned, and what the
 * Telegram card says — without touching fs, Telegram, or the real
 * scenarios runner.
 *
 * The CLI wrapper (scripts/qa-monitor-scenarios.ts) is deliberately not
 * imported here because importing it triggers its top-level `main()`
 * call. That's why the helpers live in the separate lib module.
 */
import { describe, it, expect } from 'vitest';
import {
  diffRuns,
  formatTransitionMessage,
  verdict,
  type PersistedState,
} from '../../scripts/qa/scenarios-monitor-lib.js';
import type { ScenarioResult } from '../../scripts/qa/scenarios.js';

function result(
  name: string,
  ok: boolean,
  description = `description for ${name}`,
  failures: string[] = ok ? [] : ['default failure line'],
): ScenarioResult {
  return { name, description, ok, failures };
}

describe('verdict', () => {
  it('maps ok→pass and !ok→fail', () => {
    expect(verdict(result('a', true))).toBe('pass');
    expect(verdict(result('a', false))).toBe('fail');
  });
});

describe('diffRuns', () => {
  const baseline: PersistedState = {
    runAt: 1,
    byScenario: { a: 'pass', b: 'pass', c: 'fail' },
  };

  it('empty when every scenario holds its prior verdict', () => {
    const { regressed, recovered } = diffRuns(
      [result('a', true), result('b', true), result('c', false)],
      baseline,
    );
    expect(regressed).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it('flags pass → fail as regressed', () => {
    const { regressed, recovered } = diffRuns(
      [result('a', false), result('b', true), result('c', false)],
      baseline,
    );
    expect(regressed.map((r) => r.name)).toEqual(['a']);
    expect(recovered).toEqual([]);
  });

  it('flags fail → pass as recovered', () => {
    const { regressed, recovered } = diffRuns(
      [result('a', true), result('b', true), result('c', true)],
      baseline,
    );
    expect(regressed).toEqual([]);
    expect(recovered.map((r) => r.name)).toEqual(['c']);
  });

  it('handles simultaneous regression and recovery in one run', () => {
    const { regressed, recovered } = diffRuns(
      [result('a', false), result('b', true), result('c', true)],
      baseline,
    );
    expect(regressed.map((r) => r.name)).toEqual(['a']);
    expect(recovered.map((r) => r.name)).toEqual(['c']);
  });

  it('treats unknown scenarios (new additions) as neither regressed nor recovered', () => {
    // A new scenario has no prior verdict → transition rules only fire
    // on known states. First failure of a new scenario shouldn't page.
    const { regressed, recovered } = diffRuns(
      [result('brand-new', false)],
      baseline,
    );
    expect(regressed).toEqual([]);
    expect(recovered).toEqual([]);
  });
});

describe('formatTransitionMessage', () => {
  it('returns null when nothing transitioned (steady-state is silent)', () => {
    expect(formatTransitionMessage([], [])).toBeNull();
  });

  it('renders a regression card with name, description, and first 2 failure lines', () => {
    const msg = formatTransitionMessage(
      [
        result(
          'snooze-tomorrow',
          false,
          'handleSnooze(tomorrow) must set snoozed_until to next 8am',
          [
            'db count: query "..." expected 1, got 0',
            'dbValue.state: expected "held", got "pushed"',
            'outbound.text: missing fragment',
          ],
        ),
      ],
      [],
    );
    expect(msg).toMatch(/QA scenario regression.*1/);
    expect(msg).toMatch(/`snooze-tomorrow`/);
    expect(msg).toMatch(/handleSnooze\(tomorrow\) must set snoozed_until/);
    expect(msg).toMatch(/db count: query "\.\.\." expected 1, got 0/);
    expect(msg).toMatch(/dbValue\.state: expected "held", got "pushed"/);
    // Third failure line is summarized rather than shown in full.
    expect(msg).not.toMatch(/outbound\.text: missing fragment/);
    expect(msg).toMatch(/\+1 more/);
  });

  it('renders a recovery card with just names (no failure context needed)', () => {
    const msg = formatTransitionMessage(
      [],
      [result('archive-from-queued', true)],
    );
    expect(msg).toMatch(/QA scenario recovery.*1/);
    expect(msg).toMatch(/`archive-from-queued`/);
    expect(msg).not.toMatch(/↳/); // no failure arrows on recoveries
  });

  it('renders a combined card with regressions above recoveries', () => {
    const msg = formatTransitionMessage(
      [result('new-bad', false)],
      [result('now-good', true)],
    )!;
    const badAt = msg.indexOf('new-bad');
    const goodAt = msg.indexOf('now-good');
    expect(badAt).toBeGreaterThan(-1);
    expect(goodAt).toBeGreaterThan(badAt);
  });

  it('truncates very long description and failure lines so Telegram does not reject the card', () => {
    const longDesc = 'x'.repeat(500);
    const longFailure = 'y'.repeat(500);
    const msg = formatTransitionMessage(
      [result('verbose', false, longDesc, [longFailure])],
      [],
    )!;
    // Every line should be capped around the truncation length.
    for (const line of msg.split('\n')) {
      expect(line.length).toBeLessThan(200);
    }
    expect(msg).toMatch(/…/); // ellipsis marks where truncation happened
  });

  it('omits the description row when the scenario had none (defensive)', () => {
    const msg = formatTransitionMessage(
      [result('no-desc', false, '', ['only failure'])],
      [],
    )!;
    // No empty italics row for the missing description.
    expect(msg).not.toMatch(/_\s*_/);
    expect(msg).toMatch(/only failure/);
  });
});
