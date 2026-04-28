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

export interface RawEventRow {
  id: string;
  source_type: string;
  source_ref: string;
  payload: Buffer;
  received_at: string;
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
