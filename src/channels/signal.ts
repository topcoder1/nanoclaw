import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { eventBus } from '../event-bus.js';
import { putChatMessage, getChatMessage } from '../chat-message-cache.js';
import type {
  ChatMessageSavedEvent,
  ChatMessageEditedEvent,
  ChatMessageDeletedEvent,
} from '../events.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface DataMessage {
  timestamp: number;
  message?: string | null;
  expiresInSeconds?: number;
  viewOnce?: boolean;
  attachments?: Array<{
    id?: string;
    contentType: string;
    filename?: string;
    size?: number;
  }>;
  groupInfo?: { groupId: string; type: string };
  reaction?: {
    emoji: string;
    targetAuthor: string;
    targetSentTimestamp: number;
    isRemove?: boolean;
  };
  editMessage?: {
    targetSentTimestamp: number;
    dataMessage: { message?: string | null };
  };
  remoteDelete?: { timestamp: number };
}

interface SyncMessage {
  sentMessage?: DataMessage & {
    destination?: string;
    destinationNumber?: string;
    destinationUuid?: string;
  };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: DataMessage;
  syncMessage?: SyncMessage;
}

interface SignalPayload {
  envelope?: SignalEnvelope;
  account?: string;
}

const POLL_INTERVAL_MS = 2000;

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private closed = false;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl;
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.connected = true;
    logger.info(
      { phone: this.phoneNumber, apiUrl: this.apiUrl },
      'Signal channel connected (polling mode)',
    );
    console.log(
      `\n  Signal channel: polling ${this.apiUrl} every ${POLL_INTERVAL_MS / 1000}s\n`,
    );
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const res = await fetch(`${this.apiUrl}/v1/receive/${this.phoneNumber}`);
      if (!res.ok) {
        logger.warn({ status: res.status }, 'Signal: poll returned non-OK');
      } else {
        const payloads = (await res.json()) as SignalPayload[];
        if (payloads.length > 0) {
          logger.info(
            { count: payloads.length },
            'Signal: poll received messages',
          );
        }
        for (const payload of payloads) {
          this.handleEnvelope(payload);
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Signal: poll failed');
    }
    this.schedulePoll();
  }

  private handleEnvelope(data: SignalPayload): void {
    const envelope = data.envelope;
    if (!envelope) return;

    // Messages from others arrive as dataMessage.
    // Messages sent from our own phone arrive as syncMessage.sentMessage.
    const dataMsg =
      envelope.dataMessage ?? envelope.syncMessage?.sentMessage ?? null;

    logger.info(
      {
        hasDataMessage: !!envelope.dataMessage,
        hasSyncMessage: !!envelope.syncMessage,
        hasSentMessage: !!envelope.syncMessage?.sentMessage,
        resolvedDataMsg: !!dataMsg,
        source: envelope.sourceNumber,
      },
      'Signal: processing envelope',
    );

    if (!dataMsg) return;

    const isSyncMessage = !envelope.dataMessage && !!envelope.syncMessage;

    const sourceNumber = envelope.sourceNumber ?? envelope.source ?? '';
    const sourceName = envelope.sourceName ?? '';
    const timestamp = new Date(envelope.timestamp).toISOString();

    // For sync messages (sent from our phone), the chat target is the destination,
    // not the source (which is always us). For "Note to Self", destination = source.
    const isGroup = Boolean(dataMsg.groupInfo?.groupId);
    let chatJid: string;
    if (isGroup) {
      chatJid = `sig:group:${dataMsg.groupInfo!.groupId}`;
    } else if (isSyncMessage && 'destinationNumber' in dataMsg) {
      const dest =
        (dataMsg as { destinationNumber?: string }).destinationNumber ??
        sourceNumber;
      chatJid = `sig:${dest}`;
    } else {
      chatJid = `sig:${sourceNumber}`;
    }

    // --- New behaviors: cache write, 🧠 reaction, claw save ---

    const sourceJid = envelope.source ?? envelope.sourceNumber ?? 'unknown';
    const chatId = dataMsg.groupInfo?.groupId ?? sourceJid;
    const messageId = String(dataMsg.timestamp);
    const sentAt = new Date(dataMsg.timestamp).toISOString();

    // 1. Reaction → emit save event if emoji matches and not a remove.
    if (dataMsg.reaction) {
      if (dataMsg.reaction.isRemove) return;
      const target = process.env.BRAIN_SAVE_EMOJI ?? '🧠';
      if (dataMsg.reaction.emoji !== target) return;
      const targetAuthor = dataMsg.reaction.targetAuthor;
      const targetTs = String(dataMsg.reaction.targetSentTimestamp);
      const targetChatId = dataMsg.groupInfo?.groupId ?? targetAuthor;
      const cached = getChatMessage('signal', targetChatId, targetTs);
      if (!cached) {
        logger.warn(
          { targetTs, targetChatId },
          'Signal 🧠-react: target not cached',
        );
        return;
      }
      eventBus.emit('chat.message.saved', {
        type: 'chat.message.saved',
        timestamp: Date.now(),
        source: 'signal',
        payload: {},
        platform: 'signal',
        chat_id: targetChatId,
        message_id: targetTs,
        sender: cached.sender,
        sender_display: cached.sender_name,
        sent_at: cached.sent_at,
        text: cached.text ?? '',
        trigger: 'emoji',
      } satisfies ChatMessageSavedEvent);
      return;
    }

    // 2. `claw save` text trigger.
    const body = dataMsg.message?.trim() ?? '';
    const clawMatch = body.match(/^claw\s+save\b\s*(.*)$/i);
    if (clawMatch) {
      const tail = clawMatch[1].trim();
      eventBus.emit('chat.message.saved', {
        type: 'chat.message.saved',
        timestamp: Date.now(),
        source: 'signal',
        payload: {},
        platform: 'signal',
        chat_id: chatId,
        message_id: messageId,
        sender: sourceJid,
        sender_display: envelope.sourceName,
        sent_at: sentAt,
        text: tail,
        trigger: 'text',
      } satisfies ChatMessageSavedEvent);
      return;
    }

    // 4. editMessage envelope: emit chat.message.edited; UPSERT cache.
    if (dataMsg.editMessage) {
      const targetTs = dataMsg.editMessage.targetSentTimestamp;
      const originalId = String(targetTs);
      const newText = dataMsg.editMessage.dataMessage.message ?? '';
      const cached = getChatMessage('signal', chatId, originalId);
      const editedAtIso = new Date(envelope.timestamp).toISOString();
      putChatMessage({
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        sent_at: cached?.sent_at ?? editedAtIso,
        sender: sourceJid,
        sender_name: envelope.sourceName,
        text: newText,
        edited_at: editedAtIso,
      });
      eventBus.emit('chat.message.edited', {
        type: 'chat.message.edited',
        source: 'signal',
        timestamp: envelope.timestamp,
        payload: {},
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        old_text: cached?.text ?? null,
        new_text: newText,
        edited_at: editedAtIso,
        sender: sourceJid,
      } satisfies ChatMessageEditedEvent);
      return;
    }

    // 5. remoteDelete envelope: emit chat.message.deleted; tombstone cache.
    if (dataMsg.remoteDelete) {
      const targetTs = dataMsg.remoteDelete.timestamp;
      const originalId = String(targetTs);
      const deletedAtIso = new Date(envelope.timestamp).toISOString();
      const cached = getChatMessage('signal', chatId, originalId);
      putChatMessage({
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        sent_at: cached?.sent_at ?? deletedAtIso,
        sender: cached?.sender ?? sourceJid,
        sender_name: cached?.sender_name ?? envelope.sourceName,
        text: cached?.text,
        deleted_at: deletedAtIso,
      });
      eventBus.emit('chat.message.deleted', {
        type: 'chat.message.deleted',
        source: 'signal',
        timestamp: envelope.timestamp,
        payload: {},
        platform: 'signal',
        chat_id: chatId,
        message_id: originalId,
        deleted_at: deletedAtIso,
      } satisfies ChatMessageDeletedEvent);
      return;
    }

    // 3. Cache the message for future reaction lookups.
    if (body || (dataMsg.attachments?.length ?? 0) > 0) {
      putChatMessage({
        platform: 'signal',
        chat_id: chatId,
        message_id: messageId,
        sent_at: sentAt,
        sender: sourceJid,
        sender_name: envelope.sourceName,
        text: body || undefined,
      });
    }

    // --- Existing inbound-message routing ---

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? undefined : sourceName,
      'signal',
      isGroup,
    );

    const content = this.extractContent(dataMsg);
    logger.info(
      { chatJid, content, message: dataMsg.message },
      'Signal: extracted content',
    );
    if (content === null) return;

    const groups = this.opts.registeredGroups();
    const registered = chatJid in groups;
    logger.info(
      { chatJid, registered, groupCount: Object.keys(groups).length },
      'Signal: group check',
    );
    if (!registered) return;

    const is_from_me = isSyncMessage || sourceNumber === this.phoneNumber;

    this.opts.onMessage(chatJid, {
      id: `${envelope.timestamp}-${sourceNumber}`,
      chat_jid: chatJid,
      sender: sourceNumber,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me: is_from_me,
    });
  }

  private extractContent(dataMsg: DataMessage): string | null {
    if (dataMsg.message) return dataMsg.message;

    if (dataMsg.attachments && dataMsg.attachments.length > 0) {
      const att = dataMsg.attachments[0];
      const ct = att.contentType ?? '';
      if (ct.startsWith('image/')) return '[Photo]';
      if (ct.startsWith('video/')) return '[Video]';
      if (ct.startsWith('audio/')) return '[Voice message]';
      return `[Document: ${att.filename ?? 'file'}]`;
    }

    return null;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const MAX_LENGTH = 4096;
    try {
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );
      for (const chunk of chunks) {
        const body = this.buildSendBody(jid, chunk);
        const res = await fetch(`${this.apiUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          logger.warn(
            { jid, status: res.status },
            'Signal: send returned non-OK status',
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  private buildSendBody(jid: string, message: string): Record<string, unknown> {
    if (jid.startsWith('sig:group:')) {
      const groupId = jid.slice('sig:group:'.length);
      return { number: this.phoneNumber, recipients: [groupId], message };
    }
    const recipient = jid.slice('sig:'.length);
    return { number: this.phoneNumber, recipients: [recipient], message };
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.connected = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    try {
      const recipient = jid.startsWith('sig:group:')
        ? jid.slice('sig:group:'.length)
        : jid.slice('sig:'.length);
      await fetch(`${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient }),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_API_URL', 'SIGNAL_PHONE_NUMBER']);
  const apiUrl = process.env.SIGNAL_API_URL || envVars.SIGNAL_API_URL || '';
  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';

  if (!apiUrl) {
    logger.warn('Signal: SIGNAL_API_URL not set');
    return null;
  }
  if (!phoneNumber) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }

  return new SignalChannel(apiUrl, phoneNumber, opts);
});
