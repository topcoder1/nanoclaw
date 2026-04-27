/**
 * Two-tier claim extraction (v2 §7).
 *
 * Tier 1 — cheap rules (always runs):
 *   Regex patterns for URLs, emails, phones, dates, money, HubSpot/Gong IDs.
 *   Produces a signalScore in [0, 1] plus a list of Claims built from raw
 *   matches. Zero external dependencies.
 *
 * Tier 2 — Claude Haiku 4.5 (gated by signalScore > 0.3 AND daily budget):
 *   Sends a structured prompt, expects JSON with `claims[]`. Every call
 *   writes its measured cost into `cost_log`. If today's Anthropic
 *   `extract` spend >= $0.05, skips LLM tier and logs warn.
 *
 * Confidence gates are enforced at `extractPipeline` boundary:
 *   > 0.7        → KU stored, needs_review = 0
 *   0.4 – 0.7    → KU stored, needs_review = 1
 *   < 0.4        → dropped
 *
 * topic_key: SHA256 of normalize(topic_seed). normalize = lowercase, drop
 * ~50 common English stopwords, truncate to 128 chars. Deterministic.
 */

import crypto from 'crypto';

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { newId } from './ulid.js';

// --- Public types ---------------------------------------------------------

export interface Claim {
  text: string;
  topic_seed: string;
  topic_key: string; // sha256(normalize(topic_seed))
  entities_mentioned: EntityMention[];
  confidence: number; // 0–1
  needs_review: boolean;
  extracted_by: 'rules' | 'llm';
}

export interface EntityMention {
  kind:
    | 'email'
    | 'domain'
    | 'phone'
    | 'url'
    | 'hubspot_deal'
    | 'gong_call'
    | 'name'
    | 'other';
  value: string;
}

export interface CheapExtractionResult {
  signalScore: number;
  claims: Claim[];
}

export interface ExtractInput {
  text: string;
  subject?: string;
  sender?: string;
  /** Override today's date for tests. ISO YYYY-MM-DD. */
  today?: string;
  /** Source of this input. Affects signal-score gating and prompt. */
  mode?: 'email' | 'chat_single' | 'chat_window';
  /** For chat_window mode — speaker handles for the prompt. */
  participants?: string[];
}

// --- Regex library --------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const MONEY_RE =
  /\$\s?\d{1,3}(?:[,\d]{0,})(?:\.\d{1,2})?(?:[KMB])?\b|\b\d+\s?(?:USD|EUR|GBP)\b/gi;
const DATE_RE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s+\d{4})?)\b/gi;
const HUBSPOT_DEAL_RE = /\bdeal_\d+\b/gi;
const GONG_CALL_RE = /\bcall_\d+\b/gi;

// Stopwords for topic_key normalization (~50 common English words).
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'of',
  'on',
  'in',
  'at',
  'to',
  'for',
  'with',
  'by',
  'from',
  'as',
  'is',
  'was',
  'were',
  'be',
  'been',
  'being',
  'are',
  'am',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'my',
  'your',
  'our',
  'their',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'about',
  'into',
  'than',
  'then',
  'so',
  'also',
  'there',
  'here',
]);

// --- Normalization + topic key --------------------------------------------

export function normalizeTopic(seed: string): string {
  const lowered = seed.toLowerCase().trim();
  const words = lowered.split(/\W+/).filter((w) => w && !STOPWORDS.has(w));
  return words.join(' ').slice(0, 128);
}

export function topicKey(seed: string): string {
  const normalized = normalizeTopic(seed);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// --- Tier 1: cheap rules --------------------------------------------------

function collect(re: RegExp, text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex for safety with /g regex.
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

export function extractCheap(input: ExtractInput): CheapExtractionResult {
  const text = input.text ?? '';
  const subject = input.subject ?? '';
  const full = [subject, text].filter(Boolean).join('\n');

  const urls = collect(URL_RE, full);
  const emails = collect(EMAIL_RE, full);
  const phones = collect(PHONE_RE, full);
  const monies = collect(MONEY_RE, full);
  const dates = collect(DATE_RE, full);
  const deals = collect(HUBSPOT_DEAL_RE, full);
  const calls = collect(GONG_CALL_RE, full);

  const mentions: EntityMention[] = [
    ...urls.map<EntityMention>((v) => ({ kind: 'url', value: v })),
    ...emails.map<EntityMention>((v) => ({ kind: 'email', value: v })),
    ...phones.map<EntityMention>((v) => ({ kind: 'phone', value: v.trim() })),
    ...deals.map<EntityMention>((v) => ({ kind: 'hubspot_deal', value: v })),
    ...calls.map<EntityMention>((v) => ({ kind: 'gong_call', value: v })),
  ];

  // Signal scoring: a few meaningful patterns push us past 0.3 (the LLM gate).
  // Money mentions or deal/call IDs are strong signals; URLs/emails are soft.
  let score = 0;
  score += Math.min(monies.length, 2) * 0.25; // up to 0.5
  score += Math.min(deals.length, 2) * 0.3; // up to 0.6
  score += Math.min(calls.length, 2) * 0.3;
  score += Math.min(dates.length, 2) * 0.1;
  score += Math.min(urls.length, 3) * 0.05;
  score += Math.min(emails.length, 3) * 0.05;
  score = Math.min(1, score);

  const seed = subject || text.split(/[.!?]\s/)[0] || text.slice(0, 80) || '';
  const key = topicKey(seed);

  // Cheap-rules claim: one KU per event summarizing what we detected.
  // Cap at 0.8 so deterministic rule extraction lands above the v2 §7
  // 0.7 review threshold (> 0.7 → needs_review = 0) when multiple
  // signals are present. Cheap rules are deterministic so the LLM tier
  // can still supersede via consolidation in P2.
  const claims: Claim[] = [];
  if (mentions.length > 0 || monies.length > 0) {
    const ruleConf = Math.min(0.8, 0.5 + mentions.length * 0.02);
    claims.push({
      text: full.slice(0, 500),
      topic_seed: seed,
      topic_key: key,
      entities_mentioned: mentions,
      confidence: ruleConf,
      needs_review: false,
      extracted_by: 'rules',
    });
  }

  return { signalScore: score, claims };
}

// --- Tier 2: LLM extraction -----------------------------------------------

/**
 * Default daily Anthropic spend cap on `extract` operations. Set
 * deliberately low because the original snippet-only ingest produced
 * tiny prompts (~250 chars). With the full-body ingest, prompts grow to
 * 1–4K input tokens, so high-velocity inboxes can blow this in <40
 * emails. Override at deploy time via `BRAIN_LLM_DAILY_BUDGET_USD`.
 */
export const DAILY_LLM_BUDGET_USD = 0.05;

/**
 * Resolve today's effective LLM extract budget. Reads
 * `BRAIN_LLM_DAILY_BUDGET_USD` from the environment (parsed as float)
 * and falls back to `DAILY_LLM_BUDGET_USD` if unset, blank, non-numeric,
 * or non-positive.
 */
export function getDailyLlmBudgetUsd(): number {
  const raw = process.env.BRAIN_LLM_DAILY_BUDGET_USD;
  if (!raw) return DAILY_LLM_BUDGET_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DAILY_LLM_BUDGET_USD;
  return parsed;
}

/** Haiku 4.5 pricing — USD per 1M tokens, as of 2026-Q1. */
const HAIKU_INPUT_PER_MILLION = 1.0;
const HAIKU_OUTPUT_PER_MILLION = 5.0;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sum today's Anthropic `extract` spend from cost_log.
 */
export function getTodaysExtractSpend(
  db: Database.Database,
  day: string = todayStr(),
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log
       WHERE day = ? AND provider = 'anthropic' AND operation = 'extract'`,
    )
    .get(day) as { total: number };
  return row.total;
}

function writeCost(
  db: Database.Database,
  day: string,
  units: number,
  costUsd: number,
): void {
  db.prepare(
    `INSERT INTO cost_log (id, day, provider, operation, units, cost_usd, recorded_at)
     VALUES (?, ?, 'anthropic', 'extract', ?, ?, ?)`,
  ).run(newId(), day, units, costUsd, new Date().toISOString());
}

/**
 * Dependency-injected call to Claude Haiku 4.5. Tests pass a mock; production
 * wires up @ai-sdk/anthropic + generateText(). Kept injectable so the
 * extraction module has no hard dependency on a network call.
 */
export interface LlmCaller {
  (prompt: string): Promise<{
    claims: Array<{
      text: string;
      topic_seed: string;
      entities_mentioned?: Array<{ kind?: string; value: string }>;
      confidence: number;
    }>;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** Default LLM caller — lazy imports @ai-sdk/anthropic so tests can mock it. */
export const defaultLlmCaller: LlmCaller = async (prompt: string) => {
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
  // 4096 gives ~4× headroom over the prior 1024 cap, which truncated dense
  // emails (e.g. multi-SKU licensing quotes) mid-string and broke JSON.parse.
  // Claim JSON is compact; going higher buys marginal coverage for quadratic
  // cost if the model is ever run on a very long input.
  const result = await generateText({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 4096,
  });
  if (result.finishReason === 'length') {
    logger.warn(
      { textLen: result.text.length },
      'extractLLM output hit the max token cap — JSON likely truncated',
    );
  }
  // Strip Markdown fences if the model wrapped JSON.
  const raw = result.text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const parsed = JSON.parse(raw) as {
    claims: Array<{
      text: string;
      topic_seed: string;
      entities_mentioned?: Array<{ kind?: string; value: string }>;
      confidence: number;
    }>;
  };
  // ai-sdk v6 exposes usage on the result.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (result as any).usage ?? {};
  return {
    claims: parsed.claims ?? [],
    inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
    outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
  };
};

function buildPrompt(input: ExtractInput): string {
  if (input.mode === 'chat_single') {
    return [
      `You extract durable knowledge from a single chat message. Return JSON {claims: [...]}.`,
      `Each claim should be a self-contained factual statement, decision, or commitment.`,
      `Skip greetings, acknowledgements, and pure reactions.`,
      input.sender ? `Sender: ${input.sender}` : '',
      `Message: ${input.text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (input.mode === 'chat_window') {
    return [
      `You extract durable knowledge from a chat-conversation transcript. Return JSON {claims: [...]}.`,
      `Identify distinct factual statements, decisions, and commitments — one claim per topic.`,
      `Skip chitchat, greetings, and pure reactions. Use participant names where attribution matters.`,
      input.participants?.length
        ? `Participants: ${input.participants.join(', ')}`
        : '',
      `Transcript:\n${input.text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const parts = [
    'Extract factual claims from the message below.',
    'Return JSON: {"claims":[{"text":string,"topic_seed":string,"entities_mentioned":[{"kind":string,"value":string}],"confidence":number}]}.',
    'Each claim: a single atomic fact (5-25 words). Confidence 0-1 based on wording certainty.',
    'topic_seed: short phrase (2-6 words) that captures the claim subject.',
    'Output ONLY JSON — no prose, no markdown.',
    '',
    input.subject ? `Subject: ${input.subject}` : '',
    input.sender ? `From: ${input.sender}` : '',
    '',
    'Body:',
    input.text,
  ].filter(Boolean);
  return parts.join('\n');
}

function costForUsage(input: number, output: number): number {
  return (
    (input / 1_000_000) * HAIKU_INPUT_PER_MILLION +
    (output / 1_000_000) * HAIKU_OUTPUT_PER_MILLION
  );
}

export interface LlmExtractionOptions {
  llmCaller?: LlmCaller;
  db?: Database.Database;
  day?: string;
  signalScore: number;
}

/**
 * Run the LLM tier. Returns [] if gated out (signal too low or budget met)
 * or if the LLM errors. Writes cost on success.
 */
export async function extractLLM(
  input: ExtractInput,
  opts: LlmExtractionOptions,
): Promise<Claim[]> {
  const db = opts.db ?? getBrainDb();
  const day = opts.day ?? todayStr();
  const isChat = input.mode === 'chat_single' || input.mode === 'chat_window';
  if (!isChat && opts.signalScore <= 0.3) return [];
  const spent = getTodaysExtractSpend(db, day);
  const budget = getDailyLlmBudgetUsd();
  if (spent >= budget) {
    logger.warn(
      { spent, budget, day },
      'extractLLM: daily budget exceeded — skipping LLM tier',
    );
    return [];
  }

  const caller = opts.llmCaller ?? defaultLlmCaller;
  try {
    const prompt = buildPrompt(input);
    const response = await caller(prompt);
    const cost = costForUsage(response.inputTokens, response.outputTokens);
    writeCost(db, day, response.inputTokens + response.outputTokens, cost);
    return response.claims.map<Claim>((raw) => {
      const mentions: EntityMention[] = (raw.entities_mentioned ?? []).map(
        (m) => ({
          kind: (m.kind as EntityMention['kind']) ?? 'other',
          value: m.value,
        }),
      );
      return {
        text: raw.text,
        topic_seed: raw.topic_seed,
        topic_key: topicKey(raw.topic_seed),
        entities_mentioned: mentions,
        confidence: Math.max(0, Math.min(1, raw.confidence)),
        needs_review: raw.confidence >= 0.4 && raw.confidence <= 0.7,
        extracted_by: 'llm',
      };
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'extractLLM failed — falling back to cheap-rules only',
    );
    return [];
  }
}

// --- Top-level orchestration ----------------------------------------------

export interface PipelineOptions {
  llmCaller?: LlmCaller;
  db?: Database.Database;
  day?: string;
}

/**
 * End-to-end extraction. Runs cheap rules, then LLM if gated in, applies
 * confidence gates (<0.4 drop, 0.4–0.7 mark needs_review, >0.7 keep).
 */
export async function extractPipeline(
  input: ExtractInput,
  opts: PipelineOptions = {},
): Promise<Claim[]> {
  const cheap = extractCheap(input);
  const llmClaims = await extractLLM(input, {
    signalScore: cheap.signalScore,
    llmCaller: opts.llmCaller,
    db: opts.db,
    day: opts.day,
  });

  const combined = [...cheap.claims, ...llmClaims];
  const accepted: Claim[] = [];
  for (const c of combined) {
    if (c.confidence < 0.4) continue;
    accepted.push({
      ...c,
      needs_review: c.confidence < 0.7,
    });
  }
  return accepted;
}
