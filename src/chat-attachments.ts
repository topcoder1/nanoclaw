import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  return process.env.BRAIN_ATTACHMENT_DIR ?? join(homedir(), '.nanoclaw', 'chat-attachments');
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
      { ...ref, filename: desc.filename, size: desc.size_bytes, cap: maxBytes() },
      'attachment exceeds size cap — skipping download',
    );
    return null;
  }
  let buf: Buffer;
  try {
    buf = await fetcher();
  } catch (err) {
    logger.warn(
      { ...ref, filename: desc.filename, err: err instanceof Error ? err.message : String(err) },
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
