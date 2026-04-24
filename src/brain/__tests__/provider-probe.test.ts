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

const embedMock = vi.fn<
  (text: string, mode: string) => Promise<number[]>
>(async () => new Array(768).fill(0.1));
vi.mock('../embed.js', () => ({
  embedText: (text: string, mode: string) => embedMock(text, mode),
  getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
}));

import { _closeBrainDb } from '../db.js';
import { getSystemState } from '../metrics.js';
import {
  PROVIDER_LAST_OK_KEY,
  getProviderLastOkMs,
  probeOnce,
  startProviderProbe,
} from '../provider-probe.js';

describe('brain/provider-probe', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-probe-'));
    embedMock.mockClear();
    embedMock.mockImplementation(async () => new Array(768).fill(0.1));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps provider_last_ok on successful probe', async () => {
    const ok = await probeOnce('2026-04-23T10:00:00Z');
    expect(ok).toBe(true);
    const row = getSystemState(PROVIDER_LAST_OK_KEY);
    expect(row?.value).toBe('2026-04-23T10:00:00Z');
    expect(embedMock).toHaveBeenCalledWith('ping', 'query');
  });

  it('does NOT update provider_last_ok on failure', async () => {
    embedMock.mockImplementationOnce(async () => {
      throw new Error('nomic unreachable');
    });
    const ok = await probeOnce('2026-04-23T10:00:00Z');
    expect(ok).toBe(false);
    expect(getSystemState(PROVIDER_LAST_OK_KEY)).toBeNull();
  });

  it('does not clobber an earlier stamp when a later probe fails', async () => {
    await probeOnce('2026-04-23T10:00:00Z');
    embedMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await probeOnce('2026-04-23T10:05:00Z');
    expect(getSystemState(PROVIDER_LAST_OK_KEY)?.value).toBe(
      '2026-04-23T10:00:00Z',
    );
  });

  it('getProviderLastOkMs returns null when unset, epoch ms otherwise', async () => {
    expect(getProviderLastOkMs()).toBeNull();
    await probeOnce('2026-04-23T10:00:00Z');
    expect(getProviderLastOkMs()).toBe(Date.parse('2026-04-23T10:00:00Z'));
  });

  it('startProviderProbe returns a stop fn that clears the interval', () => {
    vi.useFakeTimers();
    try {
      const stop = startProviderProbe(1000);
      // Initial run is synchronous setup + one unawaited probe.
      vi.advanceTimersByTime(2500);
      stop();
      const countBefore = embedMock.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(embedMock.mock.calls.length).toBe(countBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
