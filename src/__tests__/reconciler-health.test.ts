import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

// We drive the status via module-level state in gmail-reconciler; to avoid
// full DB/Gmail wiring we stub the status getter.
vi.mock('../triage/gmail-reconciler.js', () => ({
  getReconcilerStatus: vi.fn(),
}));

import { startReconcilerHealthWatcher } from '../triage/reconciler-health.js';
import { getReconcilerStatus } from '../triage/gmail-reconciler.js';

type Status = ReturnType<typeof getReconcilerStatus>;

function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    lastTickAt: null,
    lastTickDurationMs: null,
    lastResult: null,
    totalTicks: 0,
    totalResolved: 0,
    totalErrors: 0,
    ...overrides,
  };
}

describe('reconciler-health', () => {
  it('does nothing while the reconciler has never ticked', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    (getReconcilerStatus as any).mockReturnValue(makeStatus());

    const stop = startReconcilerHealthWatcher({
      intervalMs: 100,
      staleThresholdMs: 1000,
      getChatId: () => 'chat-1',
      send,
      now: () => 5_000_000,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });

  it('alerts once on stale, not again on subsequent stale ticks', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    let currentNow = 10_000_000;
    (getReconcilerStatus as any).mockImplementation(() =>
      makeStatus({ lastTickAt: 9_000_000 }),
    );

    const stop = startReconcilerHealthWatcher({
      intervalMs: 100,
      staleThresholdMs: 500_000, // 500s; age = 1M ms = stale
      getChatId: () => 'chat-1',
      send,
      now: () => currentNow,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatch(/stale/i);

    // Still stale on next tick — should not re-alert.
    currentNow += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);

    stop();
    vi.useRealTimers();
  });

  it('sends recovery alert once when freshness returns', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    let lastTickAt = 9_000_000;
    let currentNow = 10_000_000;
    (getReconcilerStatus as any).mockImplementation(() =>
      makeStatus({ lastTickAt }),
    );

    const stop = startReconcilerHealthWatcher({
      intervalMs: 100,
      staleThresholdMs: 500_000,
      getChatId: () => 'chat-1',
      send,
      now: () => currentNow,
    });

    // Tick 1: stale → alert.
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);

    // Tick 2: fresh → recovery.
    lastTickAt = currentNow; // fresh
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatch(/recovered/i);

    // Tick 3: still fresh → no more messages.
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);

    stop();
    vi.useRealTimers();
  });

  it('skips when EMAIL_INTEL_TG_CHAT_ID is unset', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    (getReconcilerStatus as any).mockReturnValue(
      makeStatus({ lastTickAt: 1 }), // very old
    );

    const stop = startReconcilerHealthWatcher({
      intervalMs: 100,
      staleThresholdMs: 10,
      getChatId: () => undefined,
      send,
      now: () => 1_000_000,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });
});
