/**
 * Unified outbound messaging.
 * Routes messages to Chat SDK adapters or legacy channels.
 *
 * When a Chat SDK handler is alive for a JID, send() uses its Thread
 * (enabling streaming, typing, and rich cards). Otherwise, constructs
 * a bare ThreadImpl as fallback.
 */
import { EventEmitter } from 'events';

import { ThreadImpl } from 'chat';
import type { Thread } from 'chat';

import { logger } from './logger.js';
import { resolveJid } from './jid-map.js';
import { findChannel } from './router.js';
import type { Channel } from './types.js';

// --- Active handler threads ---

/** Maps JID → the handler's live Thread object. */
const activeHandlerThreads = new Map<string, Thread>();

/** Register a handler's Thread for a JID. Called when handler starts. */
export function registerHandlerThread(jid: string, thread: Thread): void {
  activeHandlerThreads.set(jid, thread);
}

/** Unregister a handler's Thread. Called when handler exits. */
export function unregisterHandlerThread(jid: string): void {
  activeHandlerThreads.delete(jid);
}

/** Check if a handler is already active for a JID. */
export function hasActiveHandler(jid: string): boolean {
  return activeHandlerThreads.has(jid);
}

// --- Group processing events ---

/** Emits `done:{jid}` when processGroupMessages completes for a JID. */
export const groupEvents = new EventEmitter();

/**
 * Wait for group processing to complete for a JID.
 * Returns when the `done:{jid}` event fires, or after timeoutMs.
 */
export function waitForGroupDone(
  jid: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const onDone = () => {
      clearTimeout(timer);
      // Grace period for any final IPC messages to arrive
      setTimeout(resolve, 2000);
    };
    groupEvents.once(`done:${jid}`, onDone);
  });
}

// --- Legacy channels ---

let legacyChannels: Channel[] = [];

export function setLegacyChannels(channels: Channel[]): void {
  legacyChannels = channels;
}

// --- Send ---

/**
 * Send a message to a JID.
 * Uses active handler's Thread if available (enables streaming/cards).
 * Falls back to constructing ThreadImpl, then legacy channel.
 */
export async function send(jid: string, text: string): Promise<void> {
  // Use the active handler's thread if one is alive for this JID
  const activeThread = activeHandlerThreads.get(jid);
  if (activeThread) {
    try {
      await activeThread.post({ markdown: text });
      return;
    } catch (err) {
      logger.warn(
        { jid, err },
        'Active handler thread.post failed, trying fallback',
      );
    }
  }

  // Construct a bare ThreadImpl from the JID map
  const mapping = resolveJid(jid);
  if (mapping) {
    try {
      const channelId = deriveChannelId(mapping.threadId);
      const thread = new ThreadImpl({
        id: mapping.threadId,
        channelId,
        adapterName: mapping.adapterName,
      });
      await thread.post({ markdown: text });
      return;
    } catch (err) {
      logger.warn(
        { jid, adapter: mapping.adapterName, err },
        'Chat SDK send failed, trying legacy fallback',
      );
    }
  }

  // Legacy channel fallback
  const channel = findChannel(legacyChannels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel or adapter found for JID');
    return;
  }
  await channel.sendMessage(jid, text);
}

/** Send typing indicator. Uses active handler thread if available. */
export async function sendTyping(jid: string): Promise<void> {
  const activeThread = activeHandlerThreads.get(jid);
  if (activeThread) {
    try {
      await activeThread.startTyping();
      return;
    } catch {
      // Best-effort
    }
  }

  const mapping = resolveJid(jid);
  if (mapping) {
    try {
      const channelId = deriveChannelId(mapping.threadId);
      const thread = new ThreadImpl({
        id: mapping.threadId,
        channelId,
        adapterName: mapping.adapterName,
      });
      await thread.startTyping();
      return;
    } catch {
      // Best-effort
    }
  }

  const channel = findChannel(legacyChannels, jid);
  await channel?.setTyping?.(jid, true);
}

function deriveChannelId(threadId: string): string {
  const parts = threadId.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return threadId;
}
