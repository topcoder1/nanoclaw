import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processTaskIpc, IpcDeps } from '../ipc.js';

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAgentMessage: vi.fn().mockResolvedValue(undefined),
    sendNotificationWithActions: vi.fn().mockResolvedValue(123),
    registeredGroups: () => ({
      'tg:-1001111111111': {
        name: 'Main',
        folder: 'telegram_main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    enqueueEmailTrigger: vi.fn(),
    ...overrides,
  };
}

describe('send_fyi_card IPC', () => {
  let deps: IpcDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('sends FYI card with triage:archive and triage:dismiss buttons', async () => {
    await processTaskIpc(
      {
        type: 'send_fyi_card',
        jid: 'tg:-1001111111111',
        text: 'Thumbtack — 3rd handyman quote',
        trackedItemId: 'item_abc123',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendNotificationWithActions).toHaveBeenCalledTimes(1);
    const call = (deps.sendNotificationWithActions as any).mock.calls[0];
    expect(call[0]).toBe('tg:-1001111111111');
    expect(call[1]).toBe('Thumbtack — 3rd handyman quote');
    const actions = call[2];
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      label: '🗄 Archive',
      callbackData: 'triage:archive:item_abc123',
    });
    expect(actions[1]).toMatchObject({
      label: '✕ Dismiss',
      callbackData: 'triage:dismiss:item_abc123',
    });
  });

  it('falls back to plain sendMessage when trackedItemId is missing', async () => {
    await processTaskIpc(
      {
        type: 'send_fyi_card',
        jid: 'tg:-1001111111111',
        text: 'Gmail sync paused',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:-1001111111111',
      'Gmail sync paused',
    );
    expect(deps.sendNotificationWithActions).not.toHaveBeenCalled();
  });

  it('falls back to plain sendMessage when channel lacks button support', async () => {
    const depsNoButtons = makeDeps({ sendNotificationWithActions: undefined });
    await processTaskIpc(
      {
        type: 'send_fyi_card',
        jid: 'tg:-1001111111111',
        text: 'hi',
        trackedItemId: 'item_xyz',
      },
      'telegram_main',
      true,
      depsNoButtons,
    );
    expect(depsNoButtons.sendMessage).toHaveBeenCalledWith(
      'tg:-1001111111111',
      'hi',
    );
  });

  it('skips when jid is missing', async () => {
    await processTaskIpc(
      {
        type: 'send_fyi_card',
        text: 'orphan',
        trackedItemId: 'item_xyz',
      },
      'telegram_main',
      true,
      deps,
    );
    expect(deps.sendNotificationWithActions).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
