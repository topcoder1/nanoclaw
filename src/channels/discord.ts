import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { eventBus } from '../event-bus.js';
import { putChatMessage, getChatMessage } from '../chat-message-cache.js';
import { parseMergeArgs } from './parse-merge-args.js';
import type {
  ChatMessageSavedEvent,
  ChatMessageEditedEvent,
  ChatMessageDeletedEvent,
  EntityMergeRequestedEvent,
  EntityMergeRejectRequestedEvent,
  EntityUnmergeRequestedEvent,
} from '../events.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // `claw merge-reject <a> <b>` text trigger. MUST come before the
      // `claw merge` matcher because `\b` would otherwise let
      // `claw merge-reject ...` fall into the merge handler.
      const rawContent = message.content ?? '';
      const rejectMatch = rawContent.match(/^claw\s+merge-reject\b\s*(.+)$/i);
      if (rejectMatch) {
        const args = parseMergeArgs(rejectMatch[1].trim());
        if (args.length === 2) {
          eventBus.emit('entity.merge.reject.requested', {
            type: 'entity.merge.reject.requested',
            source: 'discord',
            timestamp: Date.now(),
            payload: {},
            platform: 'discord',
            chat_id: message.channelId,
            requested_by_handle:
              message.member?.displayName ??
              message.author?.username ??
              'unknown',
            handle_a: args[0],
            handle_b: args[1],
          } satisfies EntityMergeRejectRequestedEvent);
        } else {
          logger.warn(
            { content: rawContent, parsed: args },
            'discord: claw merge-reject needs exactly two handles — ignoring',
          );
        }
        return;
      }

      // `claw merge <a> <b>` text trigger — operator-issued identity merge.
      const mergeMatch = rawContent.match(/^claw\s+merge\b\s*(.+)$/i);
      if (mergeMatch) {
        const args = parseMergeArgs(mergeMatch[1].trim());
        if (args.length === 2) {
          eventBus.emit('entity.merge.requested', {
            type: 'entity.merge.requested',
            source: 'discord',
            timestamp: Date.now(),
            payload: {},
            platform: 'discord',
            chat_id: message.channelId,
            requested_by_handle:
              message.member?.displayName ??
              message.author?.username ??
              'unknown',
            handle_a: args[0],
            handle_b: args[1],
          } satisfies EntityMergeRequestedEvent);
        } else {
          logger.warn(
            { content: rawContent, parsed: args },
            'discord: claw merge needs exactly two handles — ignoring',
          );
        }
        return;
      }

      // `claw unmerge <merge_id> [--force]` text trigger — operator-issued
      // undo of a prior merge. Strip a trailing `--force` token, leaving the
      // rest as the merge_id (or prefix). The handler resolves the prefix.
      const unmergeMatch = rawContent.match(/^claw\s+unmerge\b\s*(.+)$/i);
      if (unmergeMatch) {
        const arg = unmergeMatch[1].trim();
        if (arg) {
          const tokens = arg.split(/\s+/);
          const force =
            tokens.length > 1 && tokens[tokens.length - 1] === '--force';
          const prefix = force ? tokens.slice(0, -1).join(' ') : arg;
          eventBus.emit('entity.unmerge.requested', {
            type: 'entity.unmerge.requested',
            source: 'discord',
            timestamp: Date.now(),
            payload: {},
            platform: 'discord',
            chat_id: message.channelId,
            requested_by_handle:
              message.member?.displayName ??
              message.author?.username ??
              'unknown',
            merge_id_or_prefix: prefix,
            force,
          } satisfies EntityUnmergeRequestedEvent);
        } else {
          logger.warn(
            { content: rawContent },
            'discord: claw unmerge needs a merge_id or prefix — ignoring',
          );
        }
        return;
      }

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Cache the message for reaction/slash triggers
      putChatMessage({
        platform: 'discord',
        chat_id: channelId,
        message_id: msgId,
        sent_at: timestamp,
        sender,
        sender_name: senderName,
        text: message.content,
        reply_to_id: message.reference?.messageId ?? undefined,
      });

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Cache updates for edited messages + emit chat.message.edited (PR 4).
    this.client.on(Events.MessageUpdate, async (_old, message) => {
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return;
        }
      }
      if (message.author?.bot) return;
      // Capture pre-edit cache row BEFORE we overwrite it.
      const previous = getChatMessage('discord', message.channelId, message.id);
      const editedAtIso =
        message.editedAt?.toISOString() ?? new Date().toISOString();
      putChatMessage({
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        sent_at: message.createdAt.toISOString(),
        sender: message.author?.id ?? 'unknown',
        sender_name: message.member?.displayName ?? message.author?.username,
        text: message.content,
        edited_at: editedAtIso,
      });
      eventBus.emit('chat.message.edited', {
        type: 'chat.message.edited',
        source: 'discord',
        timestamp: Date.now(),
        payload: {},
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        old_text: previous?.text ?? null,
        new_text: message.content ?? '',
        edited_at: editedAtIso,
        sender: message.author?.id ?? 'unknown',
      } satisfies ChatMessageEditedEvent);
    });

    // MessageDelete: tombstone cache + emit chat.message.deleted (PR 4).
    this.client.on(Events.MessageDelete, async (message) => {
      const deletedAtIso = new Date().toISOString();
      const cached = getChatMessage('discord', message.channelId, message.id);
      if (cached) {
        // Preserve prior fields; just set deleted_at.
        putChatMessage({
          ...cached,
          deleted_at: deletedAtIso,
        });
      }
      eventBus.emit('chat.message.deleted', {
        type: 'chat.message.deleted',
        source: 'discord',
        timestamp: Date.now(),
        payload: {},
        platform: 'discord',
        chat_id: message.channelId,
        message_id: message.id,
        deleted_at: deletedAtIso,
      } satisfies ChatMessageDeletedEvent);
    });

    // 🧠 emoji reaction → emit ChatMessageSavedEvent
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      const targetEmoji = process.env.BRAIN_SAVE_EMOJI ?? '🧠';
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }
      if (reaction.emoji.name !== targetEmoji) return;
      if (user.id === this.client?.user?.id) return; // ignore self

      const cached = getChatMessage(
        'discord',
        reaction.message.channelId,
        reaction.message.id,
      );
      if (!cached) {
        logger.warn(
          {
            messageId: reaction.message.id,
            channelId: reaction.message.channelId,
          },
          'Discord 🧠-react: message not in cache (older than TTL?)',
        );
        return;
      }
      const evt: ChatMessageSavedEvent = {
        type: 'chat.message.saved',
        timestamp: Date.now(),
        source: 'discord',
        payload: {},
        platform: 'discord',
        chat_id: reaction.message.channelId,
        message_id: reaction.message.id,
        sender: cached.sender,
        sender_display: cached.sender_name,
        sent_at: cached.sent_at,
        text: cached.text ?? '',
        trigger: 'emoji',
      };
      eventBus.emit('chat.message.saved', evt);
    });

    // /save slash command → emit ChatMessageSavedEvent
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (
        !interaction.isChatInputCommand() ||
        interaction.commandName !== 'save'
      )
        return;
      const text = interaction.options.getString('text', true);
      const evt: ChatMessageSavedEvent = {
        type: 'chat.message.saved',
        timestamp: Date.now(),
        source: 'discord',
        payload: {},
        platform: 'discord',
        chat_id: interaction.channelId ?? `dm:${interaction.user.id}`,
        message_id: interaction.id,
        sender: interaction.user.id,
        sender_display: interaction.user.username,
        sent_at: new Date().toISOString(),
        text,
        trigger: 'slash',
      };
      eventBus.emit('chat.message.saved', evt);
      await interaction.reply({ content: `🧠 saved.`, ephemeral: true });
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        // Register /save slash command
        try {
          await readyClient.application?.commands.create({
            name: 'save',
            description: 'Save text to your brain',
            options: [
              {
                name: 'text',
                description: 'What to save',
                type: 3,
                required: true,
              },
            ], // 3 = STRING
          });
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Discord /save command registration failed',
          );
        }
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
