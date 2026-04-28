import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Replace fs/promises.rename with a vi.fn we can drive per-test. Default
// behavior passes through to the real impl (set in beforeEach so resets
// between tests don't strand it). Node's native ESM bindings are read-only
// so vi.spyOn can't rebind them; this is the supported workaround.
const renameMock = vi.hoisted(() =>
  vi.fn() as unknown as typeof import('fs/promises').rename,
);
vi.mock('fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, rename: renameMock, default: { ...actual, rename: renameMock } };
});

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

import type Database from 'better-sqlite3';
import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  appendLog,
  materializeAll,
  materializeEntity,
  rebuildIndex,
  startWikiSynthesisSchedule,
} from '../wiki-writer.js';

// --- Seeders (subset of those in wiki-projection.test.ts; duplicated here
//     because the test file doesn't export them, and the materializer is
//     meant to be exercised independently of the renderer's test surface) ---

function seedEntity(
  db: Database.Database,
  opts: {
    entityId: string;
    entityType: 'person' | 'company' | 'project' | 'product' | 'topic';
    canonical?: Record<string, unknown> | null;
    wikiSummary?: string | null;
    updatedAt?: string;
  },
): void {
  const created = '2026-04-01T00:00:00Z';
  db.prepare(
    `INSERT INTO entities (entity_id, entity_type, canonical, created_at, updated_at,
                           last_synthesis_at, ku_count_at_last_synthesis, wiki_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.entityId,
    opts.entityType,
    opts.canonical === null
      ? null
      : opts.canonical
        ? JSON.stringify(opts.canonical)
        : null,
    created,
    opts.updatedAt ?? created,
    null,
    null,
    opts.wikiSummary ?? null,
  );
}

function seedKu(
  db: Database.Database,
  opts: {
    id: string;
    text: string;
    entityId: string;
    topicKey?: string | null;
    validFrom?: string;
  },
): void {
  const validFrom = opts.validFrom ?? '2026-04-15T00:00:00Z';
  db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, confidence,
        valid_from, recorded_at, topic_key, important, superseded_at)
     VALUES (?, ?, 'email', ?, 'work', 0.9, ?, ?, ?, 0, NULL)`,
  ).run(
    opts.id,
    opts.text,
    `thread-${opts.id}`,
    validFrom,
    validFrom,
    opts.topicKey ?? null,
  );
  db.prepare(
    `INSERT INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
  ).run(opts.id, opts.entityId);
}

const NOW = '2026-04-27T12:00:00Z';

describe('brain/wiki-writer', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wiki-writer-'));
    // Reset rename to passthrough; tests opt in to failure modes via mock*.
    const realFsp =
      await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const fn = renameMock as unknown as ReturnType<typeof vi.fn>;
    fn.mockReset();
    fn.mockImplementation(realFsp.rename);
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. First materialize → 'created', file exists, content matches render
  it('creates the page on first materialize', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HALICE',
      entityType: 'person',
      canonical: { name: 'Alice Smith' },
    });
    seedKu(db, { id: 'ku1', text: 'Alice owns the API', entityId: '01HALICE' });

    const result = await materializeEntity('01HALICE', tmpDir, { nowIso: NOW });

    expect(result.status).toBe('created');
    expect(result.path).toBe(path.join(tmpDir, 'wiki', 'Person', '01HALICE.md'));
    expect(fs.existsSync(result.path)).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('# Alice Smith');
    expect(content).toContain('Alice owns the API');
    expect(content.endsWith('\n')).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(content));
  });

  // 2. Re-materialize same entity, no DB change → 'unchanged', no write
  it('returns unchanged when re-materialized with no DB change', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HBOB',
      entityType: 'person',
      canonical: { name: 'Bob Jones' },
    });
    seedKu(db, { id: 'ku-b', text: 'Bob runs ops', entityId: '01HBOB' });

    const r1 = await materializeEntity('01HBOB', tmpDir, { nowIso: NOW });
    expect(r1.status).toBe('created');
    const mtime1 = fs.statSync(r1.path).mtimeMs;

    // Force a measurable mtime delta if a stray write happens — sleep 5ms.
    await new Promise((r) => setTimeout(r, 5));

    const r2 = await materializeEntity('01HBOB', tmpDir, { nowIso: NOW });
    expect(r2.status).toBe('unchanged');
    expect(fs.statSync(r2.path).mtimeMs).toBe(mtime1);
  });

  // 3. KU change → 'updated', file rewritten
  it('reports updated when KU set changes', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HCAR',
      entityType: 'company',
      canonical: { name: 'Carlson Co' },
    });
    seedKu(db, { id: 'ku-c1', text: 'first fact', entityId: '01HCAR' });

    const r1 = await materializeEntity('01HCAR', tmpDir, { nowIso: NOW });
    expect(r1.status).toBe('created');
    const before = fs.readFileSync(r1.path, 'utf-8');

    seedKu(db, { id: 'ku-c2', text: 'second fact', entityId: '01HCAR' });
    const r2 = await materializeEntity('01HCAR', tmpDir, { nowIso: NOW });

    expect(r2.status).toBe('updated');
    const after = fs.readFileSync(r2.path, 'utf-8');
    expect(after).not.toBe(before);
    expect(after).toContain('second fact');
  });

  // 4. Atomic write: simulate crash during rename, .tmp file cleaned up
  it('cleans up the .tmp file when rename fails', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HFAIL',
      entityType: 'person',
      canonical: { name: 'Failure Case' },
    });
    seedKu(db, { id: 'ku-f', text: 'fact', entityId: '01HFAIL' });

    (renameMock as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk on fire'),
    );

    const result = await materializeEntity('01HFAIL', tmpDir, { nowIso: NOW });

    expect(result.status).toBe('failed');
    expect(result.err).toContain('disk on fire');
    expect(renameMock).toHaveBeenCalledTimes(1);

    // Final file must NOT exist (rename never succeeded).
    expect(fs.existsSync(result.path)).toBe(false);
    // No .tmp.* leftovers in the target directory.
    const dir = path.dirname(result.path);
    if (fs.existsSync(dir)) {
      const stragglers = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${path.basename(result.path)}.tmp.`));
      expect(stragglers).toEqual([]);
    }
  });

  // 5. Concurrent materialize of same entity — both complete, content equal
  it('handles concurrent materialize of the same entity', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HRACE',
      entityType: 'topic',
      canonical: { name: 'race-condition' },
    });
    seedKu(db, { id: 'ku-r', text: 'concurrent fact', entityId: '01HRACE' });

    const [r1, r2] = await Promise.all([
      materializeEntity('01HRACE', tmpDir, { nowIso: NOW }),
      materializeEntity('01HRACE', tmpDir, { nowIso: NOW }),
    ]);

    // Both calls return a non-failed status. At least one is 'created' or
    // 'updated' (whichever rename won the race); the other may be 'created',
    // 'updated', or 'unchanged' depending on interleaving.
    for (const r of [r1, r2]) {
      expect(r.status).not.toBe('failed');
    }
    expect(fs.existsSync(r1.path)).toBe(true);
    const content = fs.readFileSync(r1.path, 'utf-8');
    expect(content).toContain('concurrent fact');
  });

  // 6. materializeAll: one entity fails, others still materialize
  it('isolates per-entity failures in materializeAll', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HOK1',
      entityType: 'person',
      canonical: { name: 'Ok One' },
    });
    seedKu(db, { id: 'ku-o1', text: 'ok one', entityId: '01HOK1' });

    seedEntity(db, {
      entityId: '01HBAD',
      entityType: 'person',
      canonical: { name: 'Bad One' },
    });
    seedKu(db, { id: 'ku-b', text: 'bad one', entityId: '01HBAD' });

    seedEntity(db, {
      entityId: '01HOK2',
      entityType: 'company',
      canonical: { name: 'Ok Two Inc' },
    });
    seedKu(db, { id: 'ku-o2', text: 'ok two', entityId: '01HOK2' });

    // Make the rename for 01HBAD fail; pass through for other entities so
    // OK1 and OK2 still materialize.
    const realFsp =
      await vi.importActual<typeof import('fs/promises')>('fs/promises');
    (renameMock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (src: unknown, dest: unknown) => {
        if (typeof src === 'string' && src.includes('01HBAD')) {
          throw new Error('rename refused');
        }
        return realFsp.rename(src as string, dest as string);
      },
    );

    const summary = await materializeAll(tmpDir, { nowIso: NOW });

    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].path).toContain('01HBAD');

    expect(
      fs.existsSync(path.join(tmpDir, 'wiki', 'Person', '01HOK1.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, 'wiki', 'Company', '01HOK2.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, 'wiki', 'Person', '01HBAD.md')),
    ).toBe(false);
  });

  // 7. rebuildIndex: file exists, contains TOC entries grouped by type
  it('rebuilds index.md grouped by entity type', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HZED',
      entityType: 'person',
      canonical: { name: 'Zoe Zed' },
      wikiSummary: 'Zoe runs comms.',
    });
    seedEntity(db, {
      entityId: '01HACME',
      entityType: 'company',
      canonical: { name: 'Acme Corp' },
    });
    seedEntity(db, {
      entityId: '01HALPHA',
      entityType: 'person',
      canonical: { name: 'Alice Alpha' },
    });

    await rebuildIndex(tmpDir);

    const indexPath = path.join(tmpDir, 'wiki', 'index.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const idx = fs.readFileSync(indexPath, 'utf-8');

    // Headings present, in alphabetical-by-type order (Company, Person).
    expect(idx.indexOf('## Company')).toBeGreaterThan(-1);
    expect(idx.indexOf('## Person')).toBeGreaterThan(-1);
    expect(idx.indexOf('## Company')).toBeLessThan(idx.indexOf('## Person'));

    // Entries link to per-entity pages.
    expect(idx).toContain('Acme Corp');
    expect(idx).toContain('Person/01HZED.md');
    expect(idx).toContain('Person/01HALPHA.md');

    // Cached summary surfaces inline.
    expect(idx).toContain('Zoe runs comms.');
  });

  it('rebuildIndex falls back to email/domain/slug per EntityType when name is missing', async () => {
    const db = getBrainDb();
    seedEntity(db, {
      entityId: '01HEMAIL',
      entityType: 'person',
      canonical: { email: 'nobody@example.com' },
    });
    seedEntity(db, {
      entityId: '01HDOMAIN',
      entityType: 'company',
      canonical: { domain: 'example.com' },
    });
    seedEntity(db, {
      entityId: '01HRULID',
      entityType: 'person',
      canonical: null, // intentionally NULL — must fall back to entity_id
    });

    await rebuildIndex(tmpDir);
    const idx = fs.readFileSync(
      path.join(tmpDir, 'wiki', 'index.md'),
      'utf-8',
    );

    // Display name pulled from email / domain when name is missing —
    // matches the page renderer's deriveTitle fallback chain.
    expect(idx).toContain('[nobody@example.com]');
    expect(idx).toContain('[example.com]');
    // Last-resort fallback when canonical is null.
    expect(idx).toContain('[01HRULID]');
  });

  // 8. appendLog rotation: pre-fill log.md to >1MB, next append rotates
  it('rotates log.md when it exceeds 1MB before appending', async () => {
    const wikiDir = path.join(tmpDir, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const logPath = path.join(wikiDir, 'log.md');
    // 1.1 MB of filler — predates the rotation threshold.
    const filler = 'x'.repeat(1_100_000);
    fs.writeFileSync(logPath, filler);

    await appendLog(tmpDir, 'fresh entry');

    const remaining = fs.readFileSync(logPath, 'utf-8');
    expect(remaining).toBe('fresh entry\n');

    const archives = fs
      .readdirSync(wikiDir)
      .filter((f) => f.startsWith('log.md.archived-'));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(wikiDir, archives[0]), 'utf-8')).toBe(
      filler,
    );
  });
});

describe('brain/wiki-writer — startWikiSynthesisSchedule', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-wiki-sched-'));
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeMaterializeAll(): {
    fn: typeof materializeAll;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      fn: (async () => {
        calls++;
        return { created: 1, updated: 0, unchanged: 0, failed: 0, failures: [] };
      }) as typeof materializeAll,
      callCount: () => calls,
    };
  }

  it('runs materializeAll inside the 09:00–11:59 window when no debounce stamp exists', async () => {
    const fake = fakeMaterializeAll();
    const fixedNow = new Date('2026-04-27T10:30:00');
    const stop = startWikiSynthesisSchedule({
      baseDir: tmpDir,
      checkIntervalMs: 60 * 60 * 1000,
      nowFn: () => fixedNow,
      materializeFn: fake.fn,
    });
    // The startup tick fires synchronously but materializeAll is async; flush.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stop();

    expect(fake.callCount()).toBe(1);

    const db = getBrainDb();
    const stamp = db
      .prepare(`SELECT value FROM system_state WHERE key = 'last_wiki_synthesis'`)
      .get() as { value: string } | undefined;
    expect(stamp?.value).toBe(fixedNow.toISOString());

    const counts = db
      .prepare(
        `SELECT value FROM system_state WHERE key = 'last_wiki_pass_counts'`,
      )
      .get() as { value: string } | undefined;
    expect(JSON.parse(counts!.value)).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
  });

  it('skips when last run is within the 22h debounce window', async () => {
    const db = getBrainDb();
    // Stamp a synthesis run from 2 hours ago — well inside the 22h debounce.
    const fixedNow = new Date('2026-04-27T10:30:00');
    const recent = new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('last_wiki_synthesis', recent, recent);

    const fake = fakeMaterializeAll();
    const stop = startWikiSynthesisSchedule({
      baseDir: tmpDir,
      checkIntervalMs: 60 * 60 * 1000,
      nowFn: () => fixedNow,
      materializeFn: fake.fn,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stop();

    expect(fake.callCount()).toBe(0);
  });

  it('skips when outside the 09:00–11:59 window', async () => {
    const fake = fakeMaterializeAll();
    const fixedNow = new Date('2026-04-27T13:00:00'); // 1 PM — outside.
    const stop = startWikiSynthesisSchedule({
      baseDir: tmpDir,
      checkIntervalMs: 60 * 60 * 1000,
      nowFn: () => fixedNow,
      materializeFn: fake.fn,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stop();

    expect(fake.callCount()).toBe(0);
  });
});
