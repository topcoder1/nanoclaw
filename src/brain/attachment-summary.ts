/**
 * Single-line attachment summary for windowed transcripts.
 *
 * Three tiers:
 *   1. Image + vision enabled + local_path → "[image: <name> — <vision summary>]"
 *   2. Filename present                    → "[<kind>: <filename>]"
 *   3. No metadata                          → "[attachment]"
 *
 * Vision failures fall back silently to tier 2 (logged as warn).
 */

import { logger } from '../logger.js';

export interface AttachmentInput {
  kind?: string;
  filename?: string;
  local_path?: string;
}

export interface AttachmentSummaryOpts {
  /** Reads BRAIN_IMAGE_VISION at call time (caller passes the resolved bool). */
  visionEnabled?: boolean;
  /** Injectable vision summarizer for tests / future production wiring. */
  summarizeVision?: (path: string) => Promise<string>;
}

export async function summarizeAttachment(
  att: AttachmentInput,
  opts: AttachmentSummaryOpts = {},
): Promise<string> {
  const kind = att.kind ?? 'attachment';
  const filename = att.filename;
  const baseTag = filename ? `${kind}: ${filename}` : kind;

  if (
    opts.visionEnabled &&
    kind === 'image' &&
    att.local_path &&
    opts.summarizeVision
  ) {
    try {
      const summary = await opts.summarizeVision(att.local_path);
      const trimmed = summary.trim();
      if (trimmed) return `[${baseTag} — ${trimmed}]`;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), filename },
        'attachment-summary: vision failed; falling back to filename tag',
      );
    }
  }

  return `[${baseTag}]`;
}
