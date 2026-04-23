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

import { AsyncWriteQueue } from '../queue.js';

describe('AsyncWriteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes when maxBatchSize is reached', async () => {
    const flushed: number[][] = [];
    const q = new AsyncWriteQueue<number>(
      async (batch) => {
        flushed.push([...batch]);
      },
      { maxBatchSize: 3, maxLatencyMs: 10_000 },
    );

    const p1 = q.enqueue(1);
    const p2 = q.enqueue(2);
    const p3 = q.enqueue(3);

    // Three items = full batch → flush fires immediately (microtask).
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([p1, p2, p3]);
    expect(flushed).toEqual([[1, 2, 3]]);
  });

  it('flushes on latency timeout', async () => {
    const flushed: number[][] = [];
    const q = new AsyncWriteQueue<number>(
      async (batch) => {
        flushed.push([...batch]);
      },
      { maxBatchSize: 100, maxLatencyMs: 500 },
    );

    const p = q.enqueue(42);
    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(flushed).toEqual([[42]]);
  });

  it('retries with exponential backoff and succeeds on 3rd attempt', async () => {
    let attempts = 0;
    const q = new AsyncWriteQueue<number>(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`attempt ${attempts}`);
      },
      { maxBatchSize: 1, maxLatencyMs: 10_000 },
    );

    const p = q.enqueue(1);

    // First attempt fails synchronously (within same microtask chain).
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // Backoff 100ms before retry 1.
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);

    // Backoff 400ms before retry 2 — which succeeds.
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(attempts).toBe(3);
    expect(q.getDeadLetters()).toEqual([]);
  });

  it('dead-letters after 3 failed retries', async () => {
    const q = new AsyncWriteQueue<number>(
      async () => {
        throw new Error('permanent');
      },
      { maxBatchSize: 1, maxLatencyMs: 10_000 },
    );

    const p = q.enqueue(7);
    // Attach rejection handler before advancing timers so Node doesn't see
    // an unhandled rejection.
    const rejected = p.catch((err: Error) => err.message);

    // Initial + 3 backoffs (100 + 400 + 1600) = 2100ms total wall time.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(1600);

    await expect(rejected).resolves.toBe('permanent');
    expect(q.getDeadLetters()).toEqual([7]);
  });

  it('shutdown drains pending items', async () => {
    const flushed: number[][] = [];
    const q = new AsyncWriteQueue<number>(
      async (batch) => {
        flushed.push([...batch]);
      },
      { maxBatchSize: 100, maxLatencyMs: 10_000 },
    );

    // Capture enqueue promises but don't await yet — items are buffered.
    const ps = [q.enqueue(1), q.enqueue(2), q.enqueue(3)];
    expect(flushed).toEqual([]);

    // Real timers for shutdown drain (it relies on setImmediate).
    vi.useRealTimers();
    await q.shutdown();
    await Promise.all(ps);
    expect(flushed).toEqual([[1, 2, 3]]);
  });

  it('rejects enqueue after shutdown', async () => {
    const q = new AsyncWriteQueue<number>(async () => {});
    vi.useRealTimers();
    await q.shutdown();
    await expect(q.enqueue(1)).rejects.toThrow(/shut down/);
  });
});
