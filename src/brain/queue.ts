/**
 * AsyncWriteQueue — serializes writes for the brain ingestion pipeline.
 *
 * Semantics (v2 §11):
 *  - Buffers enqueued items. Flushes when either maxBatchSize is reached
 *    or maxLatencyMs has elapsed since the batch's first item.
 *  - `enqueue(item)` resolves only once the batch containing that item
 *    has successfully been flushed. This is the backpressure signal.
 *  - On flush error: retry the whole batch with exponential backoff
 *    (100ms, 400ms, 1600ms). After 3 failed attempts the items are moved
 *    to a dead-letter array retrievable via `getDeadLetters()`; their
 *    enqueue() promises reject with the last error.
 *  - `shutdown()` flushes anything still buffered and rejects subsequent
 *    `enqueue` calls.
 */

export interface AsyncWriteQueueOptions {
  maxBatchSize?: number;
  maxLatencyMs?: number;
}

type Resolver = { resolve: () => void; reject: (err: Error) => void };

interface PendingItem<T> {
  item: T;
  resolver: Resolver;
}

const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_LATENCY_MS = 500;
const RETRY_DELAYS_MS = [100, 400, 1600];

export class AsyncWriteQueue<T> {
  private buffer: PendingItem<T>[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private shuttingDown = false;
  private deadLetters: T[] = [];
  private readonly maxBatchSize: number;
  private readonly maxLatencyMs: number;

  constructor(
    private readonly flushFn: (batch: T[]) => Promise<void>,
    options: AsyncWriteQueueOptions = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
  }

  /**
   * Add an item to the queue. Resolves once its batch has flushed successfully.
   * Rejects if the batch is dead-lettered or if `shutdown()` has been called.
   */
  enqueue(item: T): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('AsyncWriteQueue is shut down'));
    }
    return new Promise((resolve, reject) => {
      this.buffer.push({ item, resolver: { resolve, reject } });
      if (this.buffer.length >= this.maxBatchSize) {
        void this.triggerFlush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          void this.triggerFlush();
        }, this.maxLatencyMs);
      }
    });
  }

  /**
   * Drain any buffered items, then reject all subsequent enqueues.
   * Safe to call multiple times — subsequent calls wait for the original drain.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain: loop flushing until buffer is empty and no flush is in flight.
    while (this.buffer.length > 0 || this.flushing) {
      if (this.flushing) {
        // wait a tick
        await new Promise<void>((r) => setImmediate(r));
        continue;
      }
      await this.triggerFlush();
    }
  }

  /** Items that could not be persisted after 3 retries. */
  getDeadLetters(): T[] {
    return [...this.deadLetters];
  }

  /** @internal - size of pending buffer. Exposed for tests. */
  size(): number {
    return this.buffer.length;
  }

  private async triggerFlush(): Promise<void> {
    // Always null out any timer reference at the top — a stale (already-fired)
    // handle must never block future reschedules. (Bug fix from code review:
    // early-return on `flushing=true` previously skipped this clear, leaving
    // `flushTimer` non-null so subsequent enqueues would not schedule a new
    // timer, stranding items in the buffer until maxBatchSize was reached.)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.flushWithRetry(batch.map((p) => p.item));
      for (const p of batch) p.resolver.resolve();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const p of batch) this.deadLetters.push(p.item);
      for (const p of batch) p.resolver.reject(error);
    } finally {
      this.flushing = false;
      // Items enqueued during the in-flight flush need a new flush cycle.
      // Without this kick they'd sit buffered until maxBatchSize triggers.
      if (this.buffer.length > 0 && !this.shuttingDown) {
        this.flushTimer = setTimeout(() => {
          void this.triggerFlush();
        }, this.maxLatencyMs);
      }
    }
  }

  private async flushWithRetry(items: T[]): Promise<void> {
    let lastError: unknown;
    // First attempt + RETRY_DELAYS_MS.length retries = 4 total? Spec says
    // up to 3 retries before dead-letter → 1 initial + up to 2 retries…
    // Re-reading spec: "retries up to 3 times per batch" with backoffs
    // 100/400/1600ms → that's 3 retry attempts after the initial failure.
    // So the loop runs up to 4 times (initial + 3 retries) OR the initial
    // IS the first attempt and the 3 retries follow. Backoff array has 3
    // entries, so attempts = 1 initial + 3 retries = 4 total.
    //
    // Practically: try once. On failure, sleep RETRY_DELAYS_MS[0], retry.
    // On second failure, sleep RETRY_DELAYS_MS[1], retry. Etc.
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.flushFn(items);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
