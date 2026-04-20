import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import { GmailChannel, GmailChannelOpts } from './gmail.js';
import { gmail_v1 } from 'googleapis';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 'test', undefined, 30000);
      expect(ch.name).toBe('gmail-test');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });
});

describe('GmailChannel.getDraftReplyContext', () => {
  function makeChannel(gmailMock: Partial<gmail_v1.Gmail>): GmailChannel {
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = gmailMock as gmail_v1.Gmail;
    return ch;
  }

  it('returns composite body + incoming headers for a live draft', async () => {
    const draftsGet = vi.fn().mockResolvedValue({
      data: {
        message: {
          threadId: 'thread-abc',
          payload: {
            mimeType: 'text/plain',
            body: {
              data: Buffer.from('Agent draft body here').toString('base64url'),
            },
            headers: [],
          },
        },
      },
    });
    const threadsGet = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: 'msg1',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'me@example.com' },
                { name: 'Subject', value: 'Ping' },
                { name: 'Date', value: 'Thu, 16 Apr 2026 18:00:00 -0700' },
              ],
            },
          },
          { id: 'msg2', labelIds: ['DRAFT'], payload: { headers: [] } },
        ],
      },
    });

    const ch = makeChannel({
      users: { drafts: { get: draftsGet }, threads: { get: threadsGet } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = await ch.getDraftReplyContext('draft-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.body).toBe('Agent draft body here');
    expect(ctx!.incoming.from).toBe('alice@example.com');
    expect(ctx!.incoming.subject).toBe('Ping');
    expect(ctx!.incoming.to).toBe('me@example.com');
    expect(draftsGet).toHaveBeenCalledWith({
      userId: 'me',
      id: 'draft-1',
      format: 'full',
    });
  });

  it('returns null when the draft is gone (404)', async () => {
    const draftsGet = vi.fn().mockRejectedValue({ code: 404 });
    const ch = makeChannel({
      users: { drafts: { get: draftsGet }, threads: { get: vi.fn() } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const ctx = await ch.getDraftReplyContext('missing');
    expect(ctx).toBeNull();
  });
});

describe('GmailChannel.sendDraft', () => {
  it('calls gmail.users.drafts.send with the draft id', async () => {
    const draftsSend = vi.fn().mockResolvedValue({
      data: { id: 'sent-msg-1', threadId: 'thread-abc' },
    });
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { drafts: { send: draftsSend } } } as any;

    await ch.sendDraft('draft-1');
    expect(draftsSend).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { id: 'draft-1' },
    });
  });

  it('propagates errors from Gmail API', async () => {
    const draftsSend = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { drafts: { send: draftsSend } } } as any;
    await expect(ch.sendDraft('draft-1')).rejects.toThrow('quota exceeded');
  });
});

describe('GmailChannel.sendEmail', () => {
  it('calls gmail.users.messages.send with base64url-encoded MIME', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent-1' } });
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { messages: { send } } } as any;

    await ch.sendEmail({
      to: 'unsub@example.com',
      subject: 'unsubscribe',
      body: '',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.userId).toBe('me');
    expect(typeof payload.requestBody.raw).toBe('string');
    const decoded = Buffer.from(
      payload.requestBody.raw as string,
      'base64url',
    ).toString('utf-8');
    expect(decoded).toMatch(/To: unsub@example.com/);
    expect(decoded).toMatch(/Subject: unsubscribe/);
  });

  it('includes In-Reply-To and References when provided', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent-2' } });
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { messages: { send } } } as any;

    await ch.sendEmail({
      to: 'x@y.com',
      subject: 'Re: hi',
      body: 'ok',
      inReplyTo: '<orig@mail>',
      references: '<orig@mail>',
    });

    const decoded = Buffer.from(
      send.mock.calls[0][0].requestBody.raw as string,
      'base64url',
    ).toString('utf-8');
    expect(decoded).toMatch(/In-Reply-To: <orig@mail>/);
    expect(decoded).toMatch(/References: <orig@mail>/);
    expect(decoded.endsWith('ok')).toBe(true);
  });
});
