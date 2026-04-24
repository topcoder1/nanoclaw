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
import { handleBrainStreamCommand } from '../stream-command.js';
import { newId } from '../ulid.js';

describe('brain/stream-command', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-stream-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const FIXED_NOW = new Date('2026-04-23T20:00:00Z');
  const nowFn = () => FIXED_NOW;

  function insertRaw(
    id: string,
    source_ref: string,
    receivedAt: string,
    processedAt: string | null = receivedAt,
  ): void {
    getBrainDb()
      .prepare(
        `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
         VALUES (?, 'email', ?, ?, ?, ?)`,
      )
      .run(id, source_ref, Buffer.from('{}'), receivedAt, processedAt);
  }

  function insertKu(
    id: string,
    text: string,
    source_ref: string | null,
    recordedAt: string,
    opts: { confidence?: number; needs_review?: number } = {},
  ): void {
    getBrainDb()
      .prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, source_ref, account, confidence, valid_from, recorded_at, needs_review)
         VALUES (?, ?, 'email', ?, 'work', ?, ?, ?, ?)`,
      )
      .run(
        id,
        text,
        source_ref,
        opts.confidence ?? 1.0,
        recordedAt,
        recordedAt,
        opts.needs_review ?? 0,
      );
  }

  function insertEntity(
    id: string,
    type: string,
    name: string,
    createdAt: string,
  ): void {
    getBrainDb()
      .prepare(
        `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, type, JSON.stringify({ name }), createdAt, createdAt);
  }

  function linkKuEntity(
    kuId: string,
    entityId: string,
    role = 'subject',
  ): void {
    getBrainDb()
      .prepare(
        `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, ?)`,
      )
      .run(kuId, entityId, role);
  }

  it('returns empty-state message on empty DB', async () => {
    const reply = await handleBrainStreamCommand('', { nowFn });
    expect(reply).toBe('No ingestion activity in last 24h.');
  });

  it('formats timeline newest-first with correlation and totals', async () => {
    // 3 raw_events (inside 24h)
    const raw1 = newId();
    const raw2 = newId();
    const raw3 = newId();
    insertRaw(raw1, 'thr-oldest', '2026-04-23T05:00:00Z');
    insertRaw(raw2, 'thr-middle', '2026-04-23T12:00:00Z');
    insertRaw(raw3, 'thr-newest', '2026-04-23T19:42:00Z');

    // 2 KUs — one linked to raw2 (via source_ref), one standalone
    const ku1 = newId();
    const ku2 = newId();
    insertKu(
      ku1,
      'Alice said renewal in Q4',
      'thr-middle',
      '2026-04-23T12:05:00Z',
    );
    insertKu(ku2, 'standalone insight', null, '2026-04-23T13:00:00Z', {
      confidence: 0.75,
      needs_review: 1,
    });

    // 1 entity (linked to ku1)
    const ent1 = newId();
    insertEntity(ent1, 'company', 'Acme Corp', '2026-04-23T12:05:30Z');
    linkKuEntity(ku1, ent1);

    const reply = await handleBrainStreamCommand('', { nowFn });

    // Header
    expect(reply).toMatch(/Brain stream/);
    expect(reply).toMatch(/last 24h/);
    // All three raw events appear
    expect(reply).toContain('thr-newest');
    expect(reply).toContain('thr-middle');
    expect(reply).toContain('thr-oldest');
    // Newest-first ordering: thr-newest must appear before thr-middle
    const idxNewest = reply.indexOf('thr-newest');
    const idxMiddle = reply.indexOf('thr-middle');
    const idxOldest = reply.indexOf('thr-oldest');
    expect(idxNewest).toBeGreaterThanOrEqual(0);
    expect(idxNewest).toBeLessThan(idxMiddle);
    expect(idxMiddle).toBeLessThan(idxOldest);

    // Correlation: raw2 (thr-middle) has 1 KU, 1 linked entity "Acme Corp"
    expect(reply).toMatch(/→ 1 KU, 1 linked entity \(Acme Corp\)/);

    // Standalone KU2 (not shown under a raw_event because its source_ref is NULL)
    expect(reply).toContain('standalone insight');
    expect(reply).toMatch(/needs_review/);
    expect(reply).toMatch(/confidence 0\.75/);

    // Entity linked via KU does NOT reappear as its own entity row.
    // Check the "🆕" prefix does not appear for Acme.
    const acmeAsStandalone = reply
      .split('\n')
      .find((line) => line.includes('🆕') && line.includes('Acme Corp'));
    expect(acmeAsStandalone).toBeUndefined();

    // Totals
    expect(reply).toMatch(/Totals \(24h\):/);
    expect(reply).toMatch(/3 emails/);
    expect(reply).toMatch(/2 KUs/);
    expect(reply).toMatch(/1 new entity/);
  });

  it('caps N at 50 when caller asks for 200', async () => {
    // Seed 60 raw events, all inside 24h.
    const db = getBrainDb();
    const insert = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES (?, 'email', ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 60; i++) {
      // space them out across the 24h window, all in the past
      const minutesAgo = i + 1;
      const ts = new Date(
        FIXED_NOW.getTime() - minutesAgo * 60 * 1000,
      ).toISOString();
      insert.run(newId(), `thr-${i}`, Buffer.from('{}'), ts, ts);
    }
    const reply = await handleBrainStreamCommand('200', { nowFn });
    // Header reports the cap: "showing 50 of 50" (events list is itself capped to MAX_LIMIT queries).
    expect(reply).toMatch(/showing 50 of/);
    // Count rendered 📥 rows — should be exactly 50.
    const count = (reply.match(/📥 \d\d:\d\d/g) ?? []).length;
    expect(count).toBe(50);
  });

  it('uses default 20 when N is 0, negative, or non-numeric', async () => {
    const db = getBrainDb();
    const insert = db.prepare(
      `INSERT INTO raw_events (id, source_type, source_ref, payload, received_at, processed_at)
       VALUES (?, 'email', ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 30; i++) {
      const minutesAgo = i + 1;
      const ts = new Date(
        FIXED_NOW.getTime() - minutesAgo * 60 * 1000,
      ).toISOString();
      insert.run(newId(), `thr-${i}`, Buffer.from('{}'), ts, ts);
    }
    for (const arg of ['0', '-5', 'xyz']) {
      const reply = await handleBrainStreamCommand(arg, { nowFn });
      const count = (reply.match(/📥 \d\d:\d\d/g) ?? []).length;
      expect(count).toBe(20);
    }
  });

  it('escapes Markdown-unsafe characters in source_ref and entity names', async () => {
    const raw = newId();
    const ent = newId();
    const ku = newId();
    insertRaw(raw, 'thr*nasty_[ref]', '2026-04-23T19:00:00Z');
    insertKu(ku, 'claim', 'thr*nasty_[ref]', '2026-04-23T19:01:00Z');
    insertEntity(ent, 'company', 'Weird*Co_[x]', '2026-04-23T19:02:00Z');
    linkKuEntity(ku, ent);

    const reply = await handleBrainStreamCommand('', { nowFn });
    // Raw stars/brackets/underscores from source_ref and entity name must be escaped.
    expect(reply).toContain('thr\\*nasty\\_\\[ref]');
    expect(reply).toContain('Weird\\*Co\\_\\[x]');
  });

  it('excludes rows older than 24h', async () => {
    // 30h ago — outside window
    const old = new Date(
      FIXED_NOW.getTime() - 30 * 60 * 60 * 1000,
    ).toISOString();
    insertRaw(newId(), 'thr-way-old', old);
    const reply = await handleBrainStreamCommand('', { nowFn });
    expect(reply).toBe('No ingestion activity in last 24h.');
  });
});
