import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import type { Browser } from 'playwright-core';
import { registerExecutor, resolveExecutor } from './executor-registry.js';
import { docusignExecutor } from './docusign-executor.js';
import { startSummarizerWiring } from './summarizer-wiring.js';
import { startCeremonyOrchestrator } from './ceremony.js';
import type { LlmFn } from './summarizer.js';
import type { SignVendor } from './types.js';
import { logger } from '../logger.js';

export interface StartSignerInput {
  db: Database.Database;
  bus: EventBus;
  groupRoot: string;
  chatId: string;
  connectBrowser: () => Promise<Browser>;
  fetchDocText: (signUrl: string) => Promise<string>;
  llm: LlmFn;
  sendText: (chatId: string, text: string, opts?: unknown) => Promise<{ message_id: number } | void>;
  sendDocument: (chatId: string, filePath: string, opts?: unknown) => Promise<void>;
  sendPhoto: (chatId: string, filePath: string, opts?: unknown) => Promise<void>;
}

export function startSigner(deps: StartSignerInput): () => void {
  registerExecutor(docusignExecutor);
  const unsubSummarizer = startSummarizerWiring({
    db: deps.db,
    bus: deps.bus,
    fetchDocText: deps.fetchDocText,
    llm: deps.llm,
  });
  const unsubCeremony = startCeremonyOrchestrator({
    db: deps.db,
    bus: deps.bus,
    groupRoot: deps.groupRoot,
    chatId: deps.chatId,
    connectBrowser: deps.connectBrowser,
    sendText: deps.sendText,
    sendDocument: deps.sendDocument,
    sendPhoto: deps.sendPhoto,
  });
  logger.info({ component: 'signer' }, 'signer module started');
  return () => {
    unsubSummarizer();
    unsubCeremony();
  };
}

export async function fetchDocTextViaExecutor(opts: {
  browser: Browser;
  vendor: SignVendor;
  signUrl: string;
}): Promise<string> {
  const executor = resolveExecutor(opts.vendor);
  const context = await opts.browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(opts.signUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return await executor.extractDocText(page);
  } finally {
    await context.close();
  }
}
