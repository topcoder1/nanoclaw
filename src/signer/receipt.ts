import type Database from 'better-sqlite3';
import path from 'node:path';
import { getCeremony } from './ceremony-repo.js';
import { renderReceipt } from './card-renderer.js';

export interface PostReceiptInput {
  db: Database.Database;
  ceremonyId: string;
  outcome: 'signed' | 'failed';
  chatId: string;
  sendText: (chatId: string, text: string, opts?: unknown) => Promise<void>;
  sendDocument: (
    chatId: string,
    filePath: string,
    opts?: unknown,
  ) => Promise<void>;
  sendPhoto?: (
    chatId: string,
    filePath: string,
    opts?: unknown,
  ) => Promise<void>;
}

export async function postReceipt(input: PostReceiptInput): Promise<void> {
  const ceremony = getCeremony(input.db, input.ceremonyId);
  if (!ceremony) throw new Error(`ceremony not found: ${input.ceremonyId}`);

  if (input.outcome === 'signed' && !ceremony.signedPdfPath) {
    throw new Error('cannot post signed receipt without signed_pdf_path');
  }

  const card = renderReceipt({ ceremony, outcome: input.outcome });
  const textOpts =
    card.buttons.length > 0
      ? {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: card.buttons },
        }
      : { parse_mode: 'Markdown' };

  await input.sendText(input.chatId, card.text, textOpts);

  if (input.outcome === 'signed' && ceremony.signedPdfPath) {
    await input.sendDocument(input.chatId, ceremony.signedPdfPath, {});
  } else if (
    input.outcome === 'failed' &&
    ceremony.failureScreenshotPath &&
    input.sendPhoto
  ) {
    await input.sendPhoto(input.chatId, ceremony.failureScreenshotPath, {});
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'doc'
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function archivePathFor(
  groupRoot: string,
  ceremonyId: string,
  docTitle: string | null,
  date: Date = new Date(),
): string {
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const slug = slugify(docTitle ?? 'doc');
  return path.join(
    groupRoot,
    'signed-docs',
    yyyy,
    mm,
    `${ceremonyId}__${slug}.pdf`,
  );
}

export function failureScreenshotPathFor(
  groupRoot: string,
  ceremonyId: string,
  date: Date = new Date(),
): string {
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  return path.join(
    groupRoot,
    'signed-docs',
    yyyy,
    mm,
    `${ceremonyId}__failure.png`,
  );
}
