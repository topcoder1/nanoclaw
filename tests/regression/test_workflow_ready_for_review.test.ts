// Lesson 2026-07-16: a workflow that gates on `draft == false` but does not listen
// for `ready_for_review` FAILS OPEN — its required check reports `skipped`, and
// GitHub counts a skipped REQUIRED context as SATISFIED, so the PR merges green and
// UNREVIEWED.
//
// The sequence, for a caller whose `types:` omits `ready_for_review`:
//   1. PR opened as a draft -> `opened` fires -> job skips on the draft gate (correct)
//   2. `gh pr ready`        -> `ready_for_review` fires -> caller is not listening
//   3. nothing runs; `review / Claude Review` stays `skipped` -> counted as SATISFIED
//
// Fleet policy makes DRAFT the standard auto-merge opt-out, so every manual-merge PR
// is draft->ready — the recommended workflow was the one guaranteed to skip the review.
//
// The transitive case is why this test PARSES instead of grepping: pr-review.yml
// contains no `draft` expression at all, because the gate lives in the reusable it
// calls (ci-workflows/claude-review.yml). Grepping the caller cannot see it.
//
// An explicit `types:` list is a DENYLIST BY OMISSION, and this exact mistake has now
// been made twice fleet-wide (`reopened` was dropped first, then `ready_for_review` was
// dropped directly below the comment warning about `reopened`). A comment did not
// prevent the recurrence, so the rule is pinned to the runtime here.
//
// See: ci-workflows#115 (central reusable), dotclaude#156 (caller template),
// domain-rank#35 (reference fix). Fleet sweep 2026-07-16 found 21 repos still vulnerable.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const workflowsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/workflows',
);

// GitHub's default `pull_request` activity types. `ready_for_review` is NOT among
// them, which is why omitting an explicit `types:` list is not a safe default for a
// draft-gated workflow: the default is itself a denylist.
const GITHUB_DEFAULT_PR_TYPES = ['opened', 'synchronize', 'reopened'];

// Reusables in topcoder1/ci-workflows whose jobs gate on `draft == false`. A caller
// inherits that gate transitively. Verified against every `workflow_call` reusable on
// 2026-07-16; extend this set if a new draft-gating reusable is adopted.
const DRAFT_GATED_REUSABLES = new Set([
  'claude-review.yml',
  'claude-author-automerge.yml',
  'safe-paths-automerge.yml',
  'codex-review.yml',
  'claude-adversarial-review.yml',
]);

interface Workflow {
  on?: unknown;
  jobs?: Record<string, { if?: string; uses?: string } | null>;
}

function triggers(wf: Workflow): Record<string, unknown> {
  // js-yaml keeps `on` as the string key "on" (unlike PyYAML, which resolves the bare
  // key to boolean true under YAML 1.1). Accept both so this cannot silently read
  // undefined and pass vacuously.
  const raw = (wf.on ?? (wf as Record<string, unknown>)['true']) as unknown;
  if (typeof raw === 'string') return { [raw]: {} };
  if (Array.isArray(raw))
    return Object.fromEntries(raw.map((k) => [String(k), {}]));
  return (raw ?? {}) as Record<string, unknown>;
}

function prTypes(wf: Workflow): string[] {
  const pr = triggers(wf)['pull_request'];
  if (pr === null || typeof pr !== 'object') return GITHUB_DEFAULT_PR_TYPES;
  const types = (pr as { types?: unknown }).types;
  return Array.isArray(types) && types.length
    ? types.map(String)
    : GITHUB_DEFAULT_PR_TYPES;
}

function hasDraftGate(wf: Workflow): boolean {
  for (const job of Object.values(wf.jobs ?? {})) {
    if (!job) continue;
    if (String(job.if ?? '').includes('draft == false')) return true;
    const base = String(job.uses ?? '')
      .split('@')[0]
      .split('/')
      .pop();
    if (base && DRAFT_GATED_REUSABLES.has(base)) return true;
  }
  return false;
}

const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

describe('draft-gated workflows listen for ready_for_review', () => {
  it('finds the workflows directory', () => {
    // Guards the rest of the suite: a wrong path would make every case below
    // vacuously pass and silently retire this regression test.
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it('detects a draft gate inherited from a called reusable', () => {
    // The load-bearing assertion. A caller with no `draft` text of its own still
    // inherits the gate; if this ever regresses to a text search over the caller, the
    // rule below would pass vacuously on exactly the files it exists to protect.
    const caller = yaml.load(
      [
        'on:',
        '  pull_request:',
        '    types: [opened]',
        'jobs:',
        '  review:',
        '    uses: topcoder1/ci-workflows/.github/workflows/claude-review.yml@main',
      ].join('\n'),
    ) as Workflow;
    expect(JSON.stringify(caller)).not.toContain('draft');
    expect(hasDraftGate(caller)).toBe(true);
  });

  it.each(workflowFiles)('%s', (file) => {
    const wf = yaml.load(
      fs.readFileSync(path.join(workflowsDir, file), 'utf8'),
    ) as Workflow;
    if (!('pull_request' in triggers(wf))) return; // not a pull_request workflow
    if (!hasDraftGate(wf)) return; // no draft gate, locally or via a reusable

    expect(
      prTypes(wf),
      `${file} gates on \`draft == false\` but does not list \`ready_for_review\` in its ` +
        `pull_request types [${prTypes(wf).join(', ')}]. A draft PR skips its job at ` +
        `\`opened\`, and \`gh pr ready\` would fire nothing this workflow hears — so its ` +
        `check reports \`skipped\`, which GitHub counts as a SATISFIED required context. ` +
        `The PR merges green and unreviewed. See ci-workflows#115, domain-rank#35.`,
    ).toContain('ready_for_review');
  });
});
