import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../callback-router.js';
import type { CallbackRouterDeps } from '../callback-router.js';
import { EventBus } from '../event-bus.js';

vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>();
  return { ...original, MINI_APP_URL: 'https://app.example.com' };
});

vi.mock('../triage/queue-actions.js', () => ({
  handleArchive: vi.fn(),
  handleDismiss: vi.fn(),
  handleSnooze: vi.fn(),
  handleOverride: vi.fn(),
}));

function makeDeps(bus: EventBus): CallbackRouterDeps {
  return {
    archiveTracker: {
      markArchived: vi.fn(),
      getUnarchived: vi.fn().mockReturnValue([]),
      recordAction: vi.fn(),
      getByEmailId: vi.fn().mockReturnValue(null),
    } as any,
    autoApproval: { cancel: vi.fn() } as any,
    statusBar: { removePendingItem: vi.fn() } as any,
    findChannel: vi.fn().mockReturnValue({
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
    }),
    bus,
  };
}

function makeQuery(data: string, senderName = 'alice') {
  return {
    id: 'q1',
    chatJid: 'telegram:123',
    messageId: 100,
    data,
    senderName,
  };
}

describe('callback-router sign callbacks', () => {
  it('sign:approve emits sign.approved with ceremonyId and userId from senderName', async () => {
    const bus = new EventBus();
    const emitSpy = vi.spyOn(bus, 'emit');
    const deps = makeDeps(bus);

    await handleCallback(makeQuery('sign:approve:ceremony-abc', 'alice'), deps);

    expect(emitSpy).toHaveBeenCalledWith(
      'sign.approved',
      expect.objectContaining({
        type: 'sign.approved',
        source: 'callback-router',
        payload: {
          ceremonyId: 'ceremony-abc',
          userId: 'alice',
        },
      }),
    );
  });

  it('sign:cancel emits sign.cancelled with ceremonyId and reason', async () => {
    const bus = new EventBus();
    const emitSpy = vi.spyOn(bus, 'emit');
    const deps = makeDeps(bus);

    await handleCallback(
      makeQuery('sign:cancel:ceremony-xyz:user_dismissed'),
      deps,
    );

    expect(emitSpy).toHaveBeenCalledWith(
      'sign.cancelled',
      expect.objectContaining({
        type: 'sign.cancelled',
        source: 'callback-router',
        payload: {
          ceremonyId: 'ceremony-xyz',
          reason: 'user_dismissed',
        },
      }),
    );
  });
});
