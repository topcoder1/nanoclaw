/**
 * Chat ingest pipeline — `chat.message.saved` → raw_events → extract → KU.
 *
 * Mirrors the email ingest pattern in `ingest.ts` but for Discord/Signal
 * messages. Each saved chat message:
 *   1. Inserted idempotently into raw_events (UNIQUE on source_type+source_ref)
 *   2. Run through extractPipeline with mode='chat_single'
 *   3. Sender resolved/created via createPersonFromHandle
 *   4. knowledge_units rows inserted
 *   5. ku_entities link inserted for sender
 *   6. Embed + upsert to Qdrant (best-effort — SQLite row stands on Qdrant failure)
 *   7. raw_events.processed_at set
 */

import { eventBus } from '../event-bus.js';
import type {
  ChatMessageSavedEvent,
  ChatWindowFlushedEvent,
} from '../events.js';
import { logger } from '../logger.js';

import { getBrainDb } from './db.js';
import { embedText, getEmbeddingModelVersion } from './embed.js';
import { createPersonFromHandle } from './entities.js';
import { extractPipeline, type LlmCaller } from './extract.js';
import { upsertKu } from './qdrant.js';
import { newId } from './ulid.js';
import {
  startWindowFlusher,
  stopWindowFlusher,
  noteSave,
} from './window-flusher.js';

export interface ChatIngestOpts {
  llmCaller?: LlmCaller;
}

let unsubscribe: (() => void) | null = null;
let unsubscribeWindow: (() => void) | null = null;

/**
 * Start the chat ingest listener. Safe to call multiple times — second call
 * is a no-op if already started.
 */
export function startChatIngest(opts: ChatIngestOpts = {}): void {
  if (unsubscribe) return;
  unsubscribe = eventBus.on(
    'chat.message.saved',
    async (evt: ChatMessageSavedEvent) => {
      try {
        await handleChatMessageSaved(evt, opts);
      } catch (err) {
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            msgId: evt.message_id,
          },
          'chat ingest: handler failed',
        );
      }
    },
  );
  unsubscribeWindow = eventBus.on(
    'chat.window.flushed',
    async (evt: ChatWindowFlushedEvent) => {
      try {
        await handleChatWindowFlushed(evt, opts);
      } catch (err) {
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            chat_id: evt.chat_id,
            window_started_at: evt.window_started_at,
          },
          'chat ingest: window handler failed',
        );
      }
    },
  );
  startWindowFlusher();
  logger.info('Chat ingest started (chat.message.saved handler)');
}

/**
 * Stop the chat ingest listener. Unsubscribes from the event bus.
 */
export function stopChatIngest(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeWindow) {
    unsubscribeWindow();
    unsubscribeWindow = null;
  }
  stopWindowFlusher();
}

async function handleChatMessageSaved(
  evt: ChatMessageSavedEvent,
  opts: ChatIngestOpts,
): Promise<void> {
  const db = getBrainDb();
  const sourceType = `${evt.platform}_message`;
  const sourceRef = `${evt.chat_id}:${evt.message_id}`;
  const receivedAt = new Date(evt.timestamp).toISOString();

  // Step 1: insert raw_event — UNIQUE(source_type, source_ref) deduplicates.
  const rawId = newId();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      rawId,
      sourceType,
      sourceRef,
      Buffer.from(JSON.stringify(evt), 'utf8'),
      receivedAt,
    );

  if (result.changes === 0) {
    logger.debug({ sourceRef }, 'chat ingest: duplicate raw_event, skipping');
    return;
  }

  // Race resolution: if a window is open for this chat, mark this message
  // as excluded so the windowed flush at idle/cap/daily doesn't re-ingest it.
  noteSave(evt.platform, evt.chat_id, evt.message_id);

  // Step 2: run extraction pipeline (chat_single mode always gates through
  // to LLM regardless of signal score — see extract.ts isChat check).
  const claims = await extractPipeline(
    {
      text: evt.text,
      sender: evt.sender_display ?? evt.sender,
      mode: 'chat_single',
    },
    { llmCaller: opts.llmCaller, db },
  );

  // Step 3: resolve/create the sender entity.
  let senderEntityId: string | null = null;
  try {
    const entity = await createPersonFromHandle(
      evt.platform,
      evt.sender,
      evt.sender_display,
    );
    senderEntityId = entity.entity_id;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        sender: evt.sender,
      },
      'chat ingest: entity resolve failed — KU will have no sender link',
    );
  }

  // No claims → mark processed and exit.
  if (claims.length === 0) {
    db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
      receivedAt,
      rawId,
    );
    return;
  }

  // Step 4: insert knowledge_units + ku_entities in a single transaction.
  // valid_from anchors to when the chat message was *sent*, mirroring
  // the email ingest convention of using the source event time, not the
  // extraction wall-clock.
  const nowIso = new Date().toISOString();
  const validFrom =
    evt.sent_at && evt.sent_at.length > 0 ? evt.sent_at : receivedAt;

  const insertKu = db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, confidence,
        valid_from, recorded_at, topic_key, extracted_by, needs_review)
     VALUES (?, ?, ?, ?, 'personal', NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
  );

  const kuRows: Array<{
    id: string;
    text: string;
    topicKey: string | null;
    confidence: number;
  }> = [];

  db.transaction(() => {
    for (const claim of claims) {
      const kuId = newId();
      insertKu.run(
        kuId,
        claim.text,
        sourceType,
        sourceRef,
        claim.confidence,
        validFrom,
        nowIso,
        claim.topic_key ?? null,
        claim.extracted_by,
        claim.needs_review ? 1 : 0,
      );
      if (senderEntityId) {
        insertLink.run(kuId, senderEntityId);
      }
      kuRows.push({
        id: kuId,
        text: claim.text,
        topicKey: claim.topic_key ?? null,
        confidence: claim.confidence,
      });
    }
  })();

  // Step 5: embed + upsert each KU. Best-effort — Qdrant failure does NOT
  // roll back the SQLite write.
  const modelVersion = getEmbeddingModelVersion();
  for (const ku of kuRows) {
    try {
      const vec = await embedText(ku.text, 'document');
      await upsertKu({
        kuId: ku.id,
        vector: vec,
        payload: {
          account: 'personal',
          scope: null,
          model_version: modelVersion,
          valid_from: validFrom,
          recorded_at: nowIso,
          source_type: sourceType,
          topic_key: ku.topicKey ?? null,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          kuId: ku.id,
        },
        'chat ingest: embed/upsert failed — KU stands without vector',
      );
    }
  }

  // Step 6: mark raw_event as processed.
  db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
    nowIso,
    rawId,
  );
}

async function handleChatWindowFlushed(
  evt: ChatWindowFlushedEvent,
  opts: ChatIngestOpts,
): Promise<void> {
  const db = getBrainDb();
  const sourceType = `${evt.platform}_window`;
  const sourceRef = `${evt.chat_id}:${evt.window_started_at}`;
  const receivedAt = new Date(evt.timestamp).toISOString();

  // 1. Idempotent raw_events insert. Payload carries the full event so PR 4
  //    edit-sync can locate windowed messages by message_ids[].
  const rawId = newId();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO raw_events (id, source_type, source_ref, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      rawId,
      sourceType,
      sourceRef,
      Buffer.from(JSON.stringify(evt), 'utf8'),
      receivedAt,
    );
  if (result.changes === 0) {
    logger.debug(
      { sourceRef },
      'chat ingest: duplicate window raw_event, skipping',
    );
    return;
  }

  // 2. Extract claims from the transcript with chat_window mode (uses the
  //    transcript-aware prompt and bypasses the email signal-score gate).
  const claims = await extractPipeline(
    {
      text: evt.transcript,
      mode: 'chat_window',
      participants: evt.participants,
    },
    { llmCaller: opts.llmCaller, db },
  );

  // 3. Resolve every participant → entity. Use sender_display where the
  //    flusher captured one (it's already deduped in evt.participants).
  const participantEntityIds: string[] = [];
  for (const handle of evt.participants) {
    try {
      const entity = await createPersonFromHandle(evt.platform, handle, handle);
      participantEntityIds.push(entity.entity_id);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          handle,
        },
        'chat ingest: window participant resolve failed',
      );
    }
  }

  if (claims.length === 0) {
    db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
      receivedAt,
      rawId,
    );
    return;
  }

  // 4. KU + ku_entities (one link per participant) in a single transaction.
  const nowIso = new Date().toISOString();
  const validFrom = evt.window_ended_at;
  const insertKu = db.prepare(
    `INSERT INTO knowledge_units
       (id, text, source_type, source_ref, account, scope, confidence,
        valid_from, recorded_at, topic_key, extracted_by, needs_review)
     VALUES (?, ?, ?, ?, 'personal', NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO ku_entities (ku_id, entity_id, role) VALUES (?, ?, 'mentioned')`,
  );

  const kuRows: Array<{ id: string; text: string; topicKey: string | null }> =
    [];

  db.transaction(() => {
    for (const claim of claims) {
      const kuId = newId();
      insertKu.run(
        kuId,
        claim.text,
        sourceType,
        sourceRef,
        claim.confidence,
        validFrom,
        nowIso,
        claim.topic_key ?? null,
        claim.extracted_by,
        claim.needs_review ? 1 : 0,
      );
      for (const eid of participantEntityIds) {
        insertLink.run(kuId, eid);
      }
      kuRows.push({
        id: kuId,
        text: claim.text,
        topicKey: claim.topic_key ?? null,
      });
    }
  })();

  // 5. Embed + upsert (best-effort).
  const modelVersion = getEmbeddingModelVersion();
  for (const ku of kuRows) {
    try {
      const vec = await embedText(ku.text, 'document');
      await upsertKu({
        kuId: ku.id,
        vector: vec,
        payload: {
          account: 'personal',
          scope: null,
          model_version: modelVersion,
          valid_from: validFrom,
          recorded_at: nowIso,
          source_type: sourceType,
          topic_key: ku.topicKey ?? null,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          kuId: ku.id,
        },
        'chat ingest (window): embed/upsert failed — KU stands without vector',
      );
    }
  }

  db.prepare(`UPDATE raw_events SET processed_at = ? WHERE id = ?`).run(
    nowIso,
    rawId,
  );
}
