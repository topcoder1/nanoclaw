/**
 * QA scenarios monitor — cron-driven scenario runner with transition
 * alerting. Parallel to qa-monitor.ts (which handles invariants); kept
 * in a separate process so scenario failure modes (crashes on one
 * scenario, long runs, network flakes to the mini-app) can't knock out
 * the invariant-alerting path, and the two lanes can run on different
 * cadences (invariants ~10 min, scenarios ~30 min — scenarios exercise
 * real code paths and are heavier).
 *
 * Verdict state is persisted to its own file (`data/qa-scenarios-state.json`)
 * so a scenario rename doesn't poison invariant state and vice versa.
 *
 * On any pass → fail transition:
 *   - Sends a Telegram regression card naming the scenario, its
 *     description, and the first failure lines.
 *   - Dispatches qa:propose-fix with `source: 'scenarios'` so the
 *     autopilot agent gets scenario context (not invariant context)
 *     in its diagnosis prompt.
 *
 * Gating:
 *   QA_SCENARIOS_MONITOR_DISABLED=1  skip entire run
 *   QA_SCENARIOS_MONITOR_DRY_RUN=1   run + log, don't persist or notify
 *   QA_AUTO_PROPOSE_FIX=0            skip propose-fix dispatch
 *
 * Exit:
 *   0 - run completed
 *   2 - runner crashed before it could check
 */
import fs from 'node:fs';
import path from 'node:path';
import { runAll, type ScenarioResult } from './qa/scenarios.js';
import {
  diffRuns,
  formatTransitionMessage,
  verdict,
  type PersistedState,
} from './qa/scenarios-monitor-lib.js';
import { readEnvValue } from '../src/env.js';

const STATE_FILE = path.resolve('data/qa-scenarios-state.json');

function loadState(): PersistedState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedState;
  } catch {
    return null;
  }
}

function saveState(state: PersistedState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = readEnvValue('TELEGRAM_BOT_TOKEN');
  if (!token) {
    process.stderr.write(
      'qa-monitor-scenarios: TELEGRAM_BOT_TOKEN not set; would have sent: ' +
        text +
        '\n',
    );
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  }).catch((err) => {
    process.stderr.write(`qa-monitor-scenarios: Telegram send failed: ${err}\n`);
    return null;
  });
  if (res && !res.ok) {
    const body = await res.text().catch(() => '');
    process.stderr.write(
      `qa-monitor-scenarios: Telegram ${res.status}: ${body.slice(0, 200)}\n`,
    );
  }
}

async function dispatchProposeFix(regressed: ScenarioResult[]): Promise<void> {
  // Map scenario failures to the shared FailureReport shape consumed by
  // scripts/qa/propose-fix.ts. `source: 'scenarios'` routes the agent
  // prompt through the scenarios-aware branch of buildAgentPrompt.
  const report = {
    source: 'scenarios' as const,
    failures: regressed.map((r) => ({
      name: r.name,
      message: r.failures[0] ?? '(no failure message)',
      category: 'scenario',
      details: {
        description: r.description,
        failures: r.failures,
      },
    })),
  };
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(
      '/opt/homebrew/bin/npm',
      ['--prefix', process.cwd(), 'run', 'qa:propose-fix'],
      { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.stdin.write(JSON.stringify(report));
    child.stdin.end();
    child.unref();
    process.stdout.write(
      `qa-monitor-scenarios: dispatched propose-fix for ${regressed.length} scenario regression(s)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `qa-monitor-scenarios: propose-fix dispatch failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

async function main(): Promise<void> {
  if (readEnvValue('QA_SCENARIOS_MONITOR_DISABLED') === '1') {
    process.stdout.write(
      'qa-monitor-scenarios: disabled via QA_SCENARIOS_MONITOR_DISABLED=1\n',
    );
    process.exit(0);
  }
  const dryRun = readEnvValue('QA_SCENARIOS_MONITOR_DRY_RUN') === '1';

  let results: ScenarioResult[];
  try {
    results = await runAll();
  } catch (err) {
    process.stderr.write(
      `qa-monitor-scenarios: runner crashed: ${err instanceof Error ? err.message : err}\n`,
    );
    const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
    if (chatId && !dryRun) {
      await sendTelegram(
        chatId,
        `💥 *QA scenarios monitor crashed*\n\`${err instanceof Error ? err.message : String(err)}\``,
      );
    }
    process.exit(2);
  }

  const prev = loadState();
  const current: PersistedState = {
    runAt: Date.now(),
    byScenario: Object.fromEntries(results.map((r) => [r.name, verdict(r)])),
  };

  // First run: establish baseline, no alerts. Same semantics as
  // qa-monitor.ts to avoid a single loud startup burst.
  if (!prev) {
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    process.stdout.write(
      `qa-monitor-scenarios: first run — baseline ${pass} pass / ${fail} fail, no alerts\n`,
    );
    if (!dryRun) saveState(current);
    process.exit(0);
  }

  const { regressed, recovered } = diffRuns(results, prev);

  const message = formatTransitionMessage(regressed, recovered);
  const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
  if (message && chatId && !dryRun) {
    await sendTelegram(chatId, message);
  }

  if (
    regressed.length > 0 &&
    !dryRun &&
    readEnvValue('QA_AUTO_PROPOSE_FIX') !== '0'
  ) {
    await dispatchProposeFix(regressed);
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(
    `qa-monitor-scenarios: ${pass} pass, ${fail} fail, ${regressed.length} regressions, ${recovered.length} recoveries\n`,
  );
  if (message) {
    process.stdout.write(message + '\n');
  }

  if (!dryRun) saveState(current);
  process.exit(0);
}

main();
