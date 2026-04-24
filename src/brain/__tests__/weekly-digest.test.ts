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
  collectWeeklyDigest,
  formatWeeklyDigestMarkdown,
  startWeeklyDigestSchedule,
} from '../weekly-digest.js';
import { getSystemState, logCost, setSystemState } from '../metrics.js';
import { newId } from '../ulid.js';

describe('brain/weekly-digest', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-digest-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero-state digest on empty DB', () => {
    const s = collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' });
    expect(s.costWeekUsd).toBe(0);
    expect(s.ingestedRawEvents).toBe(0);
    expect(s.topRetrievedKus).toEqual([]);
    expect(s.newEntityCount).toBe(0);
    expect(s.deadLetterCount).toBe(0);
    expect(s.staleUnprocessedCount).toBe(0);
  });

  it('aggregates cost, ingestion, top-retrieved, new entities correctly', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const inWindow = '2026-04-20T10:00:00Z';
    const outsideWindow = '2026-04-10T10:00:00Z';

    // Cost rows
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 0.05, nowIso: inWindow });
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 0.99, nowIso: outsideWindow });

    // Raw events inside + outside window
    const rawStmt = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at, retry_count)
       VALUES (?, 'email', ?, ?, ?, ?, ?)`,
    );
    rawStmt.run(newId(), 'thr-a', Buffer.from('{}'), inWindow, inWindow, 0);
    rawStmt.run(newId(), 'thr-b', Buffer.from('{}'), inWindow, null, 3);
    rawStmt.run(newId(), 'thr-out', Buffer.from('{}'), outsideWindow, outsideWindow, 0);

    // KUs — in-window last_accessed_at
    const kuStmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    );
    kuStmt.run(newId(), 'hot topic A', inWindow, inWindow, inWindow, 9);
    kuStmt.run(newId(), 'hot topic B', inWindow, inWindow, inWindow, 5);
    kuStmt.run(newId(), 'old forgotten', outsideWindow, outsideWindow, outsideWindow, 20);

    // Entities
    const entStmt = db.prepare(
      `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES (?, 'person', ?, ?)`,
    );
    entStmt.run(newId(), inWindow, inWindow);
    entStmt.run(newId(), outsideWindow, outsideWindow);

    const s = collectWeeklyDigest({ nowIso: now });
    expect(s.costWeekUsd).toBeCloseTo(0.05, 5);
    expect(s.ingestedRawEvents).toBe(2);
    expect(s.processedRawEvents).toBe(1);
    expect(s.topRetrievedKus).toHaveLength(2);
    expect(s.topRetrievedKus[0].text).toBe('hot topic A'); // highest access_count
    expect(s.newEntityCount).toBe(1);
    // dead-letter count is the global count (retry_count >= 3); includes thr-b
    expect(s.deadLetterCount).toBe(1);
  });

  it('flags stale unprocessed rows older than 24h', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const old = '2026-04-20T00:00:00Z'; // > 24h old
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES (?, 'email', ?, ?, ?, NULL)`,
    ).run(newId(), 'thr-stale', Buffer.from('{}'), old);
    const s = collectWeeklyDigest({ nowIso: now });
    expect(s.staleUnprocessedCount).toBe(1);
  });

  it('includes reconcile stats from system_state', () => {
    setSystemState(
      'last_qdrant_reconcile_stats',
      JSON.stringify({
        ranAt: '2026-04-23T00:00:00Z',
        sqliteLiveCount: 42,
        qdrantPointCount: 40,
        missingInQdrant: ['a', 'b'],
        orphanInQdrant: [],
        driftRatio: 0.048,
        qdrantReachable: true,
      }),
      '2026-04-23T00:00:00Z',
    );
    const s = collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' });
    expect((s.reconcileStats as { sqliteLiveCount: number }).sqliteLiveCount).toBe(42);
  });

  it('formats Markdown with all sections', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const kuStmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    );
    kuStmt.run(newId(), 'alpha topic', '2026-04-22T10:00:00Z', '2026-04-22T10:00:00Z', '2026-04-22T10:00:00Z', 3);
    const md = formatWeeklyDigestMarkdown(collectWeeklyDigest({ nowIso: now }));
    expect(md).toMatch(/Brain weekly digest/);
    expect(md).toMatch(/Cost:/);
    expect(md).toMatch(/Ingestion:/);
    expect(md).toMatch(/Top retrieved KUs/);
    expect(md).toMatch(/New entities/);
    expect(md).toMatch(/Last reconcile/);
    expect(md).toMatch(/alpha topic/);
  });

  it('startWeeklyDigestSchedule fires at Sunday 09:30, debounces, and stays silent on Monday', () => {
    const deliveries: string[] = [];
    // Sunday 2026-04-26 09:30 local.
    const sunMorning = new Date(2026, 3, 26, 9, 30, 0);
    const stop1 = startWeeklyDigestSchedule(
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => sunMorning, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop1();
    expect(deliveries.length).toBe(1);
    const first = getSystemState('last_weekly_digest');
    expect(first).not.toBeNull();

    // Same Sunday, 11:45 — inside the widened window but debounce holds.
    const sunLate = new Date(2026, 3, 26, 11, 45, 0);
    const stop2 = startWeeklyDigestSchedule(
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => sunLate, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop2();
    expect(deliveries.length).toBe(1);

    // Monday 10:00 — outside the Sunday window; no fire even if debounce
    // were stale.
    const monMorning = new Date(2026, 3, 27, 10, 0, 0);
    setSystemState(
      'last_weekly_digest',
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    );
    const stop3 = startWeeklyDigestSchedule(
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => monMorning, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop3();
    expect(deliveries.length).toBe(1);
  });

  it('truncates long KU text at 120 chars in the formatted output', () => {
    const db = getBrainDb();
    const long = 'x'.repeat(500);
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    ).run(newId(), long, '2026-04-22T10:00:00Z', '2026-04-22T10:00:00Z', '2026-04-22T10:00:00Z', 1);
    const md = formatWeeklyDigestMarkdown(
      collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' }),
    );
    expect(md).toMatch(/…/);
    expect(md.length).toBeLessThan(2000);
  });
});
