/**
 * Edit/delete sync for chat-derived KUs.
 *
 * Subscribes to chat.message.edited and chat.message.deleted events
 * (wired in Task 9). For each event, walks raw_events to find rows whose
 * source_ref or payload's message_ids[] includes the changed message_id.
 *
 * Two raw_events shapes carry chat-derived data:
 *   - <platform>_message rows: source_ref = '<chat_id>:<message_id>'
 *   - <platform>_window rows:  source_ref = '<chat_id>:<window_started_at>',
 *                              payload contains message_ids: string[]
 */

import type Database from 'better-sqlite3';

import { eventBus } from '../event-bus.js';
import type {
  ChatMessageEditedEvent,
  ChatMessageDeletedEvent,
} from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { embedText, getEmbeddingModelVersion } from './embed.js';
import { extractPipeline, type LlmCaller } from './extract.js';
import { upsertKu } from './qdrant.js';
import { newId } from './ulid.js';

export interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  payload: Buffer;
  received_at: string;
}

export interface ChatEditSyncOpts {
  llmCaller?: LlmCaller;
  db?: Database.Database;
}

/**
 * Locate raw_events derived from `(platform, chat_id, message_id)`.
 *
 * Returns single-message rows (matched by exact source_ref) plus windowed
 * rows whose payload's `message_ids[]` contains the message. The windowed
 * lookup uses LIKE on the JSON BLOB as a coarse pre-filter (cheap), then
 * verifies by parsing — so spurious substring matches in unrelated fields
 * (e.g. transcript text) don't produce false positives.
 */
export function findRawEventsForMessage(
  db: Database.Database,
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): RawEventRow[] {
  const messageType = `${platform}_message`;
  const windowType = `${platform}_window`;
  const singleSourceRef = `${chat_id}:${message_id}`;

  // Case 1: single-message rows with exact source_ref.
  const singles = db
    .prepare(
      `SELECT id, source_type, source_ref, payload, received_at
       FROM raw_events
       WHERE source_type = ? AND source_ref = ?`,
    )
    .all(messageType, singleSourceRef) as RawEventRow[];

  // Case 2: windowed rows whose JSON payload mentions message_id. LIKE
  // pre-filter is cheap; then we parse to verify the id appears in
  // message_ids[] (not, e.g., in the transcript text).
  const likePattern = `%"${message_id}"%`;
  const winCandidates = db
    .prepare(
      `SELECT id, source_type, source_ref, payload, received_at
       FROM raw_events
       WHERE source_type = ?
         AND CAST(payload AS TEXT) LIKE ?`,
    )
    .all(windowType, likePattern) as RawEventRow[];

  const windows = winCandidates.filter((row) => {
    try {
      const evt = JSON.parse(row.payload.toString('utf8'));
      const ids: unknown = evt?.message_ids;
      return Array.isArray(ids) && ids.includes(message_id);
    } catch {
      return false;
    }
  });

  return [...singles, ...windows];
}

/**
 * Handle a chat.message.edited event.
 *
 * For each raw_event derived from this message:
 *   1. Build the text to re-extract (single-message → new_text directly,
 *      windowed → transcript with the edited line replaced).
 *   2. Run extractPipeline with the same mode the original ingest used.
 *   3. In one transaction: insert fresh KUs, mark old KUs superseded_at +
 *      superseded_by → first new KU's id.
 *   4. Best-effort embed + Qdrant upsert per new KU.
 *
 * No-op if no raw_events match.
 */
export async function handleChatMessageEdited(
  evt: ChatMessageEditedEvent,
  opts: ChatEditSyncOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const matches = findRawEventsForMessage(
    db,
    evt.platform,
    evt.chat_id,
    evt.message_id,
  );
  if (matches.length === 0) return;

  for (const raw of matches) {
    const isWindow = raw.source_type.endsWith('_window');
    const mode = isWindow ? ('chat_window' as const) : ('chat_single' as const);

    // Strip `claw save` / `claw merge` text-trigger prefix to match what the
    // original ingest path stored. signal.ts / discord.ts emit
    // `chat.message.saved` with `text = body.replace(/^claw\s+save\b\s*/i,
    // '')` (the regex tail), but edit envelopes carry the FULL edited body
    // — without this strip, re-extraction sees `claw save Pay $X` whereas
    // the original KU was extracted from `Pay $X`. Inconsistent KU text and
    // a small accuracy hit (extractor's cheap rules treat the prefix as
    // noise but it still affects topic_seed normalization).
    const strippedNewText = stripClawTriggerPrefix(evt.new_text);

    let text = strippedNewText;
    let participants: string[] | undefined;
    if (isWindow) {
      try {
        const payload = JSON.parse(raw.payload.toString('utf8'));
        participants = payload.participants;
        text = rebuildWindowTranscript(
          payload,
          evt.message_id,
          strippedNewText,
        );
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            raw_event_id: raw.id,
          },
          'chat-edit-sync: malformed window payload — skipping this raw_event',
        );
        continue;
      }
    }

    // Look up existing non-superseded KUs derived from this raw_event.
    const oldKuIds = (
      db
        .prepare(
          `SELECT id FROM knowledge_units
           WHERE source_type = ? AND source_ref = ? AND superseded_at IS NULL`,
        )
        .all(raw.source_type, raw.source_ref) as Array<{ id: string }>
    ).map((r) => r.id);
    if (oldKuIds.length === 0) continue;

    // Re-extract with the same mode the original ingest used.
    const claims = await extractPipeline(
      { text, mode, participants },
      { llmCaller: opts.llmCaller, db },
    );

    if (claims.length === 0) {
      logger.warn(
        { raw_event_id: raw.id, source_ref: raw.source_ref },
        'chat-edit-sync: re-extraction returned 0 claims — skipping supersession to preserve existing KUs',
      );
      continue;
    }

    const supersededAt = new Date().toISOString();
    const nowIso = new Date().toISOString();
    const validFrom = evt.edited_at;
    const newKuIds: string[] = [];

    db.transaction(() => {
      const insertKu = db.prepare(
        `INSERT INTO knowledge_units
           (id, text, source_type, source_ref, account, scope, confidence,
            valid_from, recorded_at, topic_key, extracted_by, needs_review)
         VALUES (?, ?, ?, ?, 'personal', NULL, ?, ?, ?, ?, ?, ?)`,
      );
      for (const claim of claims) {
        const kuId = newId();
        insertKu.run(
          kuId,
          claim.text,
          raw.source_type,
          raw.source_ref,
          claim.confidence,
          validFrom,
          nowIso,
          claim.topic_key ?? null,
          claim.extracted_by,
          claim.needs_review ? 1 : 0,
        );
        newKuIds.push(kuId);
      }
      const supersededBy = newKuIds[0] ?? null;
      const updateOld = db.prepare(
        `UPDATE knowledge_units
            SET superseded_at = ?, superseded_by = ?
          WHERE id = ?`,
      );
      for (const oldId of oldKuIds) {
        updateOld.run(supersededAt, supersededBy, oldId);
      }
    })();

    // Best-effort embed + upsert for each new KU.
    const modelVersion = getEmbeddingModelVersion();
    for (const kuId of newKuIds) {
      const row = db
        .prepare(`SELECT text, topic_key FROM knowledge_units WHERE id = ?`)
        .get(kuId) as { text: string; topic_key: string | null };
      try {
        const vec = await embedText(row.text, 'document');
        await upsertKu({
          kuId,
          vector: vec,
          payload: {
            account: 'personal',
            scope: null,
            model_version: modelVersion,
            valid_from: validFrom,
            recorded_at: nowIso,
            source_type: raw.source_type,
            topic_key: row.topic_key ?? null,
          },
        });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            kuId,
          },
          'chat-edit-sync: embed/upsert failed for re-extracted KU',
        );
      }
    }
  }
}

/**
 * Remove a leading `claw save` or `claw merge` text-trigger prefix.
 * Mirrors the regex match the channel-side text-trigger uses to extract
 * the tail before emitting `chat.message.saved`. No-op if the trigger
 * isn't present.
 */
function stripClawTriggerPrefix(s: string): string {
  return s.replace(/^claw\s+(save|merge)\b\s*/i, '');
}

/**
 * Reconstruct a windowed transcript with one line replaced. Walks
 * `payload.message_ids[]` in order and uses the corresponding line from
 * `payload.transcript` (split on \n). For the edited id, preserves the
 * existing `[ts] sender: ` prefix and substitutes the new text after the
 * first ': ' on that line.
 */
function rebuildWindowTranscript(
  payload: { message_ids?: string[]; transcript?: string },
  editedId: string,
  newText: string,
): string {
  const ids: string[] = payload.message_ids ?? [];
  const oldLines: string[] = (payload.transcript ?? '').split('\n');
  if (ids.length !== oldLines.length) {
    logger.warn(
      { idsLen: ids.length, linesLen: oldLines.length },
      'chat-edit-sync: message_ids/transcript length mismatch — returning raw transcript without substitution',
    );
    return payload.transcript ?? '';
  }
  return ids
    .map((id, i) => {
      const old = oldLines[i] ?? '';
      if (id !== editedId) return old;
      // Keep "[<ts>] <sender>" prefix; replace text after the first ': '.
      const idx = old.indexOf(': ');
      if (idx < 0) return `${old}: ${newText}`;
      return `${old.slice(0, idx)}: ${newText}`;
    })
    .join('\n');
}

/**
 * Handle a chat.message.deleted event.
 *
 * 1. ALWAYS insert a deletion-marker raw_event (source_type
 *    `<platform>_deletion`, source_ref `<chat_id>:<message_id>`, payload =
 *    event JSON) — even if no KUs derived from this message — so the audit
 *    trail is complete. Idempotent via INSERT OR IGNORE on the existing
 *    UNIQUE (source_type, source_ref) constraint.
 * 2. Find raw_events derived from the message and mark all non-superseded
 *    KUs `superseded_at = evt.deleted_at, superseded_by = NULL`. No
 *    re-extraction; no replacement KU.
 *
 * All writes run in a single transaction.
 */
export async function handleChatMessageDeleted(
  evt: ChatMessageDeletedEvent,
  opts: ChatEditSyncOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const matches = findRawEventsForMessage(
    db,
    evt.platform,
    evt.chat_id,
    evt.message_id,
  );

  db.transaction(() => {
    // 1. Deletion marker — always inserted, idempotent via INSERT OR IGNORE.
    db.prepare(
      `INSERT OR IGNORE INTO raw_events
         (id, source_type, source_ref, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      `${evt.platform}_deletion`,
      `${evt.chat_id}:${evt.message_id}`,
      Buffer.from(JSON.stringify(evt)),
      evt.deleted_at,
    );

    // 2. Tombstone derived KUs.
    if (matches.length > 0) {
      const updateKu = db.prepare(
        `UPDATE knowledge_units
            SET superseded_at = ?, superseded_by = NULL
          WHERE source_type = ? AND source_ref = ? AND superseded_at IS NULL`,
      );
      for (const raw of matches) {
        updateKu.run(evt.deleted_at, raw.source_type, raw.source_ref);
      }
    }
  })();

  if (matches.length > 0) {
    logger.info(
      {
        platform: evt.platform,
        chat_id: evt.chat_id,
        message_id: evt.message_id,
        raw_event_count: matches.length,
      },
      'chat-edit-sync: tombstoned KUs from deleted message',
    );
  }
}

let unsubEdited: (() => void) | null = null;
let unsubDeleted: (() => void) | null = null;

export interface ChatEditSyncStartOpts {
  /** Wired by chat-ingest from ChatIngestOpts.llmCaller for re-extraction. */
  llmCaller?: LlmCaller;
}

/**
 * Subscribe to chat.message.edited + chat.message.deleted on the event bus.
 * Idempotent: a second call before stopChatEditSync() is a no-op.
 */
export function startChatEditSync(opts: ChatEditSyncStartOpts = {}): void {
  if (unsubEdited || unsubDeleted) return;
  unsubEdited = eventBus.on('chat.message.edited', async (evt) => {
    try {
      await handleChatMessageEdited(evt, { llmCaller: opts.llmCaller });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chat_id: evt.chat_id,
          message_id: evt.message_id,
        },
        'chat-edit-sync: edit handler failed',
      );
    }
  });
  unsubDeleted = eventBus.on('chat.message.deleted', async (evt) => {
    try {
      await handleChatMessageDeleted(evt);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chat_id: evt.chat_id,
          message_id: evt.message_id,
        },
        'chat-edit-sync: delete handler failed',
      );
    }
  });
  logger.info(
    'Chat edit-sync started (chat.message.edited + chat.message.deleted)',
  );
}

export function stopChatEditSync(): void {
  if (unsubEdited) {
    unsubEdited();
    unsubEdited = null;
  }
  if (unsubDeleted) {
    unsubDeleted();
    unsubDeleted = null;
  }
}
