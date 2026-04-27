import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, _closeDatabase } from './db.js';
import {
  putChatMessage,
  getChatMessage,
  pruneChatMessages,
  listChatMessages,
  type CachedChatMessage,
} from './chat-message-cache.js';

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  _closeDatabase();
});

describe('chat-message-cache', () => {
  const sample: CachedChatMessage = {
    platform: 'discord',
    chat_id: 'channel-1',
    message_id: 'msg-1',
    sent_at: '2026-04-27T12:00:00.000Z',
    sender: 'user-1',
    sender_name: 'Alice',
    text: 'hello world',
  };

  it('stores and retrieves a message by composite key', () => {
    putChatMessage(sample);
    const got = getChatMessage('discord', 'channel-1', 'msg-1');
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hello world');
    expect(got!.sender_name).toBe('Alice');
  });

  it('returns null for an unknown message', () => {
    expect(getChatMessage('discord', 'channel-1', 'missing')).toBeNull();
  });

  it('upserts on conflicting key — newer write replaces older', () => {
    putChatMessage(sample);
    putChatMessage({ ...sample, text: 'edited body', edited_at: '2026-04-27T12:05:00.000Z' });
    const got = getChatMessage('discord', 'channel-1', 'msg-1')!;
    expect(got.text).toBe('edited body');
    expect(got.edited_at).toBe('2026-04-27T12:05:00.000Z');
  });

  it('prunes rows older than the cutoff', () => {
    putChatMessage({ ...sample, message_id: 'old', sent_at: '2026-04-25T00:00:00.000Z' });
    putChatMessage({ ...sample, message_id: 'new', sent_at: '2026-04-27T12:00:00.000Z' });
    const removed = pruneChatMessages('2026-04-26T00:00:00.000Z');
    expect(removed).toBe(1);
    expect(getChatMessage('discord', 'channel-1', 'old')).toBeNull();
    expect(getChatMessage('discord', 'channel-1', 'new')).not.toBeNull();
  });

  it('lists messages in a chat ordered by sent_at descending', () => {
    putChatMessage({ ...sample, message_id: 'a', sent_at: '2026-04-27T12:00:00.000Z' });
    putChatMessage({ ...sample, message_id: 'b', sent_at: '2026-04-27T12:05:00.000Z' });
    putChatMessage({ ...sample, message_id: 'c', sent_at: '2026-04-27T11:55:00.000Z' });
    const list = listChatMessages('discord', 'channel-1', { limit: 10 });
    expect(list.map((m) => m.message_id)).toEqual(['b', 'a', 'c']);
  });
});
