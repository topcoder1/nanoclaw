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
  startDigestSchedule,
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
    expect(s.newProceduralRules).toEqual([]);
    expect(s.deadLetterCount).toBe(0);
    expect(s.staleUnprocessedCount).toBe(0);
  });

  it('omits the procedural-rules section when none were emitted', () => {
    const md = formatWeeklyDigestMarkdown(
      collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' }),
    );
    expect(md).not.toContain('procedural rules');
    expect(md).not.toContain('📐');
  });

  it('renders the procedural-rules section when rules are present', () => {
    const md = formatWeeklyDigestMarkdown({
      windowStartIso: '2026-04-20T12:00:00Z',
      windowEndIso: '2026-04-27T12:00:00Z',
      cadence: 'weekly',
      costWeekUsd: 0,
      costMonthUsd: 0,
      rolling7dAvgUsd: 0,
      ingestedRawEvents: 0,
      processedRawEvents: 0,
      topRetrievedKus: [],
      newEntityCount: 0,
      newProceduralRules: [
        {
          id: 'r-new',
          rule: 'When user asks about pricing, link the rate sheet',
          actionClasses: ['email.draft'],
          confidence: 0.78,
          supersedesId: 'r-old-12345678abcdef',
        },
      ],
      deadLetterCount: 0,
      staleUnprocessedCount: 0,
      emailsSeenByBrain24h: 0,
      lastIngestEventAt: null,
      firedTriggers: [],
      reconcileStats: null,
    });
    expect(md).toContain('📐');
    expect(md).toContain('procedural rules');
    expect(md).toContain('rate sheet');
    expect(md).toContain('email.draft');
    expect(md).toContain('conf 0.78');
    // Supersession marker shows the first 8 chars of the old rule id.
    expect(md).toContain('supersedes');
    expect(md).toContain('r-old-12');
  });

  it('aggregates cost, ingestion, top-retrieved, new entities correctly', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const inWindow = '2026-04-20T10:00:00Z';
    const outsideWindow = '2026-04-10T10:00:00Z';

    // Cost rows
    logCost({
      provider: 'anthropic',
      operation: 'extract',
      units: 1,
      costUsd: 0.05,
      nowIso: inWindow,
    });
    logCost({
      provider: 'anthropic',
      operation: 'extract',
      units: 1,
      costUsd: 0.99,
      nowIso: outsideWindow,
    });

    // Raw events inside + outside window
    const rawStmt = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at, retry_count)
       VALUES (?, 'email', ?, ?, ?, ?, ?)`,
    );
    rawStmt.run(newId(), 'thr-a', Buffer.from('{}'), inWindow, inWindow, 0);
    rawStmt.run(newId(), 'thr-b', Buffer.from('{}'), inWindow, null, 3);
    rawStmt.run(
      newId(),
      'thr-out',
      Buffer.from('{}'),
      outsideWindow,
      outsideWindow,
      0,
    );

    // KUs — in-window last_accessed_at
    const kuStmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    );
    kuStmt.run(newId(), 'hot topic A', inWindow, inWindow, inWindow, 9);
    kuStmt.run(newId(), 'hot topic B', inWindow, inWindow, inWindow, 5);
    kuStmt.run(
      newId(),
      'old forgotten',
      outsideWindow,
      outsideWindow,
      outsideWindow,
      20,
    );

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
    expect(
      (s.reconcileStats as { sqliteLiveCount: number }).sqliteLiveCount,
    ).toBe(42);
  });

  it('formats Markdown with all sections', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const kuStmt = db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    );
    kuStmt.run(
      newId(),
      'alpha topic',
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      3,
    );
    const md = formatWeeklyDigestMarkdown(collectWeeklyDigest({ nowIso: now }));
    expect(md).toMatch(/Brain weekly digest/);
    expect(md).toMatch(/Cost:/);
    expect(md).toMatch(/Ingestion \(last 7d\):/);
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

  it('escapes Markdown special chars in user-derived KU text', () => {
    const db = getBrainDb();
    const nasty = 'pricing *very* [urgent]_';
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    ).run(
      newId(),
      nasty,
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      7,
    );
    const md = formatWeeklyDigestMarkdown(
      collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' }),
    );
    // Raw special chars that would have broken the surrounding markdown
    // are gone inside the KU line:
    const topKuLine = md.split('\n').find((line) => line.includes('pricing'));
    expect(topKuLine).toBeDefined();
    expect(topKuLine).toContain('\\*very\\*');
    // Escape covers the formatting triggers _ * ` [ ] ( ) — both opening
    // and closing brackets are escaped now (regression fix in #29 review:
    // unescaped ] would break Markdown links when subjects are
    // interpolated as link text).
    expect(topKuLine).toContain('\\[urgent\\]');
    expect(topKuLine).toContain('\\_');
    // And raw unescaped forms must not appear in that line.
    expect(topKuLine).not.toMatch(/[^\\]\*very\*/);
  });

  it('daily cadence uses a 24h window, not 7d', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    // 6h ago — inside 24h window
    const inDaily = '2026-04-23T06:00:00Z';
    // 3d ago — outside 24h window but inside 7d window
    const outsideDaily = '2026-04-20T12:00:00Z';

    const rawStmt = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at, retry_count)
       VALUES (?, 'email', ?, ?, ?, ?, ?)`,
    );
    rawStmt.run(newId(), 'thr-new', Buffer.from('{}'), inDaily, inDaily, 0);
    rawStmt.run(
      newId(),
      'thr-old',
      Buffer.from('{}'),
      outsideDaily,
      outsideDaily,
      0,
    );

    const entStmt = db.prepare(
      `INSERT INTO entities (entity_id, entity_type, created_at, updated_at)
       VALUES (?, 'person', ?, ?)`,
    );
    entStmt.run(newId(), inDaily, inDaily);
    entStmt.run(newId(), outsideDaily, outsideDaily);

    const daily = collectWeeklyDigest({ nowIso: now, cadence: 'daily' });
    expect(daily.cadence).toBe('daily');
    expect(daily.ingestedRawEvents).toBe(1); // only thr-new
    expect(daily.newEntityCount).toBe(1);

    // Same DB, weekly cadence — picks up both.
    const weekly = collectWeeklyDigest({ nowIso: now, cadence: 'weekly' });
    expect(weekly.ingestedRawEvents).toBe(2);
    expect(weekly.newEntityCount).toBe(2);
  });

  it('daily cadence renders daily-specific labels in Markdown', () => {
    const s = collectWeeklyDigest({
      nowIso: '2026-04-23T12:00:00Z',
      cadence: 'daily',
    });
    const md = formatWeeklyDigestMarkdown(s);
    expect(md).toMatch(/Brain daily digest/);
    expect(md).toMatch(/\*Cost:\*\s*24h/);
    expect(md).toMatch(/Ingestion \(last 24h\)/);
    expect(md).toMatch(/New entities \(last 24h\)/);
    // Weekly label should not appear in daily output.
    expect(md).not.toMatch(/Brain weekly digest/);
    expect(md).not.toMatch(/last 7d/);
  });

  it('weekly cadence (default) still renders weekly labels', () => {
    const s = collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' });
    const md = formatWeeklyDigestMarkdown(s);
    expect(md).toMatch(/Brain weekly digest/);
    expect(md).toMatch(/\*Cost:\*\s*week/);
    expect(md).toMatch(/Ingestion \(last 7d\)/);
  });

  it('daily digest missed section uses review-prompt label', () => {
    const db = getBrainDb();
    const now = '2026-04-23T12:00:00Z';
    const old = '2026-04-20T00:00:00Z'; // > 24h old
    db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES (?, 'email', ?, ?, ?, NULL)`,
    ).run(newId(), 'thr-stale-daily', Buffer.from('{}'), old);
    const md = formatWeeklyDigestMarkdown(
      collectWeeklyDigest({ nowIso: now, cadence: 'daily' }),
    );
    expect(md).toMatch(/Yesterday's low-access KUs — review\?/);
    expect(md).not.toMatch(/⚠️ \*Missed:\*/);
  });

  it('startDigestSchedule(daily) fires every day and debounces < 22h', () => {
    const deliveries: string[] = [];
    // Monday 2026-04-27 09:30 local (weekly would skip — not Sunday).
    const monMorning = new Date(2026, 3, 27, 9, 30, 0);
    const stop1 = startDigestSchedule(
      'daily',
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => monMorning, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop1();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]).toMatch(/Brain daily digest/);
    expect(getSystemState('last_daily_digest')).not.toBeNull();

    // Same day, 11:45 — still in window, debounce holds.
    const monLate = new Date(2026, 3, 27, 11, 45, 0);
    const stop2 = startDigestSchedule(
      'daily',
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => monLate, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop2();
    expect(deliveries.length).toBe(1);

    // Next day 10:00 — new cycle; clear debounce to >22h ago.
    setSystemState(
      'last_daily_digest',
      new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    );
    const tueMorning = new Date(2026, 3, 28, 10, 0, 0);
    const stop3 = startDigestSchedule(
      'daily',
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => tueMorning, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop3();
    expect(deliveries.length).toBe(2);
  });

  it('startDigestSchedule(daily) stays silent outside 9-12 window', () => {
    const deliveries: string[] = [];
    // 13:00 — past window
    const afternoon = new Date(2026, 3, 27, 13, 0, 0);
    const stop = startDigestSchedule(
      'daily',
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => afternoon, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop();
    expect(deliveries.length).toBe(0);
  });

  it('startWeeklyDigestSchedule remains backward-compatible with cadence=weekly', () => {
    const deliveries: string[] = [];
    // Sunday 2026-04-26 10:00 local
    const sunMorning = new Date(2026, 3, 26, 10, 0, 0);
    const stop = startWeeklyDigestSchedule(
      (md) => {
        deliveries.push(md);
      },
      { nowFn: () => sunMorning, checkIntervalMs: 60 * 60 * 1000 },
    );
    stop();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]).toMatch(/Brain weekly digest/);
    expect(getSystemState('last_weekly_digest')).not.toBeNull();
  });

  it('truncates long KU text at 120 chars in the formatted output', () => {
    const db = getBrainDb();
    const long = 'x'.repeat(500);
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, account, confidence, valid_from, recorded_at, last_accessed_at, access_count)
       VALUES (?, ?, 'email', 'work', 1.0, ?, ?, ?, ?)`,
    ).run(
      newId(),
      long,
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      '2026-04-22T10:00:00Z',
      1,
    );
    const md = formatWeeklyDigestMarkdown(
      collectWeeklyDigest({ nowIso: '2026-04-23T12:00:00Z' }),
    );
    expect(md).toMatch(/…/);
    expect(md.length).toBeLessThan(2000);
  });
});
