import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { docusignExecutor } from '../docusign-executor.js';
import { isWhitelistedUrl } from '../executor-registry.js';
import type { SignCeremony, SignerProfile } from '../types.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function makeCeremony(overrides: Partial<SignCeremony> = {}): SignCeremony {
  return {
    id: 'c1',
    emailId: 'e1',
    vendor: 'docusign',
    signUrl: 'http://localhost:0/signing.html',
    docTitle: 'Test.pdf',
    state: 'approved',
    summaryText: null,
    riskFlags: [],
    signedPdfPath: null,
    failureReason: null,
    failureScreenshotPath: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

const profile: SignerProfile = {
  fullName: 'Alice Example',
  initials: 'AE',
  title: 'CEO',
  address: '1 Market St',
  phone: '555-0100',
  defaultDateFormat: 'MM/DD/YYYY',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('docusignExecutor', () => {
  let browser: Browser;
  let server: http.Server;
  let port: number;
  let tmpDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-test-'));
    server = http.createServer((req, res) => {
      const url = req.url || '/';
      const name = url === '/' ? '/signing.html' : url;
      if (name === '/signing.html') {
        res.end(
          fs.readFileSync(path.join(FIXTURES, 'docusign-signing-page.html')),
        );
      } else if (name === '/completion.html') {
        res.end(
          fs.readFileSync(path.join(FIXTURES, 'docusign-completion-page.html')),
        );
      } else if (name === '/signed.pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.end(fs.readFileSync(path.join(FIXTURES, 'sample-signed.pdf')));
      } else if (name === '/expired.html') {
        res.end(fs.readFileSync(path.join(FIXTURES, 'docusign-expired.html')));
      } else if (name === '/access-code.html') {
        res.end(
          fs.readFileSync(path.join(FIXTURES, 'docusign-access-code.html')),
        );
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let context: BrowserContext;
  beforeEach(async () => {
    context = await browser.newContext();
  });

  it('has a whitelist matching docusign.net and docusign.com', () => {
    expect(
      isWhitelistedUrl(docusignExecutor, 'https://na3.docusign.net/x'),
    ).toBe(true);
    expect(
      isWhitelistedUrl(docusignExecutor, 'https://app.docusign.com/x'),
    ).toBe(true);
    expect(isWhitelistedUrl(docusignExecutor, 'https://evil.com/x')).toBe(
      false,
    );
  });

  it('signs a fixture page end-to-end', async () => {
    const dest = path.join(tmpDir, 'signed.pdf');
    const result = await docusignExecutor.sign({
      ceremony: makeCeremony({
        signUrl: `http://127.0.0.1:${port}/signing.html`,
      }),
      profile,
      context,
      onFieldInputNeeded: async () => null,
      signal: new AbortController().signal,
    });
    expect(result.signedPdfPath).toBeTruthy();
    // Download via separate step:
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/completion.html`);
    await docusignExecutor.downloadSignedPdf(page, dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
    await page.close();
  }, 20_000);

  it('asks for field input via callback when title keyword not in profile field', async () => {
    const onFieldInputNeeded = vi.fn().mockResolvedValue('Project Lead');
    const sparseProfile = { ...profile, title: null };
    const result = await docusignExecutor.sign({
      ceremony: makeCeremony({
        signUrl: `http://127.0.0.1:${port}/signing.html`,
      }),
      profile: sparseProfile,
      context,
      onFieldInputNeeded,
      signal: new AbortController().signal,
    });
    expect(onFieldInputNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ fieldLabel: 'Title', fieldType: 'text' }),
    );
    expect(result.signedPdfPath).toBeTruthy();
  }, 20_000);

  it('throws auth_challenge when access-code page appears', async () => {
    await expect(
      docusignExecutor.sign({
        ceremony: makeCeremony({
          signUrl: `http://127.0.0.1:${port}/access-code.html`,
        }),
        profile,
        context,
        onFieldInputNeeded: async () => null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/auth_challenge/);
  }, 15_000);

  it('throws invite_expired_or_used when expired page appears', async () => {
    await expect(
      docusignExecutor.sign({
        ceremony: makeCeremony({
          signUrl: `http://127.0.0.1:${port}/expired.html`,
        }),
        profile,
        context,
        onFieldInputNeeded: async () => null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/invite_expired_or_used/);
  }, 15_000);

  it('throws field_input_timeout when onFieldInputNeeded returns null for a needed field', async () => {
    const sparseProfile = { ...profile, title: null };
    await expect(
      docusignExecutor.sign({
        ceremony: makeCeremony({
          signUrl: `http://127.0.0.1:${port}/signing.html`,
        }),
        profile: sparseProfile,
        context,
        onFieldInputNeeded: async () => null, // refuses to provide value
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/field_input_timeout/);
  }, 15_000);

  it('throws aborted when signal is already aborted before sign() runs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      docusignExecutor.sign({
        ceremony: makeCeremony({
          signUrl: `http://127.0.0.1:${port}/signing.html`,
        }),
        profile,
        context,
        onFieldInputNeeded: async () => null,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  }, 10_000);

  it('throws field_input_timeout when onFieldInputNeeded returns empty string for a needed field', async () => {
    const sparseProfile = { ...profile, title: null };
    await expect(
      docusignExecutor.sign({
        ceremony: makeCeremony({
          signUrl: `http://127.0.0.1:${port}/signing.html`,
        }),
        profile: sparseProfile,
        context,
        onFieldInputNeeded: async () => '', // returns empty string
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/field_input_timeout/);
  }, 15_000);
});
