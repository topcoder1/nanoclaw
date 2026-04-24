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
  _resetLatencyBuffer,
  getBrainCounts,
  getDailyCostUsd,
  getLatencyStats,
  getMonthlyCostUsd,
  getRollingDailyCostUsd,
  getSystemState,
  logCost,
  recordRetrievalLatencyMs,
  setSystemState,
} from '../metrics.js';
import { newId } from '../ulid.js';

describe('brain/metrics', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-metrics-'));
    _resetLatencyBuffer();
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('cost logging', () => {
    it('records per-day cost and totals correctly', () => {
      logCost({ provider: 'anthropic', operation: 'extract', units: 100, costUsd: 0.01, nowIso: '2026-04-23T10:00:00Z' });
      logCost({ provider: 'anthropic', operation: 'extract', units: 200, costUsd: 0.02, nowIso: '2026-04-23T11:00:00Z' });
      logCost({ provider: 'local', operation: 'embed', units: 50, costUsd: 0, nowIso: '2026-04-22T10:00:00Z' });
      expect(getDailyCostUsd('2026-04-23')).toBeCloseTo(0.03, 5);
      expect(getDailyCostUsd('2026-04-22')).toBe(0);
      expect(getDailyCostUsd('2026-04-20')).toBe(0);
    });

    it('computes rolling 7d avg, excluding today', () => {
      for (let i = 1; i <= 7; i++) {
        const d = new Date(Date.UTC(2026, 3, 23 - i)).toISOString();
        logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 0.7, nowIso: d });
      }
      // Today (23rd) doesn't count.
      logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 5, nowIso: '2026-04-23T10:00:00Z' });
      const avg = getRollingDailyCostUsd('2026-04-23', 7);
      expect(avg).toBeCloseTo(0.7, 5); // 7 × 0.7 / 7
    });

    it('returns 0 avg when no history exists', () => {
      expect(getRollingDailyCostUsd('2026-04-23', 7)).toBe(0);
    });

    it('sums monthly cost', () => {
      logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 1.5, nowIso: '2026-04-01T00:00:00Z' });
      logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 2.5, nowIso: '2026-04-23T00:00:00Z' });
      logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 9, nowIso: '2026-03-15T00:00:00Z' });
      expect(getMonthlyCostUsd('2026-04')).toBeCloseTo(4.0, 5);
      expect(getMonthlyCostUsd('2026-03')).toBeCloseTo(9, 5);
    });
  });

  describe('system_state', () => {
    it('upserts key/value pairs', () => {
      setSystemState('last_run', '2026-04-23T10:00:00Z', '2026-04-23T10:00:00Z');
      setSystemState('last_run', '2026-04-23T11:00:00Z', '2026-04-23T11:00:00Z');
      const row = getSystemState('last_run');
      expect(row?.value).toBe('2026-04-23T11:00:00Z');
    });

    it('returns null for missing keys', () => {
      getBrainDb(); // open
      expect(getSystemState('nope')).toBeNull();
    });
  });

  describe('latency ring buffer', () => {
    it('records and reports p50/p95/p99', () => {
      for (let i = 1; i <= 100; i++) {
        recordRetrievalLatencyMs(i);
      }
      const s = getLatencyStats();
      expect(s.count).toBe(100);
      expect(s.p50).toBeGreaterThanOrEqual(50);
      expect(s.p95).toBeGreaterThanOrEqual(95);
      expect(s.p99).toBeGreaterThanOrEqual(99);
    });

    it('returns zeros when empty', () => {
      const s = getLatencyStats();
      expect(s.count).toBe(0);
      expect(s.p50).toBe(0);
    });

    it('ignores NaN/negative values', () => {
      recordRetrievalLatencyMs(Number.NaN);
      recordRetrievalLatencyMs(-5);
      expect(getLatencyStats().count).toBe(0);
    });

    it('caps at 1000 entries (ring buffer)', () => {
      for (let i = 0; i < 1500; i++) recordRetrievalLatencyMs(i);
      expect(getLatencyStats().count).toBe(1000);
    });
  });

  describe('getBrainCounts', () => {
    it('returns zeros on empty db', () => {
      const c = getBrainCounts();
      expect(c.kuTotal).toBe(0);
      expect(c.kuLive).toBe(0);
      expect(c.entityTotal).toBe(0);
      expect(c.rawEventsTotal).toBe(0);
    });

    it('tallies live, superseded, review, dead-letter', () => {
      const db = getBrainDb();
      const now = '2026-04-23T10:00:00Z';
      const insertKu = db.prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, account, confidence, valid_from, recorded_at,
            superseded_at, needs_review)
         VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
      );
      insertKu.run(newId(), 'live', now, now, null, 0);
      insertKu.run(newId(), 'live-review', now, now, null, 1);
      insertKu.run(newId(), 'sup', now, now, now, 0);
      db.prepare(
        `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
         VALUES (?, 'person', ?, ?)`,
      ).run(newId(), now, now);
      db.prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at, retry_count)
         VALUES (?, 'email', ?, ?, ?, NULL, 0)`,
      ).run(newId(), 'thread-A', Buffer.from('{}'), now);
      db.prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at, retry_count)
         VALUES (?, 'email', ?, ?, ?, ?, 3)`,
      ).run(newId(), 'thread-B', Buffer.from('{}'), now, now);

      const c = getBrainCounts();
      expect(c.kuTotal).toBe(3);
      expect(c.kuLive).toBe(2);
      expect(c.kuSuperseded).toBe(1);
      expect(c.kuNeedsReview).toBe(1);
      expect(c.entityTotal).toBe(1);
      expect(c.rawEventsTotal).toBe(2);
      expect(c.rawEventsUnprocessed).toBe(1);
      expect(c.deadLetterCandidates).toBe(1);
    });
  });
});
