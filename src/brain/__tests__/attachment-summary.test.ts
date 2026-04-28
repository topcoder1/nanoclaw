import { describe, expect, it, vi } from 'vitest';
import { summarizeAttachment } from '../attachment-summary.js';

describe('attachment-summary', () => {
  it('falls back to filename tag when vision is disabled', async () => {
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'receipt.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: false },
    );
    expect(result).toBe('[image: receipt.jpg]');
  });

  it('uses the vision summary when vision is enabled and local_path exists', async () => {
    const visionMock = vi.fn(async () => 'Acme invoice for $250');
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'receipt.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[image: receipt.jpg — Acme invoice for $250]');
    expect(visionMock).toHaveBeenCalledWith('/tmp/r.jpg');
  });

  it('handles missing filename', async () => {
    const result = await summarizeAttachment(
      { kind: 'file' },
      { visionEnabled: false },
    );
    expect(result).toBe('[file]');
  });

  it('handles unknown kind gracefully', async () => {
    const result = await summarizeAttachment({}, { visionEnabled: false });
    expect(result).toBe('[attachment]');
  });

  it('falls back to filename tag when vision throws', async () => {
    const visionMock = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'r.jpg', local_path: '/tmp/r.jpg' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[image: r.jpg]');
  });

  it('skips vision when local_path is absent', async () => {
    const visionMock = vi.fn();
    const result = await summarizeAttachment(
      { kind: 'image', filename: 'r.jpg' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[image: r.jpg]');
    expect(visionMock).not.toHaveBeenCalled();
  });

  it('returns plain filename tag for non-image kinds even with vision enabled', async () => {
    const visionMock = vi.fn();
    const result = await summarizeAttachment(
      { kind: 'video', filename: 'clip.mp4', local_path: '/tmp/c.mp4' },
      { visionEnabled: true, summarizeVision: visionMock },
    );
    expect(result).toBe('[video: clip.mp4]');
    expect(visionMock).not.toHaveBeenCalled();
  });
});
