import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { chromium, type Browser } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runMigrations } from '../db.js';
import { EventBus } from '../event-bus.js';
import { upsertProfile } from '../signer/profile.js';
import { onSignInviteDetected } from '../signer/triage-hook.js';
import { startSummarizerWiring } from '../signer/summarizer-wiring.js';
import { startCeremonyOrchestrator } from '../signer/ceremony.js';
import { registerExecutor } from '../signer/executor-registry.js';
import { docusignExecutor } from '../signer/docusign-executor.js';
import { getCeremony } from '../signer/ceremony-repo.js';

const FIXTURES = path.join(import.meta.dirname, '../signer/__tests__/fixtures');

// Test executor extends docusignExecutor with localhost/127.0.0.1 in the whitelist
const testDocusignExecutor = {
  ...docusignExecutor,
  urlHostWhitelist: [
    ...docusignExecutor.urlHostWhitelist,
    /^127\.0\.0\.1$/,
    /^localhost$/,
  ],
};

describe('signer end-to-end integration', () => {
  let browser: Browser;
  let server: http.Server;
  let port: number;
  let db: Database.Database;
  let bus: EventBus;
  let tempGroup: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer((req, res) => {
      const url = req.url || '/';
      const name = url === '/' ? '/signing.html' : url;
      if (name === '/signing.html') res.end(fs.readFileSync(path.join(FIXTURES, 'docusign-signing-page.html')));
      else if (name === '/completion.html') res.end(fs.readFileSync(path.join(FIXTURES, 'docusign-completion-page.html')));
      else if (name === '/signed.pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.end(fs.readFileSync(path.join(FIXTURES, 'sample-signed.pdf')));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    bus = new EventBus();
    tempGroup = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-e2e-'));
    upsertProfile(db, {
      fullName: 'Alice Example',
      initials: 'AE',
      title: 'CEO',
      address: '1 Market St',
      phone: '555-0100',
    });
    registerExecutor(testDocusignExecutor);
  });

  it('full pipeline: invite → summary → approve → sign → receipt', async () => {
    const telegramMessages: Array<{ chatId: string; text: string }> = [];
    const telegramDocuments: Array<{ chatId: string; path: string }> = [];

    const llm = async () => ({ summary: ['Doc: NDA'], riskFlags: [] });
    const fetchDocText = async () => 'CONSULTING AGREEMENT between Acme and Alice';

    startSummarizerWiring({ db, bus, fetchDocText, llm });

    startCeremonyOrchestrator({
      db,
      bus,
      groupRoot: tempGroup,
      chatId: 'chat-1',
      connectBrowser: async () => browser,
      sendText: async (chatId, text) => {
        telegramMessages.push({ chatId, text });
        return { message_id: telegramMessages.length };
      },
      sendDocument: async (chatId, p) => {
        telegramDocuments.push({ chatId, path: p });
      },
      sendPhoto: async () => undefined,
    });

    const ceremonyId = await onSignInviteDetected({
      db,
      bus,
      emailId: 'email-xyz',
      vendor: 'docusign',
      signUrl: `http://127.0.0.1:${port}/signing.html`,
      docTitle: 'Consulting agreement',
      groupId: 'main',
      flagEnabled: true,
    });
    expect(ceremonyId).toBeTruthy();

    // Let summarizer run
    await new Promise((r) => setTimeout(r, 200));
    expect(getCeremony(db, ceremonyId!)!.state).toBe('summarized');

    // User taps ✅ (no high flags → direct approved)
    bus.emit('sign.approved', {
      type: 'sign.approved',
      source: 'callback-router',
      timestamp: Date.now(),
      payload: { ceremonyId: ceremonyId!, userId: 'u1' },
    });

    // Wait for completion
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (getCeremony(db, ceremonyId!)!.state === 'signed') break;
    }
    const final = getCeremony(db, ceremonyId!)!;
    expect(final.state).toBe('signed');
    expect(final.signedPdfPath).toBeTruthy();
    expect(fs.existsSync(final.signedPdfPath!)).toBe(true);
    expect(final.completedAt).not.toBeNull();
    expect(final.updatedAt).toBeGreaterThanOrEqual(final.completedAt!);

    // Telegram spy
    expect(telegramMessages.some((m) => /✅ Signed/.test(m.text))).toBe(true);
    expect(telegramDocuments.length).toBe(1);
    expect(telegramDocuments[0].path).toBe(final.signedPdfPath);
  }, 60_000);
});
