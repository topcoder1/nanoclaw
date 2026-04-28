/**
 * Filesystem materializer for the brain wiki layer (Phase 3b.2).
 *
 * Takes the deterministic Markdown produced by `renderEntityPage` and
 * writes it to disk under `${baseDir}/wiki/{Type}/${entityId}.md` using an
 * atomic tmp + fsync + rename dance (D6). Diff-aware: re-materializing an
 * unchanged entity skips the write so mtimes only advance on real change.
 *
 * Pure-projection contract: this module never invents content. The optional
 * `synthesize` flag may invoke `synthesizeEntitySummary` to refresh the
 * cached blockquote BEFORE rendering, but the Markdown itself is always a
 * deterministic projection of typed rows.
 *
 * Path layout (D1):
 *   ${baseDir}/wiki/Person/01HALICE.md
 *   ${baseDir}/wiki/Company/01HACME.md
 *   ${baseDir}/wiki/index.md       — TOC over all entities
 *   ${baseDir}/wiki/log.md         — append-only event stream (1MB rotation)
 */

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import {
  ENTITY_NOT_FOUND,
  renderEntityPage,
  synthesizeEntitySummary,
  type EntityType,
  type SummaryLlmCaller,
} from './wiki-projection.js';

export interface MaterializeResult {
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  path: string;
  bytes?: number;
  err?: string;
}

export interface MaterializeEntityOptions {
  /** When true, refresh `wiki_summary` via the LLM before projecting. */
  synthesize?: boolean;
  /** Inject a stub LLM caller for tests / cost gating. */
  llm?: SummaryLlmCaller;
  /** Inject a DB handle for tests; defaults to the singleton brain DB. */
  db?: Database.Database;
  /** Override clock for golden-file determinism. ISO. */
  nowIso?: string;
}

export interface MaterializeAllOptions extends MaterializeEntityOptions {
  /** Restrict to entities updated at or after this ISO timestamp. */
  since?: string;
}

const TYPE_TO_DIR: Record<EntityType, string> = {
  person: 'Person',
  company: 'Company',
  project: 'Project',
  product: 'Product',
  topic: 'Topic',
};

/**
 * Rotation threshold for `wiki/log.md`. 1MB is chosen so a year of one
 * event/minute (~525K lines × ~80 bytes ≈ 42MB) rotates ~42 times — small
 * enough that no one archive grows unbounded, large enough that an idle
 * install rotates rarely.
 */
const LOG_ROTATE_BYTES = 1_000_000;

/**
 * Materialize a single entity to disk. Returns a status describing what
 * happened so callers (the coalescing queue trigger, /wiki command, daily
 * cron) can build user-facing summaries without re-reading the file.
 *
 * Failure modes that return `status: 'failed'` rather than throwing:
 *  - Entity row doesn't exist (`err: 'ENTITY_NOT_FOUND'`) — entities can be
 *    deleted between when the trigger queues a rebuild and when it fires.
 *  - readFile / writeFile / rename throw (`err: <message>`) — disk full,
 *    permissions, etc. The .tmp scratch file is always cleaned up before
 *    returning.
 *
 * `materializeAll` relies on this: any unhandled throw would drop the
 * whole pass; per-entity isolation requires we catch + report instead.
 */
export async function materializeEntity(
  entityId: string,
  baseDir: string,
  opts: MaterializeEntityOptions = {},
): Promise<MaterializeResult> {
  const db = opts.db ?? getBrainDb();
  const nowIso = opts.nowIso;

  if (opts.synthesize) {
    try {
      await synthesizeEntitySummary({
        entityId,
        db,
        llm: opts.llm,
        nowIso,
      });
    } catch (err) {
      // Synthesis failure is non-fatal — we still want the deterministic
      // projection on disk. The summary blockquote will just be empty or
      // stale until the next successful synthesis pass.
      logger.warn(
        { entityId, err: err instanceof Error ? err.message : String(err) },
        'wiki-writer: summary synthesis failed (continuing with deterministic projection)',
      );
    }
  }

  const rendered = renderEntityPage({ db, entityId, nowIso });
  if (rendered === ENTITY_NOT_FOUND) {
    return { status: 'failed', path: '', err: 'ENTITY_NOT_FOUND' };
  }

  const dir = path.join(baseDir, 'wiki', TYPE_TO_DIR[rendered.entityType]);
  const finalPath = path.join(dir, `${entityId}.md`);

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return {
      status: 'failed',
      path: finalPath,
      err: err instanceof Error ? err.message : String(err),
    };
  }

  // Diff detection: read the existing file (if any) and compare bytes. The
  // renderer is pure, so identical inputs produce identical bytes — string
  // equality is a sound staleness check.
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(finalPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        status: 'failed',
        path: finalPath,
        err: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const bytes = Buffer.byteLength(rendered.markdown);
  if (existing !== null && existing === rendered.markdown) {
    return { status: 'unchanged', path: finalPath, bytes };
  }

  try {
    await atomicWrite(finalPath, rendered.markdown);
  } catch (err) {
    return {
      status: 'failed',
      path: finalPath,
      err: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    status: existing === null ? 'created' : 'updated',
    path: finalPath,
    bytes,
  };
}

/**
 * Materialize every entity (or every entity touched since `opts.since`).
 * Per-entity failures are isolated — one bad row doesn't stop the pass.
 * The returned summary lets the daily cron post a one-line digest line
 * ("📚 Wiki: 3 created, 12 updated, 1 failed") without re-counting.
 */
export async function materializeAll(
  baseDir: string,
  opts: MaterializeAllOptions = {},
): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  failures: MaterializeResult[];
}> {
  const db = opts.db ?? getBrainDb();
  const rows = (
    opts.since
      ? db.prepare(
          `SELECT entity_id FROM entities WHERE updated_at >= ? ORDER BY entity_id`,
        )
      : db.prepare(`SELECT entity_id FROM entities ORDER BY entity_id`)
  ).all(...(opts.since ? [opts.since] : [])) as Array<{ entity_id: string }>;

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: MaterializeResult[] = [];

  for (const row of rows) {
    let result: MaterializeResult;
    try {
      result = await materializeEntity(row.entity_id, baseDir, {
        db,
        synthesize: opts.synthesize,
        llm: opts.llm,
        nowIso: opts.nowIso,
      });
    } catch (err) {
      // Defense in depth: materializeEntity is supposed to never throw, but
      // a future edit could regress that contract. Catch here so one bad
      // entity can't drop the whole pass.
      result = {
        status: 'failed',
        path: '',
        err: err instanceof Error ? err.message : String(err),
      };
    }
    switch (result.status) {
      case 'created':
        created++;
        break;
      case 'updated':
        updated++;
        break;
      case 'unchanged':
        unchanged++;
        break;
      case 'failed':
        failed++;
        failures.push(result);
        break;
    }
  }

  return { created, updated, unchanged, failed, failures };
}

interface IndexRow {
  entity_id: string;
  entity_type: EntityType;
  canonical: string | null;
  wiki_summary: string | null;
}

/**
 * Rebuild `wiki/index.md` from the entities table — TOC grouped by type,
 * sorted by display name, each entry showing the cached summary's first
 * line as inline context. Atomic-write, so readers never see a partial
 * index.
 */
export async function rebuildIndex(
  baseDir: string,
  opts: { db?: Database.Database } = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const rows = db
    .prepare(
      `SELECT entity_id, entity_type, canonical, wiki_summary
         FROM entities
         ORDER BY entity_type ASC,
                  COALESCE(json_extract(canonical, '$.name'), entity_id) ASC`,
    )
    .all() as IndexRow[];

  const wikiDir = path.join(baseDir, 'wiki');
  await fsp.mkdir(wikiDir, { recursive: true });

  const lines: string[] = ['# Wiki index', ''];
  let currentType: EntityType | null = null;
  for (const row of rows) {
    if (row.entity_type !== currentType) {
      if (currentType !== null) lines.push('');
      lines.push(`## ${TYPE_TO_DIR[row.entity_type]}`, '');
      currentType = row.entity_type;
    }
    const name = parseName(row.canonical) ?? row.entity_id;
    const link = `${TYPE_TO_DIR[row.entity_type]}/${row.entity_id}.md`;
    const summary = row.wiki_summary?.trim().split('\n')[0] ?? '';
    lines.push(summary ? `- [${name}](${link}) — ${summary}` : `- [${name}](${link})`);
  }
  lines.push('');

  await atomicWrite(path.join(wikiDir, 'index.md'), lines.join('\n'));
}

function parseName(canonical: string | null): string | null {
  if (!canonical) return null;
  try {
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
  } catch {
    /* malformed canonical — fall back to entity_id */
  }
  return null;
}

/**
 * Append one line to `wiki/log.md`. Rotates the file to
 * `log.md.archived-<YYYY-MM-DD>` (with a numeric suffix on collision)
 * BEFORE appending if the existing file exceeds `LOG_ROTATE_BYTES`. No
 * multi-archive cleanup in v1 — operators prune manually if disk fills.
 */
export async function appendLog(baseDir: string, line: string): Promise<void> {
  const wikiDir = path.join(baseDir, 'wiki');
  await fsp.mkdir(wikiDir, { recursive: true });
  const logPath = path.join(wikiDir, 'log.md');

  let size = 0;
  try {
    size = (await fsp.stat(logPath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (size > LOG_ROTATE_BYTES) {
    const stamp = new Date().toISOString().slice(0, 10);
    let archive = path.join(wikiDir, `log.md.archived-${stamp}`);
    let suffix = 0;
    while (await pathExists(archive)) {
      suffix++;
      archive = path.join(wikiDir, `log.md.archived-${stamp}.${suffix}`);
    }
    await fsp.rename(logPath, archive);
  }

  await fsp.appendFile(logPath, `${line}\n`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * tmp + fsync + rename atomic write. The tmp filename includes pid + 6
 * random bytes so two materializers writing the same final path can never
 * collide on their scratch files (D6). Caller is responsible for ensuring
 * the parent directory exists.
 *
 * fsync before rename guarantees the tmp file's bytes are durable on
 * crash recovery — without it, a power loss between rename and the next
 * fsync could leave a renamed-but-empty file. We don't fsync the parent
 * directory; on macOS / Linux this is generally safe for non-database
 * workloads.
 */
// ===========================================================================
// Phase 3b.3 trigger B — daily synthesis scheduler
// ===========================================================================
//
// Drives `materializeAll` once per day inside a 09:00–11:59 local window.
// LLM-synthesizing pass — the on-insert trigger A intentionally never calls
// the LLM (bounds tail latency to disk speed); this is where the cached
// `wiki_summary` blockquote actually gets refreshed.
//
// Lives here (not in wiki-projection.ts) because the scheduler's job is to
// drive `materializeAll`, which lives here. wiki-projection.ts stays
// I/O-free; pulling the scheduler over there would force it to import the
// I/O module and invert the layer dependency.

/** ISO timestamp of the last successful synthesis pass. */
const WIKI_SYNTHESIS_STATE_KEY = 'last_wiki_synthesis';
/**
 * JSON of the most recent pass's `{created, updated, unchanged, failed}`.
 * Read by the weekly digest formatter (Phase 3b.4) to add a one-line
 * "📚 Wiki: N created, M updated" summary.
 */
const WIKI_SYNTHESIS_COUNTS_KEY = 'last_wiki_pass_counts';
/** 22h debounce — leaves a 2h window for a missed Sunday tick to retry. */
const WIKI_SYNTHESIS_DEBOUNCE_MS = 22 * 60 * 60 * 1000;
/** Cap one pass at 5 minutes — bounded so a stuck LLM can't wedge ingest. */
const WIKI_SYNTHESIS_TIMEOUT_MS = 5 * 60 * 1000;
/** Window: 09:00–11:59 local. Daily, not weekly (procedural-reflect is weekly). */
const WIKI_SYNTHESIS_WINDOW_START_HOUR = 9;
const WIKI_SYNTHESIS_WINDOW_END_HOUR = 12;

export interface WikiSynthesisScheduleOptions {
  /** STORE_DIR (the wiki/ subdir is appended inside the materializer). */
  baseDir: string;
  /** Interval between window checks. Default 1h. */
  checkIntervalMs?: number;
  /** Inject for deterministic tests. */
  nowFn?: () => Date;
  /** Inject for tests / cost gating. Falls through to defaultSummaryLlmCaller. */
  llm?: SummaryLlmCaller;
  /** Inject DB handle for tests. */
  db?: Database.Database;
  /**
   * Inject the materialize implementation for tests. Defaults to the real
   * `materializeAll`. Tests stub this to avoid running the full pipeline.
   */
  materializeFn?: typeof materializeAll;
}

/**
 * Hourly tick that runs `materializeAll` once per day inside the window.
 * Returns a `stop()` that clears the interval — match the
 * `procedural-reflect` shape so wiring/teardown looks identical.
 *
 * Failure semantics:
 *  - On-disk debounce stamp is written ONLY on success → a failed pass is
 *    retryable on the next hourly tick within the window.
 *  - In-process `running` flag prevents the startup tick from racing the
 *    first interval tick.
 *  - 5-minute Promise.race timeout prevents a stuck LLM from wedging the
 *    scheduler.
 *  - Per-entity failures don't bubble — `materializeAll` already isolates
 *    them and reports counts.
 */
export function startWikiSynthesisSchedule(
  opts: WikiSynthesisScheduleOptions,
): () => void {
  const checkIntervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
  const nowFn = opts.nowFn ?? (() => new Date());
  const materializeFn = opts.materializeFn ?? materializeAll;

  const getLast = (): number | null => {
    try {
      const db = opts.db ?? getBrainDb();
      const row = db
        .prepare(`SELECT value FROM system_state WHERE key = ?`)
        .get(WIKI_SYNTHESIS_STATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      const ms = Date.parse(row.value);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  };

  const setLast = (iso: string): void => {
    try {
      const db = opts.db ?? getBrainDb();
      db.prepare(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(WIKI_SYNTHESIS_STATE_KEY, iso, iso);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'wiki-writer: failed to record last-fire timestamp',
      );
    }
  };

  const setCounts = (
    counts: { created: number; updated: number; unchanged: number; failed: number },
    iso: string,
  ): void => {
    try {
      const db = opts.db ?? getBrainDb();
      db.prepare(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(WIKI_SYNTHESIS_COUNTS_KEY, JSON.stringify(counts), iso);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'wiki-writer: failed to record pass counts',
      );
    }
  };

  let running = false;

  const tick = async (): Promise<void> => {
    const now = nowFn();
    const inWindow =
      now.getHours() >= WIKI_SYNTHESIS_WINDOW_START_HOUR &&
      now.getHours() < WIKI_SYNTHESIS_WINDOW_END_HOUR;
    if (!inWindow) return;
    if (running) return;
    const last = getLast();
    if (last !== null && now.getTime() - last < WIKI_SYNTHESIS_DEBOUNCE_MS)
      return;

    running = true;
    const nowIso = now.toISOString();
    const sinceIso = last !== null ? new Date(last).toISOString() : undefined;
    try {
      const counts = await Promise.race([
        materializeFn(opts.baseDir, {
          since: sinceIso,
          synthesize: true,
          llm: opts.llm,
          db: opts.db,
          nowIso,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('wiki synthesis timed out')),
            WIKI_SYNTHESIS_TIMEOUT_MS,
          ),
        ),
      ]);
      setLast(nowIso);
      setCounts(
        {
          created: counts.created,
          updated: counts.updated,
          unchanged: counts.unchanged,
          failed: counts.failed,
        },
        nowIso,
      );
      // Best-effort log line — not critical, swallow errors.
      try {
        await appendLog(
          opts.baseDir,
          `[${nowIso}] synthesis pass: created=${counts.created} updated=${counts.updated} unchanged=${counts.unchanged} failed=${counts.failed}`,
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'wiki-writer: appendLog failed (non-fatal)',
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'wiki-writer: scheduled synthesis run failed',
      );
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), checkIntervalMs);
  return () => clearInterval(handle);
}

async function atomicWrite(finalPath: string, content: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    const fh = await fsp.open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
