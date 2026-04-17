/**
 * Triage v1 configuration. Sourced from env vars with sane defaults.
 * See docs/superpowers/specs/2026-04-16-email-triage-pipeline-design.md.
 *
 * Values are read from both process.env AND the repo's `.env` file.
 * readEnvFile intentionally does not populate process.env (security), so we
 * look there manually. launchd does not inject .env keys into the process
 * environment either, so without this the flags silently default to off.
 */

import { readEnvFile } from '../env.js';

const TRIAGE_ENV_KEYS = [
  'TRIAGE_V1_ENABLED',
  'TRIAGE_SHADOW_MODE',
  'TRIAGE_MODEL_TIER1',
  'TRIAGE_MODEL_TIER2',
  'TRIAGE_MODEL_TIER3',
  'TRIAGE_ATTENTION_THRESHOLD',
  'TRIAGE_ARCHIVE_THRESHOLD',
  'TRIAGE_ESCALATE_LOW',
  'TRIAGE_ESCALATE_HIGH',
  'TRIAGE_SKIPLIST_PROMOTION_HITS',
  'TRIAGE_ATTENTION_REMIND_HOURS',
  'TRIAGE_NEGATIVE_EXAMPLES_RETAINED',
  'TRIAGE_POSITIVE_EXAMPLES_RETAINED',
  'TRIAGE_DAILY_COST_CAP_USD',
];

const envFile = readEnvFile(TRIAGE_ENV_KEYS);

function envRaw(key: string): string | undefined {
  return process.env[key] ?? envFile[key];
}

function envNum(key: string, fallback: number): number {
  const raw = envRaw(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = envRaw(key);
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function envStr(key: string, fallback: string): string {
  return envRaw(key) ?? fallback;
}

export const TRIAGE_DEFAULTS = {
  enabled: envBool('TRIAGE_V1_ENABLED', false),
  shadowMode: envBool('TRIAGE_SHADOW_MODE', true),

  models: {
    tier1: envStr('TRIAGE_MODEL_TIER1', 'claude-haiku-4-5-20251001'),
    tier2: envStr('TRIAGE_MODEL_TIER2', 'claude-sonnet-4-6'),
    tier3: envStr('TRIAGE_MODEL_TIER3', 'claude-opus-4-7'),
  },

  attentionThreshold: envNum('TRIAGE_ATTENTION_THRESHOLD', 0.7),
  archiveThreshold: envNum('TRIAGE_ARCHIVE_THRESHOLD', 0.8),
  escalateLow: envNum('TRIAGE_ESCALATE_LOW', 0.3),
  escalateHigh: envNum('TRIAGE_ESCALATE_HIGH', 0.75),

  skiplistPromotionHits: envNum('TRIAGE_SKIPLIST_PROMOTION_HITS', 5),
  attentionRemindHours: envNum('TRIAGE_ATTENTION_REMIND_HOURS', 4),
  negativeExamplesRetained: envNum('TRIAGE_NEGATIVE_EXAMPLES_RETAINED', 10),
  positiveExamplesRetained: envNum('TRIAGE_POSITIVE_EXAMPLES_RETAINED', 20),

  dailyCostCapUsd: envNum('TRIAGE_DAILY_COST_CAP_USD', 2.0),
} as const;

export type TriageDefaults = typeof TRIAGE_DEFAULTS;
