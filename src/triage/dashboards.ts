import {
  editTelegramMessage,
  getChatPinnedMessageId,
  pinTelegramMessage,
  sendTelegramMessage,
} from '../channels/telegram.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface DashboardItem {
  id: string;
  title: string;
  reason: string;
  ageMins: number;
}

export interface DashboardInput {
  chatId: string;
  items: DashboardItem[];
}

export interface ArchiveDashboardInput {
  chatId: string;
  counts: Record<string, number>;
  total: number;
  nextDigestHuman: string;
}

const DIVIDER = '────────────────────';

function fmtAttention(items: DashboardItem[]): string {
  const header = `📥 Attention — ${items.length} open`;
  if (items.length === 0) {
    return `${header}\n${DIVIDER}\n(inbox is clear — nothing requires you right now)\n\nLast update: ${new Date().toLocaleTimeString()}`;
  }
  const top = items.slice(0, 5);
  const lines = top.map(
    (it, i) => `${i + 1}. [${it.reason}] ${it.title} · ${it.ageMins}m ago`,
  );
  const tail =
    items.length > 5
      ? `\n+${items.length - 5} more · /attention for full list`
      : '';
  return `${header}\n${DIVIDER}\n${lines.join('\n')}${tail}\n\nLast update: ${new Date().toLocaleTimeString()}`;
}

function fmtArchive(input: ArchiveDashboardInput): string {
  const header = `🗂 Archive queue — ${input.total} pending`;
  const entries = Object.entries(input.counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return `${header}\n${DIVIDER}\n(nothing queued for archive)\n\nNext digest: ${input.nextDigestHuman}\nLast update: ${new Date().toLocaleTimeString()}`;
  }
  const lines = entries.map(([cat, n]) => `• ${cat}: ${n}`);
  return `${header}\n${DIVIDER}\n${lines.join('\n')}\n\nNext digest: ${input.nextDigestHuman}\nLast update: ${new Date().toLocaleTimeString()}`;
}

/**
 * Upsert a pinned dashboard for a given topic. On first call, posts + pins a
 * new message. On subsequent calls, edits the existing pinned message in
 * place. All Telegram errors are logged at warn and swallowed so a failed
 * dashboard update never blocks the caller.
 */
async function upsertDashboard(
  topic: string,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(`SELECT pinned_msg_id FROM triage_dashboards WHERE topic = ?`)
    .get(topic) as { pinned_msg_id: number | null } | undefined;

  const createFresh = async (): Promise<void> => {
    try {
      const sent = await sendTelegramMessage(
        chatId,
        text,
        replyMarkup ? { reply_markup: replyMarkup } : undefined,
      );
      await pinTelegramMessage(chatId, sent.message_id);
      db.prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           telegram_chat_id = excluded.telegram_chat_id,
           pinned_msg_id = excluded.pinned_msg_id,
           last_rendered_at = excluded.last_rendered_at`,
      ).run(topic, chatId, sent.message_id, Date.now());
    } catch (err) {
      logger.warn(
        { err: String(err), topic },
        'Failed to create triage dashboard',
      );
    }
  };

  if (!row || row.pinned_msg_id === null) {
    await createFresh();
    return;
  }

  // Drift guard: a successful editMessageText on an old, no-longer-pinned
  // message is silently invisible to the user — Telegram allows arbitrary
  // edits on past messages but the chat header keeps showing whichever
  // message is currently pinned. Verify our cached id is still the active
  // pin before editing; if drift is detected (DB migration, manual unpin,
  // out-of-band re-pin), clear the row and post a fresh dashboard instead.
  const actualPinned = await getChatPinnedMessageId(chatId);
  if (actualPinned !== null && actualPinned !== row.pinned_msg_id) {
    logger.warn(
      { topic, cached: row.pinned_msg_id, actual: actualPinned },
      'Dashboard pin drift detected — re-creating',
    );
    db.prepare(`DELETE FROM triage_dashboards WHERE topic = ?`).run(topic);
    await createFresh();
    return;
  }

  try {
    if (replyMarkup) {
      await editTelegramMessage(chatId, row.pinned_msg_id, text, {
        reply_markup: replyMarkup,
      });
    } else {
      await editTelegramMessage(chatId, row.pinned_msg_id, text);
    }
    db.prepare(
      `UPDATE triage_dashboards SET last_rendered_at = ? WHERE topic = ?`,
    ).run(Date.now(), topic);
  } catch (err) {
    logger.warn(
      { err: String(err), topic, msgId: row.pinned_msg_id },
      'Failed to edit triage dashboard',
    );
  }
}

export async function renderAttentionDashboard(
  input: DashboardInput,
): Promise<void> {
  // Skip posting/editing when the queue is empty. Every classified email
  // triggered an attention-dashboard render even when nothing needed
  // attention, which refreshed the pinned "Attention — 0 open" message on
  // each new event and added noise. The last non-empty state stays
  // visible until real attention traffic arrives.
  if (input.items.length === 0) return;
  await upsertDashboard('attention', input.chatId, fmtAttention(input.items));
}

export async function renderArchiveDashboard(
  input: ArchiveDashboardInput,
): Promise<void> {
  // Suppress the fresh post+pin path when there's nothing to show. The
  // first-time create branch in upsertDashboard sends the message and
  // pins it, both of which fire Telegram notifications — emitting a
  // "0 pending" pinned message after a state reset (or on a clean
  // install) is pure noise. If a dashboard already exists, we still
  // edit it in place so the user sees the live count drop to 0; edits
  // are silent.
  if (input.total === 0) {
    const row = getDb()
      .prepare(`SELECT pinned_msg_id FROM triage_dashboards WHERE topic = ?`)
      .get('archive') as { pinned_msg_id: number | null } | undefined;
    if (!row || row.pinned_msg_id === null) return;
  }

  // Inline "Archive all" button on the archive dashboard — one click to
  // mass-resolve everything in the queue. Only attach when there's
  // something to archive; otherwise the keyboard is a no-op.
  const replyMarkup =
    input.total > 0
      ? {
          inline_keyboard: [
            [
              {
                text: `🗃 Archive all ${input.total}`,
                callback_data: 'triage:archive_all',
              },
            ],
          ],
        }
      : undefined;
  await upsertDashboard(
    'archive',
    input.chatId,
    fmtArchive(input),
    replyMarkup,
  );
}
