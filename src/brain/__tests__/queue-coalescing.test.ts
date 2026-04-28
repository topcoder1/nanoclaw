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

import { CoalescingQueue } from '../queue.js';

describe('CoalescingQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple enqueues of the same key into one handler call', async () => {
    const calls: string[] = [];
    const q = new CoalescingQueue<string>({
      debounceMs: 100,
      handler: async (key) => {
        calls.push(key);
      },
    });

    q.enqueue('entity-1');
    await vi.advanceTimersByTimeAsync(50);
    q.enqueue('entity-1');
    await vi.advanceTimersByTimeAsync(50);
    q.enqueue('entity-1');
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['entity-1']);
  });

  it('runs handler once per distinct key', async () => {
    const calls: string[] = [];
    const q = new CoalescingQueue<string>({
      debounceMs: 100,
      handler: async (key) => {
        calls.push(key);
      },
    });

    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');

    await vi.advanceTimersByTimeAsync(100);
    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports handler errors via onError and stays alive for future enqueues', async () => {
    const errors: Array<{ err: unknown; key: string }> = [];
    let shouldThrow = true;
    const successCalls: string[] = [];
    const q = new CoalescingQueue<string>({
      debounceMs: 100,
      handler: async (key) => {
        if (shouldThrow) throw new Error(`boom-${key}`);
        successCalls.push(key);
      },
      onError: (err, key) => {
        errors.push({ err, key });
      },
    });

    q.enqueue('bad');
    await vi.advanceTimersByTimeAsync(100);
    // Allow the handler microtask + onError to settle.
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe('bad');
    expect((errors[0].err as Error).message).toBe('boom-bad');

    // Queue is still usable after the failure.
    shouldThrow = false;
    q.enqueue('good');
    await vi.advanceTimersByTimeAsync(100);
    expect(successCalls).toEqual(['good']);
  });

  it('flushAll runs all pending handlers immediately and resolves when settled', async () => {
    const calls: string[] = [];
    const q = new CoalescingQueue<string>({
      debounceMs: 60_000, // far beyond the test horizon
      handler: async (key) => {
        await Promise.resolve();
        calls.push(key);
      },
    });

    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    expect(calls).toEqual([]);

    const flushP = q.flushAll();
    await vi.runAllTimersAsync();
    await flushP;

    expect(calls.sort()).toEqual(['a', 'b', 'c']);

    // Subsequent flushAll with nothing pending resolves immediately.
    await q.flushAll();
  });

  it('shutdown drains pending keys and rejects subsequent enqueues', async () => {
    const calls: string[] = [];
    const q = new CoalescingQueue<string>({
      debounceMs: 60_000,
      handler: async (key) => {
        calls.push(key);
      },
    });

    q.enqueue('x');
    q.enqueue('y');

    const shutdownP = q.shutdown();
    await vi.runAllTimersAsync();
    await shutdownP;

    expect(calls.sort()).toEqual(['x', 'y']);

    // After shutdown, enqueue is a no-op (or throws); the spec leaves it loose,
    // but at minimum it must not schedule a fresh handler call.
    q.enqueue('z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.sort()).toEqual(['x', 'y']);
  });
});
