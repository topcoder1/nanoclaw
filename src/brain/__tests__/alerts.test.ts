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

import { _closeBrainDb } from '../db.js';
import { evaluateAlerts } from '../alerts.js';
import { logCost } from '../metrics.js';
import type { ReconcileReport } from '../reconcile.js';

describe('brain/alerts', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-alerts-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires cost_spike when today > 2× 7-day rolling avg', () => {
    // Seed 7 days of $1/day → avg = 1
    for (let i = 1; i <= 7; i++) {
      const d = new Date(Date.UTC(2026, 3, 23 - i)).toISOString();
      logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 1, nowIso: d });
    }
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 3, nowIso: '2026-04-23T10:00:00Z' });

    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:30:00Z' });
    const cat = fired.map((a) => a.category);
    expect(cat).toContain('cost_spike');
  });

  it('does NOT fire cost_spike when history is empty (avg=0)', () => {
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 5, nowIso: '2026-04-23T10:00:00Z' });
    const fired = evaluateAlerts({ nowIso: '2026-04-23T11:00:00Z' });
    expect(fired.map((a) => a.category)).not.toContain('cost_spike');
  });

  it('fires monthly_budget when MTD > $10', () => {
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 12, nowIso: '2026-04-23T10:00:00Z' });
    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:30:00Z' });
    expect(fired.map((a) => a.category)).toContain('monthly_budget');
  });

  it('fires qdrant_drift when driftRatio > 1% and reachable', () => {
    const recon: ReconcileReport = {
      ranAt: '2026-04-23T10:00:00Z',
      sqliteLiveCount: 100,
      qdrantPointCount: 97,
      missingInQdrant: ['a', 'b'],
      orphanInQdrant: ['c'],
      driftRatio: 0.03,
      qdrantReachable: true,
    };
    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z', reconcile: recon });
    expect(fired.map((a) => a.category)).toContain('qdrant_drift');
  });

  it('does NOT fire qdrant_drift when Qdrant unreachable', () => {
    const recon: ReconcileReport = {
      ranAt: '2026-04-23T10:00:00Z',
      sqliteLiveCount: 100,
      qdrantPointCount: 0,
      missingInQdrant: ['a'],
      orphanInQdrant: [],
      driftRatio: 1,
      qdrantReachable: false,
    };
    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z', reconcile: recon });
    expect(fired.map((a) => a.category)).not.toContain('qdrant_drift');
  });

  it('fires provider_unreachable when last-ok > 15 min stale', () => {
    const lastOk = '2026-04-23T10:00:00Z';
    const now = '2026-04-23T10:16:00Z';
    const fired = evaluateAlerts({ nowIso: now, lastProviderOkIso: lastOk });
    expect(fired.map((a) => a.category)).toContain('provider_unreachable');
  });

  it('fires legacy_drop_reminder once, then stays silent for 7 days', () => {
    // Seed the legacy-cutover tombstone > 30 days ago.
    const old = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const now1 = '2026-04-23T10:00:00Z';
    // setSystemState under the cutover key via metrics module mirrors
    // drop-legacy-tombstone.ts's ensureLegacyCutoverTombstone.
    // Import at runtime to avoid a circular reference.
    return import('../metrics.js').then(({ setSystemState: sss }) => {
      sss('legacy_cutover_at', old, old);
      const f1 = evaluateAlerts({ nowIso: now1 });
      expect(f1.map((a) => a.category)).toContain('legacy_drop_reminder');
      // One hour later, before the 7-day window: no refire.
      const f2 = evaluateAlerts({ nowIso: '2026-04-23T11:30:00Z' });
      expect(f2.map((a) => a.category)).not.toContain('legacy_drop_reminder');
      // Eight days later: refires.
      const f3 = evaluateAlerts({ nowIso: '2026-05-01T11:30:00Z' });
      expect(f3.map((a) => a.category)).toContain('legacy_drop_reminder');
    });
  });

  it('fires backup_failed when last_backup_failed_at is within the last 24h', async () => {
    const { setSystemState: sss } = await import('../metrics.js');
    const recent = '2026-04-23T05:00:00Z';
    sss('last_backup_failed_at', recent, recent);
    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z' });
    expect(fired.map((a) => a.category)).toContain('backup_failed');
  });

  it('does NOT fire backup_failed when failure was > 24h ago', async () => {
    const { setSystemState: sss } = await import('../metrics.js');
    const old = '2026-04-20T05:00:00Z';
    sss('last_backup_failed_at', old, old);
    const fired = evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z' });
    expect(fired.map((a) => a.category)).not.toContain('backup_failed');
  });

  it('throttles — second call within an hour returns no alerts', () => {
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 12, nowIso: '2026-04-23T10:00:00Z' });
    const first = evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z' });
    expect(first.map((a) => a.category)).toContain('monthly_budget');
    const second = evaluateAlerts({ nowIso: '2026-04-23T10:30:00Z' });
    expect(second.map((a) => a.category)).not.toContain('monthly_budget');
  });

  it('refires after the throttle window', () => {
    logCost({ provider: 'anthropic', operation: 'extract', units: 1, costUsd: 12, nowIso: '2026-04-23T10:00:00Z' });
    evaluateAlerts({ nowIso: '2026-04-23T10:00:00Z' });
    const later = evaluateAlerts({ nowIso: '2026-04-23T11:30:00Z' });
    expect(later.map((a) => a.category)).toContain('monthly_budget');
  });
});
