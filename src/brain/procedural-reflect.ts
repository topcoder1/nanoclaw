/**
 * Procedural-memory reflection job (design: brain-wiki-and-frontier-v1.md §
 * "Brain reflection extending learned_rules").
 *
 * Once a week, look across the prior 7 days of recall activity and explicit
 * user corrections, then ask Haiku 4.5 to emit 0–5 procedural rules — agent
 * behaviors the user has implicitly or explicitly indicated. Rules land in
 * the existing `learned_rules` store (messages.db) with
 * `source='agent_reported', subsource='brain_reflection'`, contradicting
 * older brain-reflection rules are stamped `superseded_at`, and the brain
 * weekly digest surfaces what was emitted.
 *
 * No automatic prompt injection in v1 — surface, observe, then promote.
 *
 * Cross-DB read: this module is the only place that touches both brain.db
 * (read ku_queries / ku_retrievals) and messages.db (read & write
 * learned_rules). The arrow is one-way; messages.db never reads brain.db.
 */

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';
import {
  addRule,
  listActiveRules,
  markSuperseded,
  type LearnedRule,
} from '../learning/rules-engine.js';

import { getBrainDb } from './db.js';

// --- Public types ----------------------------------------------------------

export interface ReflectionInput {
  /** End of window (exclusive). Defaults to now. */
  nowIso?: string;
  /** Window length in days. Default 7. */
  windowDays?: number;
  /** Cap on emitted rules per run. Default 5. */
  maxRules?: number;
  /** Inject for tests / cost control. Defaults to the real Haiku caller. */
  llm?: ReflectionLlmCaller;
  /** Inject for tests. Defaults to the live brain.db handle. */
  brainDb?: Database.Database;
}

export interface ReflectionResult {
  windowStartIso: string;
  windowEndIso: string;
  /** IDs newly inserted into learned_rules (subsource='brain_reflection'). */
  emittedRuleIds: string[];
  /** Older rules whose `superseded_at` was stamped this run. */
  supersededRuleIds: string[];
  /** Set when reflection bailed out (no signals, LLM error, no rules emitted). */
  skipReason?: string;
}

export interface SignalBundle {
  /** Queries that returned zero hits — knowledge gaps. */
  zeroResultQueries: Array<{ id: string; text: string; recordedAt: string }>;
  /** KUs returned to ≥3 distinct queries — recurring concerns. */
  recurringRetrievals: Array<{
    kuId: string;
    queryCount: number;
    sampleQueries: string[];
  }>;
  /** Recent user_feedback rules — explicit corrections from chat. */
  recentCorrections: Array<{ id: string; text: string; createdAt: string }>;
}

export interface EmittedRule {
  rule: string;
  actionClasses: string[];
  evidence: string[];
  confidence: number;
}

/**
 * Minimal LLM caller for the reflection prompt. Mirrors the shape of
 * `extract.ts:LlmCaller` so we can pass in `defaultLlmCaller` without a
 * shim for tests/production parity.
 */
export type ReflectionLlmCaller = (prompt: string) => Promise<{
  rules?: EmittedRule[];
  inputTokens: number;
  outputTokens: number;
}>;

// --- Signal collection -----------------------------------------------------

const RECURRING_RETRIEVAL_THRESHOLD = 3;
const QUERY_TEXT_PREVIEW_CHARS = 120;

export function collectSignals(
  brainDb: Database.Database,
  windowStartIso: string,
  nowIso: string,
): SignalBundle {
  const zeroResultQueries = brainDb
    .prepare(
      `SELECT id, query_text, recorded_at
         FROM ku_queries
        WHERE recorded_at >= ?
          AND recorded_at < ?
          AND result_count = 0
        ORDER BY recorded_at DESC
        LIMIT 50`,
    )
    .all(windowStartIso, nowIso) as Array<{
    id: string;
    query_text: string;
    recorded_at: string;
  }>;

  const recurringRows = brainDb
    .prepare(
      `SELECT r.ku_id AS ku_id,
              COUNT(DISTINCT r.query_id) AS query_count
         FROM ku_retrievals r
         JOIN ku_queries q ON q.id = r.query_id
        WHERE q.recorded_at >= ?
          AND q.recorded_at < ?
        GROUP BY r.ku_id
       HAVING query_count >= ?
        ORDER BY query_count DESC
        LIMIT 20`,
    )
    .all(
      windowStartIso,
      nowIso,
      RECURRING_RETRIEVAL_THRESHOLD,
    ) as Array<{ ku_id: string; query_count: number }>;

  const recurring = recurringRows.map((row) => {
    const samples = brainDb
      .prepare(
        `SELECT q.query_text
           FROM ku_retrievals r
           JOIN ku_queries q ON q.id = r.query_id
          WHERE r.ku_id = ?
            AND q.recorded_at >= ?
            AND q.recorded_at < ?
          ORDER BY q.recorded_at DESC
          LIMIT 3`,
      )
      .all(row.ku_id, windowStartIso, nowIso) as Array<{ query_text: string }>;
    return {
      kuId: row.ku_id,
      queryCount: row.query_count,
      sampleQueries: samples.map((s) =>
        s.query_text.slice(0, QUERY_TEXT_PREVIEW_CHARS),
      ),
    };
  });

  // Recent user_feedback rules from messages.db — read-only. Source-filter
  // pushed into the SQL so the limit applies to user_feedback rules only;
  // otherwise a busy week of outcome_pattern rules could push every real
  // correction off the bottom and silently drop the entire signal.
  // Defensive try/catch — if messages.db is unreachable (test paths,
  // misconfigured deploy), reflection should still run on brain-only
  // signals rather than blow up the scheduler.
  let recentCorrections: SignalBundle['recentCorrections'] = [];
  try {
    recentCorrections = listActiveRules({
      source: 'user_feedback',
      since: windowStartIso,
      limit: 50,
    }).map((r) => ({ id: r.id, text: r.rule, createdAt: r.createdAt }));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'procedural-reflect: failed to read recent corrections — continuing without them',
    );
  }

  return {
    zeroResultQueries: zeroResultQueries.map((r) => ({
      id: r.id,
      text: r.query_text.slice(0, QUERY_TEXT_PREVIEW_CHARS),
      recordedAt: r.recorded_at,
    })),
    recurringRetrievals: recurring,
    recentCorrections,
  };
}

// --- Prompt + LLM ----------------------------------------------------------

export function hasUsableSignals(s: SignalBundle): boolean {
  return (
    s.zeroResultQueries.length > 0 ||
    s.recurringRetrievals.length > 0 ||
    s.recentCorrections.length > 0
  );
}

export function buildReflectionPrompt(
  s: SignalBundle,
  maxRules: number,
): string {
  const lines: string[] = [
    `You are reviewing an AI assistant's last week of activity to identify procedural rules — *behaviors* the assistant should adopt.`,
    `Output STRICT JSON: {"rules":[{"rule":"...", "actionClasses":["..."], "evidence":["id1","id2"], "confidence":0.0-1.0}]}.`,
    `Cap at ${maxRules} rules. Each rule MUST cite ≥2 evidence ids drawn from the inputs below. Skip emitting any rule you cannot justify with concrete evidence — emit fewer rules rather than weaker ones.`,
    `Skip rules that would be obvious from a generic system prompt.`,
    `Keep rules imperative and specific (e.g. "When the user asks about X, default to Y" — not "be helpful").`,
    ``,
    `=== Recent corrections from the user (explicit feedback in chat) ===`,
  ];
  if (s.recentCorrections.length === 0) {
    lines.push('(none this week)');
  } else {
    for (const c of s.recentCorrections) {
      lines.push(`[${c.id}] ${c.text}`);
    }
  }
  lines.push('', `=== Queries that returned zero hits (knowledge gaps) ===`);
  if (s.zeroResultQueries.length === 0) {
    lines.push('(none this week)');
  } else {
    for (const q of s.zeroResultQueries) {
      lines.push(`[${q.id}] ${q.text}`);
    }
  }
  lines.push(
    '',
    `=== Knowledge units repeatedly retrieved (recurring concerns) ===`,
  );
  if (s.recurringRetrievals.length === 0) {
    lines.push('(none this week)');
  } else {
    for (const r of s.recurringRetrievals) {
      const samples = r.sampleQueries.map((q) => `"${q}"`).join('; ');
      lines.push(
        `[${r.kuId}] returned ${r.queryCount}× — sample queries: ${samples}`,
      );
    }
  }
  lines.push(
    '',
    `Output ONLY the JSON object — no prose, no markdown fences.`,
  );
  return lines.join('\n');
}

/**
 * Adapter — reuses extract.ts's defaultLlmCaller plumbing (Haiku, env, JSON
 * parsing) but expects a `rules` payload instead of `claims`. We post-process
 * the parsed text rather than calling extract.ts directly so the prompt and
 * schema can diverge cleanly.
 */
export const defaultReflectionLlmCaller: ReflectionLlmCaller = async (
  prompt,
) => {
  // Use the same network / SDK plumbing — but we can't share the parser
  // because it expects `claims`. Inline a slim variant instead.
  const { generateText } = await import('ai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { readEnvValue } = await import('../env.js');
  const apiKey = readEnvValue('ANTHROPIC_API_KEY');
  const anthropic = createAnthropic({
    apiKey: apiKey ?? '',
    baseURL:
      readEnvValue('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1',
  });
  const model = anthropic('claude-haiku-4-5-20251001');
  const result = await generateText({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 2048,
  });
  const raw = result.text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const parsed = JSON.parse(raw) as { rules?: EmittedRule[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (result as any).usage ?? {};
  return {
    rules: parsed.rules,
    inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
    outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
  };
};

// --- Supersession (heuristic, no LLM judge in v1) --------------------------

/**
 * Find candidate older rules whose `actionClasses` overlap the new rule's.
 * v1 uses class overlap as a coarse contradiction-candidate filter. The
 * caller decides whether to actually supersede — for v1 we mark *any* class
 * overlap as superseded, since brain-reflection rules are agent-wide and
 * having two contradicting agent-wide rules in the same class is worse than
 * occasionally retiring a still-valid older rule (the user can revert by
 * re-emitting).
 */
export function findSupersedeCandidates(
  newRule: EmittedRule,
  existing: LearnedRule[],
): LearnedRule[] {
  const newClasses = new Set(newRule.actionClasses);
  return existing.filter(
    (r) =>
      r.subsource === 'brain_reflection' &&
      r.supersededAt === null &&
      r.actionClasses.some((c) => newClasses.has(c)),
  );
}

// --- Main entry point ------------------------------------------------------

export async function reflectAndEmit(
  input: ReflectionInput = {},
): Promise<ReflectionResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const windowDays = input.windowDays ?? 7;
  const maxRules = Math.max(0, Math.min(10, input.maxRules ?? 5));
  const llm = input.llm ?? defaultReflectionLlmCaller;
  const brainDb = input.brainDb ?? getBrainDb();
  const windowStartIso = new Date(
    Date.parse(nowIso) - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result: ReflectionResult = {
    windowStartIso,
    windowEndIso: nowIso,
    emittedRuleIds: [],
    supersededRuleIds: [],
  };

  if (maxRules === 0) {
    result.skipReason = 'maxRules=0';
    return result;
  }

  const signals = collectSignals(brainDb, windowStartIso, nowIso);
  if (!hasUsableSignals(signals)) {
    result.skipReason = 'no signals in window';
    return result;
  }

  let emitted: EmittedRule[];
  try {
    const out = await llm(buildReflectionPrompt(signals, maxRules));
    emitted = (out.rules ?? []).filter(
      (r) =>
        typeof r.rule === 'string' &&
        r.rule.trim().length > 0 &&
        Array.isArray(r.evidence) &&
        r.evidence.length >= 2 &&
        Array.isArray(r.actionClasses) &&
        // Each action class must be a non-empty string. An LLM-emitted
        // [42, ""] would otherwise serialize cleanly through addRule and
        // then trigger pathological matches in queryRules' `LIKE '%%'`
        // pattern (matches every rule).
        r.actionClasses.every(
          (c) => typeof c === 'string' && c.trim().length > 0,
        ) &&
        typeof r.confidence === 'number' &&
        r.confidence >= 0 &&
        r.confidence <= 1,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'procedural-reflect: LLM call failed',
    );
    result.skipReason = 'llm_error';
    return result;
  }

  if (emitted.length === 0) {
    result.skipReason = 'no rules emitted';
    return result;
  }

  // Snapshot of active brain-reflection rules at the start of this run.
  // We mutate the snapshot as we supersede, so a later emitted rule in the
  // same run never matches a rule that an earlier one already retired.
  let existing = listActiveRules({ subsource: 'brain_reflection', limit: 50 });
  for (const rule of emitted.slice(0, maxRules)) {
    const supers = findSupersedeCandidates(rule, existing);
    // Insert new rule first so we have its id to point at; then mark olds.
    // Pick the first candidate as the "supersedes" link; if multiple, the
    // rest are still marked superseded but their supersedes_id chain is
    // not transitively reconstructed (not needed for surface in v1).
    const supersedesId = supers[0]?.id ?? null;
    const newId = addRule({
      rule: rule.rule.trim(),
      source: 'agent_reported',
      subsource: 'brain_reflection',
      actionClasses:
        rule.actionClasses.length > 0 ? rule.actionClasses : ['general'],
      groupId: null,
      confidence: rule.confidence,
      evidenceCount: rule.evidence.length,
      supersedesId,
    });
    result.emittedRuleIds.push(newId);
    if (supers.length > 0) {
      const supersededIds = new Set(supers.map((s) => s.id));
      for (const old of supers) {
        markSuperseded(old.id, nowIso);
        result.supersededRuleIds.push(old.id);
      }
      // Remove the rules we just retired from the snapshot so the next
      // emitted rule in this run can't claim them again.
      existing = existing.filter((r) => !supersededIds.has(r.id));
    }
  }

  logger.info(
    {
      emitted: result.emittedRuleIds.length,
      superseded: result.supersededRuleIds.length,
    },
    'procedural-reflect: completed',
  );
  return result;
}

// --- Scheduler -------------------------------------------------------------

export interface ReflectionScheduleOptions {
  /** How often to wake up and check the cadence window. Default 1h. */
  checkIntervalMs?: number;
  /** Inject for tests. */
  nowFn?: () => Date;
  /**
   * Cap on Haiku calls per run when reflection actually fires. Bounded LLM
   * cost — defaults to 5 (matches the design doc's per-window rule cap).
   */
  maxRules?: number;
}

const REFLECT_STATE_KEY = 'last_brain_reflection';
const REFLECT_DEBOUNCE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days
const REFLECT_TIMEOUT_MS = 60 * 1000;

/**
 * Fires `reflectAndEmit()` once per week (Sunday 09:00–11:59 local), with a
 * 6-day debounce stored in `system_state.last_brain_reflection` so a restart
 * inside the window still delivers without double-firing.
 *
 * Independent of the digest scheduler — failure here does NOT block the
 * digest. The digest pulls brain-reflection rules from `learned_rules` at
 * format time regardless of whether reflection ran this cycle.
 *
 * Lazy imports for getSystemState / setSystemState (via getBrainDb so we
 * don't widen this module's import surface) keep the unit tests for
 * collectSignals / buildReflectionPrompt fast.
 */
export function startReflectionSchedule(
  opts: ReflectionScheduleOptions = {},
): () => void {
  const checkIntervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
  const nowFn = opts.nowFn ?? (() => new Date());
  const maxRules = opts.maxRules ?? 5;

  const getLast = (): number | null => {
    try {
      const db = getBrainDb();
      const row = db
        .prepare(`SELECT value FROM system_state WHERE key = ?`)
        .get(REFLECT_STATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      const ms = Date.parse(row.value);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  };

  const setLast = (iso: string): void => {
    try {
      const db = getBrainDb();
      db.prepare(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(REFLECT_STATE_KEY, iso, iso);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'procedural-reflect: failed to record last-fire timestamp',
      );
    }
  };

  // In-process re-entrancy guard. Without this, the on-startup `tick()` and
  // the first interval tick can both fire inside the Sunday window before
  // the on-disk debounce stamp has been written (the stamp now lands on
  // success only). Restart double-fire across processes is still bounded
  // by the disk debounce.
  let running = false;

  const tick = async (): Promise<void> => {
    const now = nowFn();
    const inWindow =
      now.getDay() === 0 && now.getHours() >= 9 && now.getHours() < 12;
    if (!inWindow) return;
    if (running) return;
    const last = getLast();
    if (last !== null && now.getTime() - last < REFLECT_DEBOUNCE_MS) return;

    running = true;
    const nowIso = now.toISOString();
    try {
      const result = await Promise.race([
        reflectAndEmit({ nowIso, maxRules }),
        new Promise<ReflectionResult>((_, reject) =>
          setTimeout(
            () => reject(new Error('reflection timed out')),
            REFLECT_TIMEOUT_MS,
          ),
        ),
      ]);
      // Only stamp the on-disk debounce on success — a failed run should
      // be retryable on the next hourly tick within the window. If
      // reflection emitted nothing because there were no signals, we still
      // count that as success: no point retrying when the inputs were
      // empty.
      setLast(nowIso);
      if (result.skipReason) {
        logger.info(
          { skipReason: result.skipReason },
          'procedural-reflect: scheduled run skipped',
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'procedural-reflect: scheduled run failed',
      );
    } finally {
      running = false;
    }
  };

  // Fire once at startup if we're inside the window (mirrors digest behavior).
  void tick();
  const handle = setInterval(() => void tick(), checkIntervalMs);
  return () => clearInterval(handle);
}
