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

// Mock STORE_DIR so getBrainDb() lands in a temp directory.
let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import { EventBus } from '../../event-bus.js';
import type { EmailReceivedEvent } from '../../events.js';

// Fresh import of ingest per test would require resetModules — simpler to
// build the row-write path directly via the same helper the handler uses,
// but here we want end-to-end coverage so we exercise startBrainIngest with
// the singleton eventBus.
import { eventBus } from '../../event-bus.js';
import { _closeBrainDb, getBrainDb } from '../db.js';
import { startBrainIngest, stopBrainIngest } from '../ingest.js';

function emitEmailEvent(threadId: string, subject = 'hello'): void {
  const event: EmailReceivedEvent = {
    type: 'email.received',
    source: 'email-sse',
    timestamp: Date.now(),
    payload: {
      count: 1,
      emails: [
        {
          thread_id: threadId,
          account: 'work@example.com',
          subject,
          sender: 'alice@example.com',
          snippet: 's',
        },
      ],
      connection: 'test',
    },
  };
  eventBus.emit('email.received', event);
}

async function flushQueue(): Promise<void> {
  // Queue flushes on maxLatencyMs=500 by default; speed up by waiting that long.
  await new Promise((r) => setTimeout(r, 600));
}

describe('brain ingest → raw_events', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ingest-'));
  });

  afterEach(async () => {
    await stopBrainIngest();
    _closeBrainDb();
    // Best-effort cleanup of the whole event bus listeners so a stale
    // handler from a prior test doesn't fire on the singleton.
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts one raw_events row per unique email thread', async () => {
    startBrainIngest();
    emitEmailEvent('thread-A');
    await flushQueue();

    const db = getBrainDb();
    const rows = db
      .prepare(`SELECT source_type, source_ref, processed_at FROM raw_events`)
      .all() as {
      source_type: string;
      source_ref: string;
      processed_at: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_type).toBe('email');
    expect(rows[0].source_ref).toBe('thread-A');
    expect(rows[0].processed_at).toBeNull();
  });

  it('is idempotent on (source_type, source_ref) — duplicate thread_id yields one row', async () => {
    startBrainIngest();
    emitEmailEvent('thread-B');
    emitEmailEvent('thread-B');
    emitEmailEvent('thread-B');
    await flushQueue();

    const db = getBrainDb();
    const count = db
      .prepare(`SELECT COUNT(*) as n FROM raw_events WHERE source_ref = ?`)
      .get('thread-B') as { n: number };
    expect(count.n).toBe(1);
  });

  it('stores payload as a BLOB containing the serialized email JSON', async () => {
    startBrainIngest();
    emitEmailEvent('thread-C', 'important subject');
    await flushQueue();

    const db = getBrainDb();
    const row = db
      .prepare(`SELECT payload FROM raw_events WHERE source_ref = ?`)
      .get('thread-C') as { payload: Buffer };
    expect(Buffer.isBuffer(row.payload)).toBe(true);
    const parsed = JSON.parse(row.payload.toString('utf8'));
    expect(parsed.thread_id).toBe('thread-C');
    expect(parsed.subject).toBe('important subject');
  });

  it('does not crash if thread_id is missing — the bad entry is skipped', async () => {
    startBrainIngest();
    const bus = eventBus as unknown as EventBus;
    bus.emit('email.received', {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {
        count: 1,
        emails: [
          // @ts-expect-error deliberately missing thread_id
          {
            account: 'w',
            subject: 's',
            sender: 'a',
          },
        ],
        connection: 'test',
      },
    });
    await flushQueue();

    const db = getBrainDb();
    const count = db.prepare(`SELECT COUNT(*) as n FROM raw_events`).get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
