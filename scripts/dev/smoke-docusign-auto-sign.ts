#!/usr/bin/env tsx
/**
 * Manual smoke test for DocuSign auto-sign.
 * Usage: SMOKE_LIVE=1 tsx scripts/dev/smoke-docusign-auto-sign.ts '<docusign signing URL>'
 *
 * DO NOT run this in CI. Requires a real DocuSign test account.
 */
import { chromium } from 'playwright-core';
import { docusignExecutor } from '../../src/signer/docusign-executor.js';
import type { SignCeremony, SignerProfile } from '../../src/signer/types.js';

async function main() {
  if (process.env.SMOKE_LIVE !== '1') {
    console.error('Refusing to run without SMOKE_LIVE=1');
    process.exit(1);
  }
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: smoke-docusign-auto-sign.ts <signing URL>');
    process.exit(1);
  }

  const profile: SignerProfile = {
    fullName: process.env.SMOKE_FULL_NAME ?? 'Test Signer',
    initials: process.env.SMOKE_INITIALS ?? 'TS',
    title: process.env.SMOKE_TITLE ?? 'Tester',
    address: null,
    phone: null,
    defaultDateFormat: 'MM/DD/YYYY',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const ceremony: SignCeremony = {
      id: 'smoke',
      emailId: 'smoke',
      vendor: 'docusign',
      signUrl: url,
      docTitle: 'SMOKE',
      state: 'approved',
      summaryText: null,
      riskFlags: [],
      signedPdfPath: null,
      failureReason: null,
      failureScreenshotPath: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    };
    await docusignExecutor.sign({
      ceremony,
      profile,
      context,
      onFieldInputNeeded: async (req) => {
        console.error('Needed field:', req);
        return null;
      },
      signal: new AbortController().signal,
    });
    console.log('SMOKE PASS');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
