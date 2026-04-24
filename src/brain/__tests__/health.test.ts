import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  getBrainHealthReport,
  handleBrainHealthCommand,
  type BrainHealthReport,
} from '../health.js';
import {
  logCost,
  _resetLatencyBuffer,
  recordRetrievalLatencyMs,
} from '../metrics.js';
import { ensureLegacyCutoverTombstone } from '../drop-legacy-tombstone.js';
import { newId } from '../ulid.js';

describe('brain/health', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-health-'));
    _resetLatencyBuffer();
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a zero-state report on a fresh DB', () => {
    const r = getBrainHealthReport('2026-04-23T10:00:00Z');
    expect(r.counts.kuTotal).toBe(0);
    expect(r.cost.todayUsd).toBe(0);
    expect(r.cost.monthToDateUsd).toBe(0);
    expect(r.latency.count).toBe(0);
    expect(r.reconcile.lastRunAt).toBeNull();
    expect(r.legacy.cutoverAt).toBeNull();
    for (const t of r.reEvalTriggers) expect(t.fired).toBe(false);
  });

  it('populates counts, cost, latency, and triggers correctly', () => {
    const db = getBrainDb();
    const now = '2026-04-23T10:00:00Z';
    const stmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at)
       VALUES (?, 'k', 'email', 'work', 1.0, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) stmt.run(newId(), now, now);

    logCost({
      provider: 'anthropic',
      operation: 'extract',
      units: 1,
      costUsd: 0.05,
      nowIso: now,
    });
    for (let i = 0; i < 20; i++) recordRetrievalLatencyMs(i + 1);
    ensureLegacyCutoverTombstone(now);

    const r = getBrainHealthReport('2026-04-23T10:00:00Z');
    expect(r.counts.kuLive).toBe(5);
    expect(r.cost.todayUsd).toBeCloseTo(0.05, 5);
    expect(r.cost.monthToDateUsd).toBeCloseTo(0.05, 5);
    expect(r.latency.count).toBe(20);
    expect(r.legacy.cutoverAt).toBe(now);
    expect(r.legacy.cutoverDue).toBe(false);
  });

  it('fires legacy_cutover trigger once 30d have elapsed', () => {
    const setAt = '2026-03-01T00:00:00Z';
    ensureLegacyCutoverTombstone(setAt);
    const r = getBrainHealthReport('2026-04-23T00:00:00Z');
    const t = r.reEvalTriggers.find((x) => x.id === 'legacy_cutover');
    expect(t?.fired).toBe(true);
  });

  it('formats a Telegram Markdown report with sections', () => {
    const fake = (): BrainHealthReport => ({
      generatedAt: '2026-04-23T10:00:00Z',
      counts: {
        kuTotal: 5,
        kuLive: 4,
        kuSuperseded: 1,
        kuNeedsReview: 0,
        entityTotal: 2,
        rawEventsTotal: 10,
        rawEventsUnprocessed: 2,
        deadLetterCandidates: 0,
      },
      cost: {
        todayUsd: 0.05,
        rolling7dAvgUsd: 0.03,
        todayRatioOfAvg: 0.05 / 0.03,
        monthToDateUsd: 1.0,
        monthlyBudgetUsd: 10,
        monthlyBudgetUtilization: 0.1,
      },
      latency: { count: 20, p50: 10, p95: 19, p99: 20 },
      reconcile: {
        lastRunAt: '2026-04-23T00:00:00Z',
        lastStats: null,
        driftThreshold: 0.01,
      },
      legacy: { cutoverAt: '2026-04-23T00:00:00Z', cutoverDue: false },
      ingest: {
        emailsSeenByBrain24h: 7,
        lastIngestEventAt: '2026-04-23T09:59:00Z',
      },
      reEvalTriggers: [
        {
          id: 'monthly_budget',
          description: 'MTD > $10',
          current: 1,
          threshold: 10,
          fired: false,
        },
      ],
    });
    const msg = handleBrainHealthCommand({ reportFn: fake });
    expect(msg).toMatch(/Brain health/);
    expect(msg).toMatch(/Counts:/);
    expect(msg).toMatch(/Cost:/);
    expect(msg).toMatch(/Latency/);
    expect(msg).toMatch(/Reconcile:/);
    expect(msg).toMatch(/Legacy cutover:/);
    expect(msg).toMatch(/SSE ingest canary/);
    expect(msg).toContain('emails seen (24h)=7');
    expect(msg).toMatch(/Re-eval triggers:\*? none fired/);
  });

  it('lists fired triggers in the formatted output', () => {
    const fake = (): BrainHealthReport => ({
      generatedAt: 'x',
      counts: {
        kuTotal: 0,
        kuLive: 0,
        kuSuperseded: 0,
        kuNeedsReview: 0,
        entityTotal: 0,
        rawEventsTotal: 0,
        rawEventsUnprocessed: 0,
        deadLetterCandidates: 0,
      },
      cost: {
        todayUsd: 0,
        rolling7dAvgUsd: 0,
        todayRatioOfAvg: 0,
        monthToDateUsd: 12,
        monthlyBudgetUsd: 10,
        monthlyBudgetUtilization: 1.2,
      },
      latency: { count: 0, p50: 0, p95: 0, p99: 0 },
      reconcile: { lastRunAt: null, lastStats: null, driftThreshold: 0.01 },
      legacy: { cutoverAt: null, cutoverDue: false },
      ingest: { emailsSeenByBrain24h: 0, lastIngestEventAt: null },
      reEvalTriggers: [
        {
          id: 'monthly_budget',
          description: 'MTD > $10 → re-evaluate LLM budget',
          current: 12,
          threshold: 10,
          fired: true,
        },
      ],
    });
    const msg = handleBrainHealthCommand({ reportFn: fake });
    expect(msg).toMatch(/Re-eval triggers fired/);
    expect(msg).toMatch(/monthly_budget/);
  });

  it('report includes SSE→brain ingest canary', async () => {
    // Fresh DB → zero counter, no last-seen.
    const r0 = getBrainHealthReport('2026-04-23T10:00:00Z');
    expect(r0.ingest.emailsSeenByBrain24h).toBe(0);
    expect(r0.ingest.lastIngestEventAt).toBeNull();

    // Inject two canary bumps + last-seen.
    const { incrementSystemCounter, setSystemState } = await import(
      '../metrics.js'
    );
    incrementSystemCounter(
      'emails_seen_by_brain_24h',
      '2026-04-23T09:30:00Z',
    );
    incrementSystemCounter(
      'emails_seen_by_brain_24h',
      '2026-04-23T09:45:00Z',
    );
    setSystemState(
      'last_ingest_event_at',
      '2026-04-23T09:45:00Z',
      '2026-04-23T09:45:00Z',
    );

    const r1 = getBrainHealthReport('2026-04-23T10:00:00Z');
    expect(r1.ingest.emailsSeenByBrain24h).toBe(2);
    expect(r1.ingest.lastIngestEventAt).toBe('2026-04-23T09:45:00Z');
  });
});
