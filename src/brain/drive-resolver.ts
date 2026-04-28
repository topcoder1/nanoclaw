/**
 * Inline-Drive-link resolver for the brain ingest pipeline.
 *
 * Detects Google Drive / Docs / Slides / Sheets URLs in email bodies (or
 * any text), and — via an injectable production fetcher — pulls the
 * linked doc's plain-text content and ingests it as its own KU
 * (`source_type='drive'`, `source_ref='<kind>:<fileId>'`).
 *
 * Why a separate KU rather than inlining the doc body into the email
 * KU's text:
 *   1. Provenance: search hits show the doc as the source, not "an
 *      email from drive-shares-dm-noreply@google.com".
 *   2. Idempotency: re-ingesting the same shared doc from a second
 *      reply or forward dedupes on (source_type, source_ref).
 *   3. Recall ergonomics: `/recall` filters by source_type can include
 *      or exclude shared decks/docs cleanly.
 *
 * The pure URL detector has no I/O — it's safe to call from any layer.
 * The fetcher is dependency-injected so unit tests can run without
 * Google API credentials, mirroring the `BrainBodyFetcher` pattern in
 * `ingest.ts`.
 */
import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

import { embedText } from './embed.js';
import { upsertKu } from './qdrant.js';
import { newId } from './ulid.js';

export type DriveDocKind = 'document' | 'presentation' | 'spreadsheet' | 'file';

export interface DriveLink {
  kind: DriveDocKind;
  fileId: string;
  /** The original URL as found in the source text. */
  url: string;
}

export interface DriveDocContent {
  /** Best-effort title pulled from the doc metadata. */
  title: string;
  /** Plain-text body. May be empty if export produced no text. */
  text: string;
}

export type BrainDriveFetcher = (
  account: string,
  link: DriveLink,
) => Promise<DriveDocContent | null>;

/** Cap on chars per linked doc fed into a single KU's text field. */
export const MAX_DRIVE_DOC_CHARS = 16_000;

// --- URL detection --------------------------------------------------------

// docs.google.com/{document,presentation,spreadsheets}/d/<fileId>(/...)?
const DOCS_RE =
  /https?:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]{10,})(?:\/[^\s<>]*)?/gi;

// drive.google.com/file/d/<fileId>(/...)?
const DRIVE_FILE_RE =
  /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})(?:\/[^\s<>]*)?/gi;

// drive.google.com/open?id=<fileId>  (no /d/ form)
const DRIVE_OPEN_RE =
  /https?:\/\/drive\.google\.com\/open\?(?:[^\s<>]*&)?id=([a-zA-Z0-9_-]{10,})/gi;

function docsKindToDriveKind(s: string): DriveDocKind {
  if (s === 'document') return 'document';
  if (s === 'presentation') return 'presentation';
  if (s === 'spreadsheets') return 'spreadsheet';
  return 'file';
}

/**
 * Pure URL detection. Extracts unique Drive links from arbitrary text.
 * Returns at most one entry per (kind, fileId) pair — the first URL
 * encountered wins. Order-stable so callers get deterministic output.
 */
export function extractDriveLinks(text: string): DriveLink[] {
  if (!text) return [];
  const seen = new Map<string, DriveLink>();

  const push = (link: DriveLink): void => {
    const key = `${link.kind}:${link.fileId}`;
    if (!seen.has(key)) seen.set(key, link);
  };

  for (const m of text.matchAll(DOCS_RE)) {
    push({
      kind: docsKindToDriveKind(m[1]),
      fileId: m[2],
      url: m[0],
    });
  }
  for (const m of text.matchAll(DRIVE_FILE_RE)) {
    push({ kind: 'file', fileId: m[1], url: m[0] });
  }
  for (const m of text.matchAll(DRIVE_OPEN_RE)) {
    push({ kind: 'file', fileId: m[1], url: m[0] });
  }

  return [...seen.values()];
}

export function driveSourceRef(link: DriveLink): string {
  return `${link.kind}:${link.fileId}`;
}

// --- Fetcher injection ----------------------------------------------------

let fetcher: BrainDriveFetcher | null = null;

export function setBrainDriveFetcher(fn: BrainDriveFetcher | null): void {
  fetcher = fn;
}

export function getBrainDriveFetcher(): BrainDriveFetcher | null {
  return fetcher;
}

// --- KU writer ------------------------------------------------------------

export interface IngestDriveDocOpts {
  /** Account bucket for the KU ('personal' | 'work'). */
  accountBucket: 'personal' | 'work';
  /** Wall-clock anchor for KU.valid_from (e.g. the email's received_at). */
  validFromIso: string;
  /** What pulled this in — for KU.extracted_by + extraction_chain. */
  extractedBy?: string;
  /** Source KU ids that triggered this ingest (e.g. the email KU). */
  extractionChain?: string[];
}

/**
 * Insert (or update) a `source_type='drive'` KU for the given fetched doc.
 * Idempotent on (source_type, source_ref): if a KU already exists, the
 * text is refreshed and `recorded_at` is bumped, but `valid_from` is
 * preserved so the doc stays anchored to its first-seen time.
 *
 * Returns the KU id (new or existing). Embedding + Qdrant upsert is
 * best-effort — failures log warn and the SQLite row stands.
 */
export async function ingestDriveDoc(
  db: Database.Database,
  link: DriveLink,
  doc: DriveDocContent,
  opts: IngestDriveDocOpts,
): Promise<string> {
  const sourceRef = driveSourceRef(link);
  const text = buildDriveDocText(link, doc);
  const nowIso = new Date().toISOString();

  const existing = db
    .prepare(
      `SELECT id, valid_from FROM knowledge_units
        WHERE source_type = 'drive' AND source_ref = ?`,
    )
    .get(sourceRef) as { id: string; valid_from: string } | undefined;

  let kuId: string;
  if (existing) {
    db.prepare(
      `UPDATE knowledge_units SET text = ?, recorded_at = ? WHERE id = ?`,
    ).run(text, nowIso, existing.id);
    kuId = existing.id;
  } else {
    kuId = newId();
    db.prepare(
      `INSERT INTO knowledge_units
         (id, text, source_type, source_ref, account, scope, confidence,
          valid_from, recorded_at, topic_key, tags, extracted_by,
          extraction_chain, metadata, needs_review)
       VALUES (?, ?, 'drive', ?, ?, NULL, 1.0, ?, ?, NULL, NULL, ?, ?, NULL, 0)`,
    ).run(
      kuId,
      text,
      sourceRef,
      opts.accountBucket,
      opts.validFromIso,
      nowIso,
      opts.extractedBy ?? 'drive_resolver',
      opts.extractionChain ? JSON.stringify(opts.extractionChain) : null,
    );
  }

  // Best-effort embed + Qdrant upsert. Failures don't roll back the row.
  try {
    const vec = await embedText(text, 'document');
    if (vec) {
      await upsertKu({
        kuId,
        vector: vec,
        payload: {
          account: opts.accountBucket,
          scope: null,
          model_version: 'nomic-embed-text-v1.5:768',
          valid_from: opts.validFromIso,
          recorded_at: nowIso,
          source_type: 'drive',
          source_ref: sourceRef,
          topic_key: null,
        },
      });
    }
  } catch (err) {
    logger.warn(
      {
        kuId,
        sourceRef,
        err: err instanceof Error ? err.message : String(err),
      },
      'drive-resolver: embed/upsert failed — KU stored, vector missing',
    );
  }

  return kuId;
}

function buildDriveDocText(link: DriveLink, doc: DriveDocContent): string {
  const header = doc.title
    ? `${doc.title} (${link.kind})\nSource: ${link.url}\n\n`
    : `Drive ${link.kind} ${link.fileId}\nSource: ${link.url}\n\n`;
  const remaining = MAX_DRIVE_DOC_CHARS - header.length;
  const body =
    doc.text.length > remaining ? doc.text.slice(0, remaining) : doc.text;
  return header + body;
}
