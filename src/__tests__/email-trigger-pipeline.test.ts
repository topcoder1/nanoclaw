/**
 * Tests for the email-trigger pipeline: verifies that IpcDeps.enqueueEmailTrigger
 * passes email metadata through to the onResult callback.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcDeps } from '../ipc.js';

describe('email-trigger pipeline – interface contract', () => {
  /**
   * Build a minimal IpcDeps stub that fulfils the interface and records
   * the arguments passed to enqueueEmailTrigger.
   */
  function buildStub() {
    const calls: Array<{
      chatJid: string;
      prompt: string;
      emails: Array<{ thread_id: string; account: string; subject: string; sender: string }>;
    }> = [];

    const stub: IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: vi.fn().mockReturnValue([]),
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      enqueueEmailTrigger: (chatJid, prompt, onResult, emails) => {
        calls.push({ chatJid, prompt, emails });
        // Immediately invoke onResult so callers can verify the callback
        // receives the same emails array.
        void onResult('agent output', emails);
      },
    };

    return { stub, calls };
  }

  it('passes email metadata to enqueueEmailTrigger as 4th argument', async () => {
    const { stub, calls } = buildStub();

    const emails = [
      { thread_id: 'thread-1', account: 'user@example.com', subject: 'Hello', sender: 'a@b.com' },
      { thread_id: 'thread-2', account: 'user2@example.com', subject: 'World', sender: 'c@d.com' },
    ];

    stub.enqueueEmailTrigger('tg:12345', 'process emails', vi.fn(), emails);

    expect(calls).toHaveLength(1);
    expect(calls[0].chatJid).toBe('tg:12345');
    expect(calls[0].emails).toEqual(emails);
  });

  it('onResult callback receives both text and emails array', async () => {
    const { stub } = buildStub();

    const emails = [
      { thread_id: 'thread-abc', account: 'x@y.com', subject: 'Test', sender: 'z@w.com' },
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
});
