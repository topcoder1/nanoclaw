import { getDb } from '../db.js';
import { sendTelegramMessage } from '../channels/telegram.js';
import { readEnvValue } from '../env.js';
import { logger } from '../logger.js';

/**
 * Cluster key for grouping near-duplicate titles into one reminder.
 * Lowercases, collapses whitespace, and replaces digit runs with `#` so
 * "Build #1234 failed" and "Build #1235 failed" reduce to the same key.
 */
function clusterKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scan tracked_items for attention-queue items that are still open
 * (state IN ('pushed','pending')) and older than `windowHours` since detection,
 * and that have never been reminded. Cluster near-duplicate titles and send
 * one consolidated reminder per cluster, stamping `reminded_at` on every row
 * in the cluster so we never re-send.
 */
export async function runAttentionReminderSweep(opts: {
  windowHours: number;
}): Promise<void> {
  const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
  if (!chatId) return;

  const windowMs = opts.windowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  const rows = getDb()
    .prepare(
      `SELECT id, title FROM tracked_items
       WHERE state IN ('pushed', 'pending')
         AND detected_at <= ?
         AND reminded_at IS NULL`,
    )
    .all(cutoff) as Array<{ id: string; title: string }>;

  if (rows.length === 0) return;

  // Group by normalized title so N similar items become one reminder.
  const clusters = new Map<string, { title: string; ids: string[] }>();
  for (const r of rows) {
    const key = clusterKey(r.title);
    const existing = clusters.get(key);
    if (existing) existing.ids.push(r.id);
    else clusters.set(key, { title: r.title, ids: [r.id] });
  }

  const db = getDb();

  for (const cluster of clusters.values()) {
    // Atomic CAS: stamp every row in the cluster, count how many we won.
    // Stamping BEFORE the send means a crash mid-send means we skip the
    // reminder — preferable to double-reminding the user. A concurrent
    // sweep claiming some of these IDs is also handled: we only send a
    // reminder reflecting the rows we actually won.
    const placeholders = cluster.ids.map(() => '?').join(',');
    const result = db
      .prepare(
        `UPDATE tracked_items SET reminded_at = ?
         WHERE id IN (${placeholders}) AND reminded_at IS NULL`,
      )
      .run(Date.now(), ...cluster.ids);
    const won = result.changes;
    if (won === 0) continue;

    const text =
      won > 1
        ? `⏰ ${won} still waiting: *${cluster.title}*`
        : `⏰ Still waiting on you: *${cluster.title}*`;

    try {
      await sendTelegramMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.warn(
        { err: String(err), clusterTitle: cluster.title, count: won },
        'Triage: failed to send attention reminder (already marked reminded)',
      );
    }
  }
}
