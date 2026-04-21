import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db.js';
import { createCeremony, transitionState, updateSignedPdf, updateFailure } from '../ceremony-repo.js';
import { postReceipt, archivePathFor } from '../receipt.js';

describe('receipt', () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-receipt-'));
  });

  it('posts a signed receipt with PDF attachment', async () => {
    const pdfPath = path.join(tmp, 'signed.pdf');
    fs.writeFileSync(pdfPath, 'PDF-CONTENT');
    createCeremony(db, { id: 'c1', emailId: 'e1', vendor: 'docusign', signUrl: 'https://docusign.net/x', docTitle: 'NDA' });
    transitionState(db, 'c1', 'detected', 'summarized');
    transitionState(db, 'c1', 'summarized', 'approved');
    transitionState(db, 'c1', 'approved', 'signing');
    updateSignedPdf(db, 'c1', pdfPath);
    transitionState(db, 'c1', 'signing', 'signed');

    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockResolvedValue(undefined);

    await postReceipt({
      db,
      ceremonyId: 'c1',
      outcome: 'signed',
      chatId: 'chat-1',
      sendText,
      sendDocument,
    });

    expect(sendText).toHaveBeenCalledWith('chat-1', expect.stringMatching(/✅ Signed/), expect.any(Object));
    expect(sendDocument).toHaveBeenCalledWith('chat-1', pdfPath, expect.any(Object));
  });

  it('posts a failed receipt with screenshot attachment + manual-open button', async () => {
    const shot = path.join(tmp, 'fail.png');
    fs.writeFileSync(shot, 'PNG-CONTENT');
    createCeremony(db, { id: 'c2', emailId: 'e2', vendor: 'docusign', signUrl: 'https://docusign.net/y', docTitle: 'MSA' });
    transitionState(db, 'c2', 'detected', 'summarized');
    transitionState(db, 'c2', 'summarized', 'approved');
    transitionState(db, 'c2', 'approved', 'signing');
    updateFailure(db, 'c2', 'layout_changed', shot);

    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const sendPhoto = vi.fn().mockResolvedValue(undefined);

    await postReceipt({
      db,
      ceremonyId: 'c2',
      outcome: 'failed',
      chatId: 'chat-1',
      sendText,
      sendDocument,
      sendPhoto,
    });

    expect(sendText).toHaveBeenCalledWith(
      'chat-1',
      expect.stringMatching(/❌ Sign failed: layout_changed/),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [{ text: '🖥 Open in browser', url: 'https://docusign.net/y' }],
          ],
        }),
      }),
    );
    expect(sendPhoto).toHaveBeenCalledWith('chat-1', shot, expect.any(Object));
  });

  it('throws when signed outcome but ceremony has no signed_pdf_path', async () => {
    createCeremony(db, { id: 'c3', emailId: 'e3', vendor: 'docusign', signUrl: 'x' });
    transitionState(db, 'c3', 'detected', 'cancelled');
    await expect(
      postReceipt({
        db,
        ceremonyId: 'c3',
        outcome: 'signed',
        chatId: 'chat-1',
        sendText: vi.fn(),
        sendDocument: vi.fn(),
      }),
    ).rejects.toThrow();
  });

  it('archivePathFor builds YYYY/MM/id__slug path', () => {
    const p = archivePathFor('/base/groups/main', 'abc-123', 'NDA — Acme & Alice.pdf', new Date('2026-04-20'));
    expect(p.endsWith('/groups/main/signed-docs/2026/04/abc-123__nda-acme-alice-pdf.pdf')).toBe(true);
  });
});
