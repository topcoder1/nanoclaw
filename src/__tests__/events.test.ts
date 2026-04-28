import { describe, it, expect } from 'vitest';
import type {
  ChatMessageEditedEvent,
  ChatMessageDeletedEvent,
  NanoClawEventMap,
} from '../events.js';

describe('chat edit/delete event types', () => {
  it('ChatMessageEditedEvent has all required fields', () => {
    const evt: ChatMessageEditedEvent = {
      type: 'chat.message.edited',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'c1',
      message_id: 'm1',
      old_text: 'before',
      new_text: 'after',
      edited_at: '2026-04-28T00:00:00.000Z',
      sender: '+15551234567',
    };
    expect(evt.type).toBe('chat.message.edited');
  });

  it('ChatMessageDeletedEvent has all required fields', () => {
    const evt: ChatMessageDeletedEvent = {
      type: 'chat.message.deleted',
      source: 'discord',
      timestamp: Date.now(),
      payload: {},
      platform: 'discord',
      chat_id: 'c1',
      message_id: 'm1',
      deleted_at: '2026-04-28T00:00:00.000Z',
    };
    expect(evt.type).toBe('chat.message.deleted');
  });

  it('event map includes both new event types', () => {
    type _checkEdited = NanoClawEventMap['chat.message.edited'];
    type _checkDeleted = NanoClawEventMap['chat.message.deleted'];
    expect(true).toBe(true);
  });
});

describe('entity merge event type', () => {
  it('EntityMergeRequestedEvent has all required fields', () => {
    const evt: import('../events.js').EntityMergeRequestedEvent = {
      type: 'entity.merge.requested',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'c1',
      requested_by_handle: 'alice',
      handle_a: 'jonathan',
      handle_b: 'j zhang',
    };
    expect(evt.type).toBe('entity.merge.requested');
  });
});

describe('entity unmerge event type', () => {
  it('EntityUnmergeRequestedEvent has all required fields', () => {
    const evt: import('../events.js').EntityUnmergeRequestedEvent = {
      type: 'entity.unmerge.requested',
      source: 'signal',
      timestamp: Date.now(),
      payload: {},
      platform: 'signal',
      chat_id: 'c1',
      requested_by_handle: 'op',
      merge_id_or_prefix: '01KQB6',
    };
    expect(evt.type).toBe('entity.unmerge.requested');
  });
});
