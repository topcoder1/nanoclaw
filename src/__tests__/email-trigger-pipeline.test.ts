/**
 * Tests for the email-trigger pipeline: verifies that IpcDeps.enqueueEmailTrigger
 * passes email metadata through to the onResult callback.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { IpcDeps } from '../ipc.js';
import type { Channel, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

describe('email-trigger pipeline – interface contract', () => {
  /**
   * Build a minimal IpcDeps stub that fulfils the interface and records
   * the arguments passed to enqueueEmailTrigger.
   */
  function buildStub(channels: Channel[] = []) {
    const calls: Array<{
      chatJid: string;
      prompt: string;
      emails: Array<{
        thread_id: string;
        account: string;
        subject: string;
        sender: string;
      }>;
    }> = [];

    const stub: IpcDeps = {
      sendMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: vi.fn().mockReturnValue([]),
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      channels: () => channels,
      enqueueEmailTrigger: (chatJid, prompt, onResult, emails) => {
        calls.push({ chatJid, prompt, emails });
        // Immediately invoke onResult so callers can verify the callback
        // receives the same emails array.
        void onResult('agent output', emails);
      },
    };

    return { stub, calls };
  }

  /** A connected channel `name` that owns every JID starting with `prefix`. */
  const channelOwning = (name: string, prefix: string): Channel => ({
    name,
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: (jid) => jid.startsWith(prefix),
    disconnect: async () => {},
  });
  // Real channel names and JID prefixes (src/channels/*.ts): the handler
  // finds Telegram by `name`, as the signer and brain deliverer in index.ts
  // do.
  const telegram = channelOwning('telegram', 'tg:');
  const discord = channelOwning('discord', 'dc:');

  it('passes email metadata to enqueueEmailTrigger as 4th argument', async () => {
    const { stub, calls } = buildStub();

    const emails = [
      {
        thread_id: 'thread-1',
        account: 'user@example.com',
        subject: 'Hello',
        sender: 'a@b.com',
      },
      {
        thread_id: 'thread-2',
        account: 'user2@example.com',
        subject: 'World',
        sender: 'c@d.com',
      },
    ];

    stub.enqueueEmailTrigger('tg:12345', 'process emails', vi.fn(), emails);

    expect(calls).toHaveLength(1);
    expect(calls[0].chatJid).toBe('tg:12345');
    expect(calls[0].emails).toEqual(emails);
  });

  it('onResult callback receives both text and emails array', async () => {
    const { stub } = buildStub();

    const emails = [
      {
        thread_id: 'thread-abc',
        account: 'x@y.com',
        subject: 'Test',
        sender: 'z@w.com',
      },
    ];

    const receivedArgs: Array<{ text: string; emails: typeof emails }> = [];

    stub.enqueueEmailTrigger(
      'tg:99',
      'prompt',
      async (text, receivedEmails) => {
        receivedArgs.push({ text, emails: receivedEmails as typeof emails });
      },
      emails,
    );

    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0].text).toBe('agent output');
    expect(receivedArgs[0].emails).toEqual(emails);
  });

  it('handles empty email array without errors', () => {
    const { stub, calls } = buildStub();

    stub.enqueueEmailTrigger('tg:0', 'prompt', vi.fn(), []);

    expect(calls[0].emails).toEqual([]);
  });

  it('email metadata fields match the declared shape', () => {
    const { stub, calls } = buildStub();

    const email = {
      thread_id: 'tid-123',
      account: 'acct@test.com',
      subject: 'Subject line',
      sender: 'sender@test.com',
    };

    stub.enqueueEmailTrigger('tg:1', 'prompt', vi.fn(), [email]);

    const passed = calls[0].emails[0];
    expect(passed).toHaveProperty('thread_id', email.thread_id);
    expect(passed).toHaveProperty('account', email.account);
    expect(passed).toHaveProperty('subject', email.subject);
    expect(passed).toHaveProperty('sender', email.sender);
  });

  it('email-trigger prompt instructs agent to pass email_id + email_account', async () => {
    const { processTaskIpc } = await import('../ipc.js');
    // Register a main Telegram group, owned by a connected Telegram channel,
    // so the handler routes to it (it drops the trigger otherwise).
    const { stub, calls } = buildStub([telegram]);
    (stub.registeredGroups as any) = vi.fn().mockReturnValue({
      'tg:1': {
        name: 'main',
        folder: 'telegram_main',
        trigger: '@bot',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    });

    await processTaskIpc(
      {
        type: 'email_trigger',
        emails: [
          {
            thread_id: 't1',
            account: 'personal',
            subject: 's',
            sender: 'x@y',
          },
        ],
      },
      'telegram_main',
      true,
      stub,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toMatch(/email_id/);
    expect(calls[0].prompt).toMatch(/email_account/);
    expect(calls[0].prompt).toMatch(/Expand.*Full Email.*Archive/);
  });

  // Which chat the email-intelligence agent runs on. The main group the
  // Telegram channel owns wins so user replies land in the same container
  // session; otherwise "the main group" — one a connected channel owns.
  // Both picks are ownership-checked: several is_main rows coexist (one per
  // channel), a row can outlive its channel (credentials missing, connect()
  // threw), and an unowned JID is one that runAgent / sendMessage cannot
  // deliver to. Both are main groups, too: the container inherits the chosen
  // row's isMain, and a non-main group runs without the project/store
  // mounts the email-intelligence prompt relies on.
  describe('agent chat identity', () => {
    let processTaskIpc: typeof import('../ipc.js').processTaskIpc;
    beforeAll(async () => {
      ({ processTaskIpc } = await import('../ipc.js'));
    });

    const group = (folder: string, isMain = false): RegisteredGroup => ({
      name: folder,
      folder,
      trigger: '@bot',
      added_at: '2026-09-09T00:00:00.000Z',
      isMain,
    });

    const trigger = {
      type: 'email_trigger',
      emails: [
        { thread_id: 't1', account: 'personal', subject: 's', sender: 'x@y' },
      ],
    };

    /** Chat JIDs the trigger was enqueued on (empty when it was dropped). */
    async function chatJidsFor(
      groups: Record<string, RegisteredGroup>,
      channels: Channel[],
    ): Promise<string[]> {
      const { stub, calls } = buildStub(channels);
      stub.registeredGroups = () => groups;
      await processTaskIpc(trigger, 'main', true, stub);
      return calls.map((c) => c.chatJid);
    }

    it('runs on the main group the Telegram channel owns, ahead of every other owned main group', async () => {
      // Telegram-first is deliberate: the user replies there, and the reply
      // must reach the same container session. Discord's main row was
      // registered first; Telegram still wins.
      expect(
        await chatJidsFor(
          {
            'dc:1': group('discord_main', true),
            'tg:5': group('telegram_main', true),
          },
          [discord, telegram],
        ),
      ).toEqual(['tg:5']);
    });

    it('skips a stale tg: row no connected channel owns and falls back to an owned main group', async () => {
      // The Telegram channel never came up (credentials missing, or
      // connect() threw) but its registered_groups row outlived it. Picking
      // it burns a full agent run, then delivery throws
      // `No channel for JID: tg:...`.
      expect(
        await chatJidsFor(
          {
            'tg:5': group('telegram_main', true),
            'dc:1': group('discord_main', true),
          },
          [discord],
        ),
      ).toEqual(['dc:1']);
    });

    it('does not run on a non-main Telegram group: an owned main group outranks it', async () => {
      // Flipped on purpose from "a non-main tg group outranks an owned main
      // group" (#107 characterized that without endorsing it). The container
      // inherits the chosen row's isMain, so a Telegram side group would
      // process email without the project/store mounts.
      expect(
        await chatJidsFor(
          {
            'tg:5': group('telegram_side'),
            'dc:1': group('discord_main', true),
          },
          [discord, telegram],
        ),
      ).toEqual(['dc:1']);
    });

    it('falls back to a main group a connected channel owns, not the first is_main row', async () => {
      // Two is_main rows, one per channel. The WhatsApp row was registered
      // first, but only Discord is connected.
      expect(
        await chatJidsFor(
          {
            'wa-main@g.us': group('main', true),
            'dc:1': group('main', true),
          },
          [discord],
        ),
      ).toEqual(['dc:1']);
    });

    it('drops the trigger when no connected channel owns a main group', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        expect(
          await chatJidsFor({ 'wa-main@g.us': group('main', true) }, []),
        ).toEqual([]);
        // Dropped by this branch, not by an earlier guard (feature flag off,
        // empty email list).
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('No Telegram or main group registered'),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});

import { classifyAndFormat } from '../router.js';
import { ArchiveTracker } from '../archive-tracker.js';
import Database from 'better-sqlite3';

describe('email trigger output — classifyAndFormat integration', () => {
  it('should classify agent email output and attach actions', () => {
    const emailText = `[Email [personal] from alice@example.com]
Subject: Meeting tomorrow

Hi, let's meet tomorrow at 3pm to discuss the project.`;

    const { meta } = classifyAndFormat(emailText);
    expect(meta.category).toBe('email');
  });

  it('should pass through non-email agent output and return the text', () => {
    const normalText =
      'I checked your calendar and you have no meetings today.';
    const { text, meta } = classifyAndFormat(normalText);
    // The default category for unrecognised messages is 'email' (classifier fallback);
    // what matters here is that the text is preserved and meta.actions starts empty.
    expect(text).toContain('calendar');
    expect(meta.actions).toEqual([]);
  });
});

describe('archive buttons from trigger metadata', () => {
  it('should record emails in archiveTracker', () => {
    const db = new Database(':memory:');
    // ArchiveTracker uses the 'acted_emails' table
    db.exec(`CREATE TABLE IF NOT EXISTS acted_emails (
      email_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      account TEXT NOT NULL,
      action_taken TEXT NOT NULL DEFAULT '',
      acted_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);
    const tracker = new ArchiveTracker(db);

    const triggerEmails = [
      {
        thread_id: 'thread-123',
        account: 'personal',
        subject: 'Test',
        sender: 'bob@example.com',
      },
    ];

    for (const email of triggerEmails) {
      tracker.recordAction(
        email.thread_id,
        email.thread_id,
        email.account,
        'replied',
      );
    }

    const unarchived = tracker.getUnarchived();
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].email_id).toBe('thread-123');
    db.close();
  });

  it('should add archive button when not already present', () => {
    const actions: Array<{
      label: string;
      callbackData: string;
      style: string;
    }> = [];
    const triggerEmails = [
      {
        thread_id: 'thread-456',
        account: 'dev',
        subject: 'Deploy',
        sender: 'ci@example.com',
      },
    ];

    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary',
        });
      }
    }

    expect(actions).toHaveLength(1);
    expect(actions[0].callbackData).toBe('archive:thread-456');
  });

  it('should not duplicate archive buttons for multiple emails from same trigger', () => {
    const { meta } = classifyAndFormat('Agent processed 2 emails.');
    const triggerEmails = [
      {
        thread_id: 'thread-1',
        account: 'personal',
        subject: 'A',
        sender: 'a@x.com',
      },
      {
        thread_id: 'thread-2',
        account: 'dev',
        subject: 'B',
        sender: 'b@x.com',
      },
    ];

    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (
        !meta.actions.some((a) =>
          a.callbackData?.startsWith(`archive:${emailId}`),
        )
      ) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions).toHaveLength(2);
  });
});

describe('email trigger pipeline — end-to-end', () => {
  it('should produce formatted output with archive buttons from trigger metadata', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-e2e-1',
        account: 'personal',
        subject: 'Project update',
        sender: 'pm@example.com',
      },
      {
        thread_id: 'thread-e2e-2',
        account: 'dev',
        subject: 'CI failure',
        sender: 'ci@example.com',
      },
    ];

    // Simulate the agent response (not in [Email ...] format)
    const agentResponse =
      'I reviewed 2 new emails:\n1. Project update from pm@example.com — scheduling meeting\n2. CI failure from ci@example.com — test suite needs fix';

    // Run through the pipeline
    const { meta } = classifyAndFormat(agentResponse);

    // Force-attach archive buttons from trigger metadata
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (
        !meta.actions.some((a) =>
          a.callbackData?.startsWith(`archive:${emailId}`),
        )
      ) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have archive buttons for both emails
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions).toHaveLength(2);
    expect(archiveActions[0].callbackData).toBe('archive:thread-e2e-1');
    expect(archiveActions[1].callbackData).toBe('archive:thread-e2e-2');
  });

  it('should not duplicate archive buttons when classifier already detected email', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-dup-1',
        account: 'personal',
        subject: 'Test',
        sender: 'alice@example.com',
      },
    ];

    // Agent response in [Email ...] format that classifier WILL detect
    const emailFormatResponse = `[Email [personal] from alice@example.com]
Subject: Test

Short body here.`;

    const { meta } = classifyAndFormat(emailFormatResponse);

    // Force-attach — should check for existing archive buttons
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!meta.actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have at most one set of archive buttons (no duplicates)
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions.length).toBeGreaterThanOrEqual(1);
    // No exact duplicate callbackData
    const uniqueData = new Set(archiveActions.map((a) => a.callbackData));
    expect(uniqueData.size).toBe(archiveActions.length);
  });
});
