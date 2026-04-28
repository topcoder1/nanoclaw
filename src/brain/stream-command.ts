/**
 * Telegram `/brainstream [N]` handler — ingestion transparency.
 *
 * Shows the last N events (default 20, max 50) across the three brain
 * write-paths in the last 24h, newest first:
 *
 *   1. `raw_events`     — an email/attachment/etc. was captured
 *   2. `knowledge_units`— a KU was extracted (optionally linked to a raw_event)
 *   3. `entities`       — a new person/company/project was created
 *
 * Correlation:
 *   - A raw_event's KUs are shown as nested bullets under the raw_event row
 *     (matched via `source_ref`).
 *   - A KU's entities are shown inline (via `ku_entities` junction).
 *
 * Safe for Telegram: all user-derived strings (source_ref, canonical names)
 * pass through `escapeMarkdown`. The message is capped by N and by a 120-char
 * truncation on KU text to stay comfortably under the 4096-char ceiling.
 */

import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { escapeMarkdown } from './markdown.js';
import {
  deriveTitle,
  type EntityType,
  parseCanonical,
} from './wiki-projection.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BrainStreamOptions {
  /** Account scope; reserved for future per-account filtering. */
  account?: 'personal' | 'work';
  /** Inject a clock for deterministic tests. Defaults to `() => new Date()`. */
  nowFn?: () => Date;
}

interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  received_at: string;
  processed_at: string | null;
  process_error: string | null;
}

interface KuRow {
  id: string;
  text: string;
  source_type: string;
  source_ref: string | null;
  confidence: number;
  needs_review: number;
  recorded_at: string;
}

interface EntityRow {
  entity_id: string;
  entity_type: EntityType;
  canonical: string | null;
  created_at: string;
}

type StreamEventKind = 'raw' | 'ku' | 'entity';
interface StreamEvent {
  kind: StreamEventKind;
  ts: string; // ISO — sort key (newest first)
  line: string;
  children: string[];
}

/** Parse `[N]` arg, clamping to `[1, MAX_LIMIT]`. Non-numeric / zero → default. */
function parseLimit(rawArgs: string): number {
  const trimmed = rawArgs.trim();
  if (!trimmed) return DEFAULT_LIMIT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Human-readable name for an entity row, via the shared `deriveTitle` fallback chain. */
function entityDisplayName(row: EntityRow): string {
  return deriveTitle(
    row.entity_type,
    parseCanonical(row.canonical),
    row.entity_id,
  );
}

function shortTime(iso: string): string {
  // HH:MM in UTC — keep output consistent regardless of server TZ.
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export async function handleBrainStreamCommand(
  rawArgs: string,
  opts: BrainStreamOptions = {},
): Promise<string> {
  const limit = parseLimit(rawArgs);
  const now = (opts.nowFn ?? (() => new Date()))();
  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const nowIso = now.toISOString();

  let rawEvents: RawEventRow[] = [];
  let kus: KuRow[] = [];
  let entities: EntityRow[] = [];
  let kuEntityRows: Array<{
    ku_id: string;
    entity_id: string;
    role: string;
    entity_type: EntityType;
    canonical: string | null;
  }> = [];
  try {
    const db = getBrainDb();
    rawEvents = db
      .prepare(
        `SELECT id, source_type, source_ref, received_at, processed_at, process_error
           FROM raw_events
          WHERE received_at >= ? AND received_at <= ?
          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(sinceIso, nowIso, MAX_LIMIT) as RawEventRow[];
    kus = db
      .prepare(
        `SELECT id, text, source_type, source_ref, confidence, needs_review, recorded_at
           FROM knowledge_units
          WHERE recorded_at >= ? AND recorded_at <= ?
          ORDER BY recorded_at DESC
          LIMIT ?`,
      )
      .all(sinceIso, nowIso, MAX_LIMIT) as KuRow[];
    entities = db
      .prepare(
        `SELECT entity_id, entity_type, canonical, created_at
           FROM entities
          WHERE created_at >= ? AND created_at <= ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(sinceIso, nowIso, MAX_LIMIT) as EntityRow[];
    if (kus.length > 0) {
      const placeholders = kus.map(() => '?').join(',');
      kuEntityRows = db
        .prepare(
          `SELECT ke.ku_id, ke.entity_id, ke.role, e.entity_type, e.canonical
             FROM ku_entities ke
             JOIN entities e ON e.entity_id = ke.entity_id
            WHERE ke.ku_id IN (${placeholders})`,
        )
        .all(...kus.map((k) => k.id)) as typeof kuEntityRows;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/brainstream query failed',
    );
    return `Brain stream unavailable: ${
      err instanceof Error ? err.message : 'db error'
    }`;
  }

  if (rawEvents.length === 0 && kus.length === 0 && entities.length === 0) {
    return 'No ingestion activity in last 24h.';
  }

  // Index KUs by their source_ref for raw_event → KU correlation.
  const kusBySourceRef = new Map<string, KuRow[]>();
  for (const ku of kus) {
    if (!ku.source_ref) continue;
    const arr = kusBySourceRef.get(ku.source_ref) ?? [];
    arr.push(ku);
    kusBySourceRef.set(ku.source_ref, arr);
  }
  const correlatedKuIds = new Set<string>();
  const correlatedEntityIds = new Set<string>();

  // Index KU entities by ku_id.
  const entitiesByKu = new Map<string, typeof kuEntityRows>();
  for (const row of kuEntityRows) {
    const arr = entitiesByKu.get(row.ku_id) ?? [];
    arr.push(row);
    entitiesByKu.set(row.ku_id, arr);
  }

  const events: StreamEvent[] = [];

  // 1) raw_events with their correlated KUs inline.
  for (const r of rawEvents) {
    const linkedKus = kusBySourceRef.get(r.source_ref) ?? [];
    for (const k of linkedKus) correlatedKuIds.add(k.id);

    const linkedEntityNames = new Set<string>();
    for (const k of linkedKus) {
      for (const ke of entitiesByKu.get(k.id) ?? []) {
        linkedEntityNames.add(
          entityDisplayName({
            entity_id: ke.entity_id,
            entity_type: ke.entity_type,
            canonical: ke.canonical,
            created_at: '',
          }),
        );
        correlatedEntityIds.add(ke.entity_id);
      }
    }

    const head =
      `📥 ${shortTime(r.received_at)}  ${escapeMarkdown(r.source_type)}  ` +
      `\`${escapeMarkdown(truncate(r.source_ref, 40))}\``;
    const children: string[] = [];
    if (linkedKus.length > 0) {
      const newEntCount = linkedEntityNames.size;
      const namesPreview =
        linkedEntityNames.size > 0
          ? ` (${[...linkedEntityNames]
              .slice(0, 3)
              .map((n) => escapeMarkdown(n))
              .join(', ')})`
          : '';
      children.push(
        `→ ${linkedKus.length} KU${linkedKus.length === 1 ? '' : 's'}` +
          (newEntCount > 0
            ? `, ${newEntCount} linked entit${newEntCount === 1 ? 'y' : 'ies'}${namesPreview}`
            : ''),
      );
    }
    if (r.processed_at) {
      const statusBits = r.process_error
        ? 'processed (error logged)'
        : 'processed';
      children.push(`→ ${statusBits}`);
    } else {
      children.push('→ pending');
    }
    events.push({
      kind: 'raw',
      ts: r.received_at,
      line: head,
      children,
    });
  }

  // 2) KUs that were NOT shown under a raw_event (no source_ref match).
  for (const k of kus) {
    if (correlatedKuIds.has(k.id)) continue;
    const needsReview = k.needs_review === 1 ? ', needs_review' : '';
    const snippet = escapeMarkdown(truncate(k.text, 80));
    const head =
      `🧠 ${shortTime(k.recorded_at)}  KU  ` +
      `(confidence ${k.confidence.toFixed(2)}${needsReview})`;
    const ents = entitiesByKu.get(k.id) ?? [];
    for (const ke of ents) correlatedEntityIds.add(ke.entity_id);
    const children: string[] = [snippet];
    if (ents.length > 0) {
      const names = ents
        .slice(0, 5)
        .map((e) =>
          escapeMarkdown(
            entityDisplayName({
              entity_id: e.entity_id,
              entity_type: e.entity_type,
              canonical: e.canonical,
              created_at: '',
            }),
          ),
        )
        .join(', ');
      children.push(
        `→ ${ents.length} entit${ents.length === 1 ? 'y' : 'ies'}: ${names}`,
      );
    }
    events.push({ kind: 'ku', ts: k.recorded_at, line: head, children });
  }

  // 3) Entities created directly (not already shown via a KU link).
  for (const e of entities) {
    if (correlatedEntityIds.has(e.entity_id)) continue;
    const name = escapeMarkdown(entityDisplayName(e));
    const head =
      `🆕 ${shortTime(e.created_at)}  entity  ` +
      `${escapeMarkdown(e.entity_type)}: ${name}`;
    events.push({ kind: 'entity', ts: e.created_at, line: head, children: [] });
  }

  // Sort newest first, then cap to the requested limit.
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const capped = events.slice(0, limit);

  // Totals cover the full 24h window regardless of cap.
  const totalEmails = rawEvents.filter((r) => r.source_type === 'email').length;
  const totalRawOther = rawEvents.length - totalEmails;
  const totalsBits = [
    `${totalEmails} email${totalEmails === 1 ? '' : 's'}`,
    totalRawOther > 0 ? `${totalRawOther} other raw` : null,
    `${kus.length} KU${kus.length === 1 ? '' : 's'}`,
    `${entities.length} new entit${entities.length === 1 ? 'y' : 'ies'}`,
  ].filter(Boolean) as string[];

  const lines: string[] = [];
  lines.push(
    `📥 *Brain stream* — last 24h (showing ${capped.length} of ${events.length})`,
  );
  lines.push('');
  for (const ev of capped) {
    lines.push(ev.line);
    for (const child of ev.children) {
      lines.push(`       ${child}`);
    }
  }
  lines.push('');
  lines.push(`📊 *Totals (24h):* ${totalsBits.join(' · ')}`);
  return lines.join('\n');
}
