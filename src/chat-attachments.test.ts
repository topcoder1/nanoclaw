import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  storeAttachment,
  attachmentRoot,
  describeAttachment,
  type AttachmentDescriptor,
} from './chat-attachments.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'nc-att-'));
  process.env.BRAIN_ATTACHMENT_DIR = baseDir;
  process.env.BRAIN_ATTACHMENT_MAX_BYTES = String(1024 * 1024);
});

afterEach(() => {
  delete process.env.BRAIN_ATTACHMENT_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

describe('chat-attachments', () => {
  it('writes a downloaded buffer keyed by sha256 and returns a descriptor', async () => {
    const fetcher = vi.fn().mockResolvedValue(Buffer.from('hello world'));
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'note.txt', mime: 'text/plain', size_bytes: 11 },
      fetcher,
    );
    expect(desc).not.toBeNull();
    expect(desc!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(desc!.local_path)).toBe(true);
    expect(readFileSync(desc!.local_path).toString()).toBe('hello world');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedups by sha256 — same content from different messages reuses the file', async () => {
    const fetcher = vi.fn().mockResolvedValue(Buffer.from('shared'));
    const a = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'a.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    const b = await storeAttachment(
      { platform: 'discord', chat_id: 'c2', message_id: 'm2' },
      { filename: 'b.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    expect(a!.local_path).toBe(b!.local_path);
  });

  it('returns null when size exceeds BRAIN_ATTACHMENT_MAX_BYTES', async () => {
    process.env.BRAIN_ATTACHMENT_MAX_BYTES = '5';
    const fetcher = vi.fn();
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      {
        filename: 'too-big.bin',
        mime: 'application/octet-stream',
        size_bytes: 100,
      },
      fetcher,
    );
    expect(desc).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null when fetcher throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    const desc = await storeAttachment(
      { platform: 'discord', chat_id: 'c1', message_id: 'm1' },
      { filename: 'a.txt', mime: 'text/plain', size_bytes: 6 },
      fetcher,
    );
    expect(desc).toBeNull();
  });

  it('attachmentRoot honors BRAIN_ATTACHMENT_DIR', () => {
    expect(attachmentRoot()).toBe(baseDir);
  });
});

describe('describeAttachment', () => {
  it('returns the placeholder for unknown types', async () => {
    const path = join(baseDir, 'a.zip');
    writeFileSync(path, Buffer.from('PK\x03\x04'));
    const out = await describeAttachment(
      {
        filename: 'archive.zip',
        mime: 'application/zip',
        sha256: 'x',
        local_path: path,
        size_bytes: 4,
      },
      { imageVision: false, voiceTranscribe: false },
    );
    expect(out).toBe('[Attachment: archive.zip, 4 B]');
  });

  it('returns a placeholder for images when vision is off', async () => {
    const path = join(baseDir, 'a.png');
    writeFileSync(path, Buffer.alloc(8));
    const out = await describeAttachment(
      {
        filename: 'pic.png',
        mime: 'image/png',
        sha256: 'x',
        local_path: path,
        size_bytes: 8,
      },
      { imageVision: false, voiceTranscribe: false },
    );
    expect(out).toBe('[Attachment image: pic.png]');
  });

  it('extracts text from a PDF when pdftotext is available', async () => {
    const stub = vi
      .fn()
      .mockResolvedValue('Quarterly report — Q3 revenue up 12%.');
    const out = await describeAttachment(
      {
        filename: 'q3.pdf',
        mime: 'application/pdf',
        sha256: 'x',
        local_path: '/dev/null',
        size_bytes: 100,
      },
      { imageVision: false, voiceTranscribe: false, _pdfExtractor: stub },
    );
    expect(out.startsWith('[Attachment PDF: q3.pdf]')).toBe(true);
    expect(out).toContain('Quarterly report');
  });
});
