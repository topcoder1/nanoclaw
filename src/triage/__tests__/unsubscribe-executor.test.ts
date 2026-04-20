import { describe, it, expect, vi } from 'vitest';
import {
  pickUnsubscribeMethod,
  executeUnsubscribe,
} from '../unsubscribe-executor.js';

describe('pickUnsubscribeMethod', () => {
  it('picks one-click when List-Unsubscribe-Post present', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<https://news.example.com/unsub/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(m).toEqual({
      kind: 'one-click',
      url: 'https://news.example.com/unsub/abc',
    });
  });

  it('picks mailto when only mailto: URI present', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<mailto:unsub@example.com>',
    });
    expect(m).toEqual({ kind: 'mailto', to: 'unsub@example.com' });
  });

  it('picks legacy-get for plain HTTPS URL', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe': '<https://x.com/unsub>',
    });
    expect(m).toEqual({ kind: 'legacy-get', url: 'https://x.com/unsub' });
  });

  it('handles comma-separated list: prefers HTTPS one-click', () => {
    const m = pickUnsubscribeMethod({
      'List-Unsubscribe':
        '<mailto:u@x.com>, <https://news.example.com/unsub/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(m).toEqual({
      kind: 'one-click',
      url: 'https://news.example.com/unsub/abc',
    });
  });

  it('rejects javascript: and data: schemes', () => {
    expect(
      pickUnsubscribeMethod({ 'List-Unsubscribe': '<javascript:alert(1)>' }),
    ).toEqual({ kind: 'none' });
    expect(
      pickUnsubscribeMethod({ 'List-Unsubscribe': '<data:text/html,foo>' }),
    ).toEqual({ kind: 'none' });
  });

  it('returns none when no header', () => {
    expect(pickUnsubscribeMethod({})).toEqual({ kind: 'none' });
  });
});

describe('executeUnsubscribe', () => {
  it('one-click path POSTs empty body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as any);
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'one-click', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.com/unsub',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(res.status).toBe(200);
  });

  it('mailto path calls gmailOps.sendEmail', async () => {
    const gmailOps = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    const res = await executeUnsubscribe({
      method: { kind: 'mailto', to: 'unsub@x.com' },
      account: 'a@x.com',
      fetch: vi.fn(),
      gmailOps: gmailOps as any,
    });
    expect(gmailOps.sendEmail).toHaveBeenCalledWith('a@x.com', {
      to: 'unsub@x.com',
      subject: 'unsubscribe',
      body: '',
    });
    expect(res.status).toBe(200);
  });

  it('legacy-get path GETs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as any);
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'legacy-get', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.com/unsub',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(res.status).toBe(200);
  });

  it('timeout → status 0, error set', async () => {
    const fetchMock = vi.fn(
      (_u: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(new Error('AbortError')),
          );
        }),
    );
    const gmailOps = { sendEmail: vi.fn() };
    const res = await executeUnsubscribe({
      method: { kind: 'one-click', url: 'https://x.com/unsub' },
      account: 'a@x.com',
      fetch: fetchMock as any,
      gmailOps: gmailOps as any,
      timeoutMs: 10,
    });
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/abort|timeout/i);
  });
});
