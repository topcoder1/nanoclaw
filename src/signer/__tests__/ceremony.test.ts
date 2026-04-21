import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db.js';
import { EventBus } from '../../event-bus.js';
import { upsertProfile } from '../profile.js';
import { createCeremony, getCeremony } from '../ceremony-repo.js';
import { registerExecutor, resolveExecutor } from '../executor-registry.js';
import { startCeremonyOrchestrator } from '../ceremony.js';
import type { SignExecutor } from '../executor-registry.js';

function makeFakeExecutor(overrides: Partial<SignExecutor> = {}): SignExecutor {
  return {
    vendor: 'docusign',
    urlHostWhitelist: [/(^|\.)docusign\.net$/i],
    extractDocText: vi.fn(async () => 'doc text'),
    sign: vi.fn(async () => ({
      signedPdfPath: '',
      completionScreenshotPath: null,
    })),
    downloadSignedPdf: vi.fn(async (_p, dest) => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(dest, 'PDF');
    }),
    ...overrides,
  };
}

describe('ceremony orchestrator', () => {
  let db: Database.Database;
  let bus: EventBus;
  let tempGroup: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    bus = new EventBus();
    upsertProfile(db, { fullName: 'Alice', initials: 'A' });
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    tempGroup = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-ceremony-'));
  });

  it('on sign.approved for unflagged ceremony: transitions signing→signed', async () => {
    const exec = makeFakeExecutor();
    registerExecutor(exec);
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });
    const { transitionState, updateSummary } =
      await import('../ceremony-repo.js');
    updateSummary(db, 'c1', ['ok'], []);
    transitionState(db, 'c1', 'detected', 'summarized');
    transitionState(db, 'c1', 'summarized', 'approved');

    const completed = new Promise<void>((resolve) =>
      bus.on('sign.completed', () => resolve()),
    );

    const browserConnect = vi.fn(async () => ({
      newContext: async () =>
        ({
          newPage: async () => ({}) as any,
          pages: () => [] as any[],
          close: async () => undefined,
        }) as any,
    }));

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: browserConnect,
      sendText: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
    });

    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c1', userId: 'u1' },
    });

    await completed;

    const row = getCeremony(db, 'c1')!;
    expect(row.state).toBe('signed');
    expect(row.signedPdfPath).toBeTruthy();
  });

  it('on sign.approved for flagged ceremony (high severity): transitions to approval_requested first', async () => {
    // Pre-approval: summarizer produced high flags.
    const exec = makeFakeExecutor();
    registerExecutor(exec);
    createCeremony(db, {
      id: 'c2',
      emailId: 'e2',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });
    const { transitionState, updateSummary } =
      await import('../ceremony-repo.js');
    updateSummary(
      db,
      'c2',
      ['risky'],
      [{ category: 'non_compete', severity: 'high', evidence: 'xx' }],
    );
    transitionState(db, 'c2', 'detected', 'summarized');

    const approvalRequested = new Promise<void>((resolve) =>
      bus.on('sign.approval_requested', () => resolve()),
    );

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: vi.fn(),
      sendText: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
    });

    // First tap: should request confirmation, NOT transition to signing.
    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c2', userId: 'u1' },
    });

    await approvalRequested;
    expect(getCeremony(db, 'c2')!.state).toBe('approval_requested');
  });

  it('on executor throw: writes failure + emits sign.failed', async () => {
    const exec = makeFakeExecutor({
      sign: vi.fn(async () => {
        throw new Error('layout_changed');
      }),
    });
    registerExecutor(exec);
    createCeremony(db, {
      id: 'c3',
      emailId: 'e3',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });
    const { transitionState, updateSummary } =
      await import('../ceremony-repo.js');
    updateSummary(db, 'c3', ['ok'], []);
    transitionState(db, 'c3', 'detected', 'summarized');
    transitionState(db, 'c3', 'summarized', 'approved');

    const failed = new Promise<string>((resolve) =>
      bus.on('sign.failed', (e) => resolve(e.payload.reason)),
    );

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: async () =>
        ({
          newContext: async () =>
            ({
              newPage: async () =>
                ({ screenshot: async () => Buffer.from('PNG') }) as any,
              pages: () => [],
              close: async () => undefined,
            }) as any,
        }) as any,
      sendText: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
    });

    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c3', userId: 'u1' },
    });

    const reason = await failed;
    expect(reason).toBe('layout_changed');
    expect(getCeremony(db, 'c3')!.state).toBe('failed');
  });

  it('postReceipt failure after signed does not mark ceremony as failed', async () => {
    const exec = makeFakeExecutor();
    registerExecutor(exec);
    createCeremony(db, {
      id: 'c5',
      emailId: 'e5',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });
    const { transitionState, updateSummary } =
      await import('../ceremony-repo.js');
    updateSummary(db, 'c5', ['ok'], []);
    transitionState(db, 'c5', 'detected', 'summarized');
    transitionState(db, 'c5', 'summarized', 'approved');

    const completed = new Promise<void>((resolve) =>
      bus.on('sign.completed', () => resolve()),
    );

    // sendDocument throws to simulate postReceipt failure on the success path
    const sendDocument = vi.fn(async () => {
      throw new Error('telegram_send_failed');
    });

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: async () =>
        ({
          newContext: async () =>
            ({
              newPage: async () => ({}) as any,
              pages: () => [] as any[],
              close: async () => undefined,
            }) as any,
        }) as any,
      sendText: vi.fn(),
      sendDocument,
      sendPhoto: vi.fn(),
    });

    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c5', userId: 'u1' },
    });

    await completed;

    // Give the caught postReceipt error time to settle
    await new Promise((r) => setTimeout(r, 20));

    const row = getCeremony(db, 'c5')!;
    expect(row.state).toBe('signed');
    expect(row.signedPdfPath).toBeTruthy();
  });

  it('duplicate sign.approved is idempotent', async () => {
    const exec = makeFakeExecutor();
    registerExecutor(exec);
    createCeremony(db, {
      id: 'c4',
      emailId: 'e4',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });
    const { transitionState, updateSummary } =
      await import('../ceremony-repo.js');
    updateSummary(db, 'c4', ['ok'], []);
    transitionState(db, 'c4', 'detected', 'summarized');
    transitionState(db, 'c4', 'summarized', 'approved');

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: async () =>
        ({
          newContext: async () =>
            ({
              newPage: async () => ({}) as any,
              pages: () => [],
              close: async () => undefined,
            }) as any,
        }) as any,
      sendText: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
    });

    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c4', userId: 'u1' },
    });
    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: 'c4', userId: 'u1' },
    });

    // Wait for state to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(exec.sign).toHaveBeenCalledTimes(1);
  });
});
