import fs from 'fs';
import path from 'path';

import { generateText } from 'ai';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { resolveUtilityModel } from '../llm/utility.js';
import {
  listProcedures,
  type Procedure,
  type ProcedureStep,
} from '../memory/procedure-store.js';

const CLUSTER_OVERLAP_THRESHOLD = 0.7;

export function stepsOverlap(a: ProcedureStep[], b: ProcedureStep[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aActions = new Set(a.map((s) => s.action));
  const bActions = new Set(b.map((s) => s.action));
  let common = 0;
  for (const x of aActions) if (bActions.has(x)) common++;
  return common / Math.max(aActions.size, bActions.size);
}

export interface Cluster {
  members: Procedure[];
}

export function clusterProcedures(procs: Procedure[]): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  for (const seed of procs) {
    if (assigned.has(seed.name)) continue;
    const cluster: Cluster = { members: [seed] };
    assigned.add(seed.name);

    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of procs) {
        if (assigned.has(candidate.name)) continue;
        const matches = cluster.members.some(
          (m) =>
            stepsOverlap(m.steps, candidate.steps) >= CLUSTER_OVERLAP_THRESHOLD,
        );
        if (matches) {
          cluster.members.push(candidate);
          assigned.add(candidate.name);
          grew = true;
        }
      }
    }

    if (cluster.members.length >= 2) clusters.push(cluster);
  }
  return clusters;
}

export function buildConsolidationPrompt(cluster: Cluster): string {
  const blocks = cluster.members
    .map((p, i) => {
      const total = p.success_count + p.failure_count;
      const rate = total > 0 ? Math.round((p.success_count / total) * 100) : 0;
      const stepsTxt = p.steps
        .map(
          (s, j) =>
            `   ${j + 1}. ${s.action}${s.details ? ` — ${s.details}` : ''}`,
        )
        .join('\n');
      return [
        `Procedure ${i + 1}: ${p.name}`,
        `  Trigger: ${p.trigger}`,
        `  Description: ${p.description ?? '(none)'}`,
        `  Stats: ${rate}% success, ${total} runs`,
        '  Steps:',
        stepsTxt,
      ].join('\n');
    })
    .join('\n\n');

  return `You are reviewing learned agent procedures that overlap. Merge them into one cleaner procedure.

Output STRICT JSON ONLY. No prose, no markdown fences. Schema:
{
  "name": "snake_case_name",
  "trigger": "concise trigger phrase the user might say",
  "description": "one line describing when to use this",
  "steps": [{ "action": "verb_phrase", "details": "what happens" }]
}

Procedures to merge:
${blocks}`;
}

export interface ConsolidatedDraft {
  name: string;
  trigger: string;
  description: string;
  steps: ProcedureStep[];
}

export function parseConsolidatedJson(raw: string): ConsolidatedDraft | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || typeof obj.trigger !== 'string') {
    return null;
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;

  const steps: ProcedureStep[] = [];
  for (const s of obj.steps) {
    if (!s || typeof s !== 'object') continue;
    const step = s as Record<string, unknown>;
    const action = typeof step.action === 'string' ? step.action.trim() : '';
    if (!action) continue;
    const details = typeof step.details === 'string' ? step.details : undefined;
    steps.push({ action, details });
  }
  if (steps.length === 0) return null;

  return {
    name: obj.name,
    trigger: obj.trigger,
    description: typeof obj.description === 'string' ? obj.description : '',
    steps,
  };
}

export interface ConsolidatorDeps {
  llmCall?: (prompt: string) => Promise<string>;
}

export interface ClusterReport {
  members: string[];
  proposed: Procedure | null;
  error?: string;
}

export interface ConsolidationResult {
  groupId?: string;
  totalProcedures: number;
  clustersFound: number;
  clusters: ClusterReport[];
  reportPath?: string;
  candidatesDir?: string;
}

async function defaultLlmCall(prompt: string): Promise<string> {
  const model = resolveUtilityModel();
  const { text } = await generateText({ model, prompt });
  return text;
}

function isDeprecated(p: Procedure): boolean {
  return p.name.endsWith('.deprecated');
}

export async function runConsolidation(
  opts: {
    groupId?: string;
    deps?: ConsolidatorDeps;
    writeReport?: boolean;
  } = {},
): Promise<ConsolidationResult> {
  const writeReport = opts.writeReport ?? true;
  const procs = listProcedures(opts.groupId).filter((p) => !isDeprecated(p));
  const clusters = clusterProcedures(procs);
  const llmCall = opts.deps?.llmCall ?? defaultLlmCall;

  const result: ConsolidationResult = {
    groupId: opts.groupId,
    totalProcedures: procs.length,
    clustersFound: clusters.length,
    clusters: [],
  };

  for (const cluster of clusters) {
    const memberNames = cluster.members.map((m) => m.name);
    try {
      const prompt = buildConsolidationPrompt(cluster);
      const raw = await llmCall(prompt);
      const parsed = parseConsolidatedJson(raw);
      if (!parsed) {
        result.clusters.push({
          members: memberNames,
          proposed: null,
          error: 'parse_failed',
        });
        continue;
      }
      const totalSucc = cluster.members.reduce(
        (s, m) => s + m.success_count,
        0,
      );
      const totalFail = cluster.members.reduce(
        (s, m) => s + m.failure_count,
        0,
      );
      const now = new Date().toISOString();
      const proposed: Procedure = {
        name: parsed.name,
        trigger: parsed.trigger,
        description: parsed.description,
        steps: parsed.steps,
        success_count: totalSucc,
        failure_count: totalFail,
        auto_execute: false,
        created_at: now,
        updated_at: now,
        groupId: cluster.members[0].groupId,
      };
      result.clusters.push({ members: memberNames, proposed });
    } catch (err) {
      result.clusters.push({
        members: memberNames,
        proposed: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (writeReport) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportDir = path.join(STORE_DIR, 'consolidation-reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${ts}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
    result.reportPath = reportPath;

    const candidatesDir = path.join(STORE_DIR, 'consolidation-candidates', ts);
    fs.mkdirSync(candidatesDir, { recursive: true });
    for (const c of result.clusters) {
      if (!c.proposed) continue;
      const safeName = c.proposed.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const candidatePath = path.join(candidatesDir, `${safeName}.json`);
      const payload = {
        proposed: c.proposed,
        replaces: c.members,
      };
      fs.writeFileSync(
        candidatePath,
        JSON.stringify(payload, null, 2),
        'utf-8',
      );
    }
    result.candidatesDir = candidatesDir;

    logger.info(
      {
        clusters: result.clustersFound,
        reportPath,
        candidatesDir,
      },
      'Consolidation run complete',
    );
  }

  return result;
}
