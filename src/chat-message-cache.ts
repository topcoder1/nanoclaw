import { getDb } from './db.js';

export interface CachedChatMessage {
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
  sent_at: string;
  sender: string;
  sender_name?: string;
  text?: string;
  reply_to_id?: string;
  attachments?: unknown[];
  edited_at?: string;
  deleted_at?: string;
  attachment_download_attempts?: number;
}

export interface ChatMessageRow extends CachedChatMessage {
  attachment_download_attempts: number;
}

export function putChatMessage(msg: CachedChatMessage): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO chat_messages
       (platform, chat_id, message_id, sent_at, sender, sender_name,
        text, reply_to_id, attachments, edited_at, deleted_at,
        attachment_download_attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
       sent_at      = excluded.sent_at,
       sender       = excluded.sender,
       sender_name  = excluded.sender_name,
       text         = excluded.text,
       reply_to_id  = excluded.reply_to_id,
       attachments  = excluded.attachments,
       edited_at    = excluded.edited_at,
       deleted_at   = excluded.deleted_at`,
  ).run(
    msg.platform,
    msg.chat_id,
    msg.message_id,
    msg.sent_at,
    msg.sender,
    msg.sender_name ?? null,
    msg.text ?? null,
    msg.reply_to_id ?? null,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.edited_at ?? null,
    msg.deleted_at ?? null,
    msg.attachment_download_attempts ?? 0,
  );
  if (observer) {
    try {
      observer(msg);
    } catch {
      // Observer must never break cache writes. PR 2 logs internally.
    }
  }
}

export function getChatMessage(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): ChatMessageRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE platform = ? AND chat_id = ? AND message_id = ?`,
    )
    .get(platform, chat_id, message_id) as
    | (Omit<ChatMessageRow, 'attachments'> & { attachments: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
  } as ChatMessageRow;
}

export function listChatMessages(
  platform: 'discord' | 'signal',
  chat_id: string,
  opts: { limit?: number; sinceIso?: string } = {},
): ChatMessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE platform = ? AND chat_id = ?
         AND (? IS NULL OR sent_at >= ?)
       ORDER BY sent_at DESC
       LIMIT ?`,
    )
    .all(
      platform,
      chat_id,
      opts.sinceIso ?? null,
      opts.sinceIso ?? null,
      opts.limit ?? 200,
    ) as Array<
    Omit<ChatMessageRow, 'attachments'> & { attachments: string | null }
  >;
  return rows.map((r) => ({
    ...r,
    attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
  })) as ChatMessageRow[];
}

export function pruneChatMessages(cutoffIso: string): number {
  const db = getDb();
  const r = db
    .prepare(`DELETE FROM chat_messages WHERE sent_at < ?`)
    .run(cutoffIso);
  return r.changes;
}

export function bumpAttachmentAttempts(
  platform: 'discord' | 'signal',
  chat_id: string,
  message_id: string,
): number {
  const db = getDb();
  db.prepare(
    `UPDATE chat_messages SET attachment_download_attempts = attachment_download_attempts + 1
     WHERE platform = ? AND chat_id = ? AND message_id = ?`,
  ).run(platform, chat_id, message_id);
  const r = db
    .prepare(
      `SELECT attachment_download_attempts AS n FROM chat_messages
       WHERE platform = ? AND chat_id = ? AND message_id = ?`,
    )
    .get(platform, chat_id, message_id) as { n: number } | undefined;
  return r?.n ?? 0;
}

type ChatMessageObserver = (msg: CachedChatMessage) => void;
let observer: ChatMessageObserver | null = null;

/**
 * Register a single observer to be notified after every successful putChatMessage.
 * Single-slot by design (one consumer = window flusher); call with `null` to
 * clear (used by tests). Re-registering replaces the prior observer.
 */
export function registerChatMessageObserver(
  fn: ChatMessageObserver | null,
): void {
  observer = fn;
}
