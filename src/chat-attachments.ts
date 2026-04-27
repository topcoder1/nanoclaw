import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExecFile = promisify(execFile);

import { logger } from './logger.js';
import type { ChatAttachment } from './events.js';

export interface AttachmentRef {
  platform: 'discord' | 'signal';
  chat_id: string;
  message_id: string;
}

export interface AttachmentDescriptor {
  filename: string;
  mime: string;
  size_bytes: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export function attachmentRoot(): string {
  return (
    process.env.BRAIN_ATTACHMENT_DIR ??
    join(homedir(), '.nanoclaw', 'chat-attachments')
  );
}

function maxBytes(): number {
  const raw = process.env.BRAIN_ATTACHMENT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Download (via fetcher) and store an attachment, deduped by sha256.
 * Returns a ChatAttachment descriptor, or null if the file is too large
 * or the fetch failed.
 */
export async function storeAttachment(
  ref: AttachmentRef,
  desc: AttachmentDescriptor,
  fetcher: () => Promise<Buffer>,
): Promise<ChatAttachment | null> {
  if (desc.size_bytes > maxBytes()) {
    logger.warn(
      {
        ...ref,
        filename: desc.filename,
        size: desc.size_bytes,
        cap: maxBytes(),
      },
      'attachment exceeds size cap — skipping download',
    );
    return null;
  }
  let buf: Buffer;
  try {
    buf = await fetcher();
  } catch (err) {
    logger.warn(
      {
        ...ref,
        filename: desc.filename,
        err: err instanceof Error ? err.message : String(err),
      },
      'attachment fetch failed',
    );
    return null;
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  const dir = join(attachmentRoot(), 'sha256', sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const local_path = join(dir, sha);
  if (!existsSync(local_path)) {
    writeFileSync(local_path, buf);
  }
  return {
    filename: desc.filename,
    mime: desc.mime,
    sha256: sha,
    local_path,
    size_bytes: buf.length,
  };
}

export interface DescribeOpts {
  imageVision: boolean;
  voiceTranscribe: boolean;
  /** Test seam — replaces the pdftotext call. */
  _pdfExtractor?: (path: string) => Promise<string>;
  /** Test seam — replaces the Haiku vision call. */
  _imageCaptioner?: (path: string) => Promise<string>;
  /** Test seam — replaces the Whisper call. */
  _audioTranscriber?: (path: string) => Promise<string>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function defaultPdfExtractor(path: string): Promise<string> {
  try {
    const { stdout } = await pExecFile('pdftotext', [
      '-layout',
      '-q',
      '-l',
      '50',
      path,
      '-',
    ]);
    return stdout.trim();
  } catch (err) {
    logger.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'pdftotext failed',
    );
    return '';
  }
}

async function defaultImageCaptioner(path: string): Promise<string> {
  // TODO(PR2+): wire to Anthropic Haiku 4.5 vision. For now placeholder-only.
  void path;
  return '';
}

async function defaultAudioTranscriber(path: string): Promise<string> {
  // TODO(PR2+): wire to Whisper if /add-voice-transcription is installed.
  void path;
  return '';
}

export async function describeAttachment(
  att: ChatAttachment,
  opts: DescribeOpts,
): Promise<string> {
  const size = fmtBytes(att.size_bytes);
  if (att.mime === 'application/pdf') {
    const extract = opts._pdfExtractor ?? defaultPdfExtractor;
    const txt = (await extract(att.local_path)).slice(0, 8000);
    return `[Attachment PDF: ${att.filename}]\n${txt}`.trim();
  }
  if (att.mime.startsWith('image/')) {
    if (!opts.imageVision) return `[Attachment image: ${att.filename}]`;
    const caption = (
      await (opts._imageCaptioner ?? defaultImageCaptioner)(att.local_path)
    ).trim();
    return caption
      ? `[Attachment image: ${att.filename} — ${caption}]`
      : `[Attachment image: ${att.filename}]`;
  }
  if (att.mime.startsWith('audio/')) {
    if (!opts.voiceTranscribe)
      return `[Attachment audio: ${att.filename}, ${size}]`;
    const tx = (
      await (opts._audioTranscriber ?? defaultAudioTranscriber)(att.local_path)
    ).trim();
    return tx
      ? `[Attachment audio: ${att.filename}]\n${tx}`
      : `[Attachment audio: ${att.filename}, ${size}]`;
  }
  return `[Attachment: ${att.filename}, ${size}]`;
}
