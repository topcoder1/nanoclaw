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
import { dispatchAlertsOnce } from '../alert-dispatcher.js';
import { logCost, setSystemState } from '../metrics.js';
import type { ReconcileReport } from '../reconcile.js';

describe('brain/alert-dispatcher', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dispatch-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads reconcile report + provider_last_ok from system_state and delivers a formatted message per fired alert', async () => {
    const now = '2026-04-23T11:00:00Z';
    // Seed MTD cost over $10 → monthly_budget should fire.
    logCost({
      provider: 'anthropic',
      operation: 'extract',
      units: 1,
      costUsd: 15,
      nowIso: now,
    });

    // Seed a reconcile report with drift > 1%.
    const recon: ReconcileReport = {
      ranAt: now,
      sqliteLiveCount: 100,
      qdrantPointCount: 97,
      missingInQdrant: ['a', 'b'],
      orphanInQdrant: ['c'],
      driftRatio: 0.03,
      qdrantReachable: true,
    };
    setSystemState('last_reconcile_report', JSON.stringify(recon), now);

    // Seed a stale provider_last_ok > 15 min old.
    setSystemState('provider_last_ok', '2026-04-23T10:00:00Z', now);

    const delivered: string[] = [];
    const deliver = (md: string): void => {
      delivered.push(md);
    };

    const fired = await dispatchAlertsOnce(deliver, now);
    const cats = fired.map((a) => a.category).sort();
    expect(cats).toEqual(
      expect.arrayContaining(['monthly_budget', 'qdrant_drift', 'provider_down']),
    );
    // Each fired alert generated one delivery.
    expect(delivered.length).toBe(fired.length);
    expect(delivered.join('\n')).toMatch(/Brain alert/);
  });

  it('does nothing when no categories fire', async () => {
    const now = '2026-04-23T11:00:00Z';
    const delivered: string[] = [];
    const fired = await dispatchAlertsOnce((md) => {
      delivered.push(md);
    }, now);
    expect(fired).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('swallows deliver() errors so one failure does not stop the rest', async () => {
    const now = '2026-04-23T11:00:00Z';
    logCost({
      provider: 'anthropic',
      operation: 'extract',
      units: 1,
      costUsd: 15,
      nowIso: now,
    });
    const deliver = vi.fn(async () => {
      throw new Error('telegram dead');
    });
    const fired = await dispatchAlertsOnce(deliver, now);
    expect(fired.length).toBeGreaterThan(0);
    expect(deliver).toHaveBeenCalled();
    // No throw is the assertion.
  });
});
