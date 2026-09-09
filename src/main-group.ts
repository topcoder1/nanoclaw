/**
 * main-group — shared resolution for "which JID is the main group?".
 *
 * Multiple `is_main=1` rows legitimately coexist, one per channel (WhatsApp,
 * Telegram, Discord). Taking the first one blindly hands, say, a WhatsApp JID
 * to grammy and the send fails with `400: chat not found`. Every caller must
 * pick the main group whose JID a connected channel actually owns.
 */

import { Channel, RegisteredGroup } from './types.js';

/**
 * The JID of the main group owned by one of `channels`, or null when no
 * channel owns any `is_main` row. Pass a single-element array to restrict the
 * lookup to one channel (e.g. "the main group Telegram owns").
 */
export function findMainGroupJid(
  groups: Record<string, RegisteredGroup>,
  channels: Channel[],
): string | null {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain && channels.some((c) => c.ownsJid(jid))) return jid;
  }
  return null;
}
