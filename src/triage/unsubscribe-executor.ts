import type { GmailOps } from '../gmail-ops.js';

export type UnsubscribeMethod =
  | { kind: 'one-click'; url: string }
  | { kind: 'mailto'; to: string }
  | { kind: 'legacy-get'; url: string }
  | { kind: 'none' };

export interface UnsubscribeResult {
  method: UnsubscribeMethod['kind'];
  status: number; // 0 on network error
  url?: string;
  error?: string;
}

const URI_PATTERN = /<([^>]+)>/g;

export function pickUnsubscribeMethod(
  headers: Record<string, string>,
): UnsubscribeMethod {
  const norm: Record<string, string> = {};
  for (const k of Object.keys(headers)) norm[k.toLowerCase()] = headers[k];
  const list = norm['list-unsubscribe'];
  if (!list) return { kind: 'none' };

  const oneClick = (norm['list-unsubscribe-post'] || '')
    .toLowerCase()
    .includes('one-click');

  const uris: string[] = [];
  let m: RegExpExecArray | null;
  URI_PATTERN.lastIndex = 0;
  while ((m = URI_PATTERN.exec(list)) !== null) uris.push(m[1].trim());

  const https = uris.find((u) => u.startsWith('https://'));
  const mailto = uris.find((u) => u.startsWith('mailto:'));

  if (https && oneClick) return { kind: 'one-click', url: https };
  if (mailto) return { kind: 'mailto', to: mailto.slice('mailto:'.length) };
  if (https) return { kind: 'legacy-get', url: https };
  return { kind: 'none' };
}

export interface ExecuteDeps {
  method: UnsubscribeMethod;
  account: string;
  fetch: typeof globalThis.fetch;
  gmailOps: Pick<GmailOps, 'sendEmail'>;
  timeoutMs?: number;
}

export async function executeUnsubscribe(
  deps: ExecuteDeps,
): Promise<UnsubscribeResult> {
  const { method, account, fetch, gmailOps, timeoutMs = 5000 } = deps;

  switch (method.kind) {
    case 'one-click':
    case 'legacy-get': {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(method.url, {
          method: method.kind === 'one-click' ? 'POST' : 'GET',
          body: method.kind === 'one-click' ? '' : undefined,
          redirect: 'follow',
          signal: ctrl.signal,
        });
        return {
          method: method.kind,
          status: resp.status,
          url: method.url,
        };
      } catch (err) {
        return {
          method: method.kind,
          status: 0,
          url: method.url,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(t);
      }
    }
    case 'mailto':
      try {
        await gmailOps.sendEmail(account, {
          to: method.to,
          subject: 'unsubscribe',
          body: '',
        });
        return { method: 'mailto', status: 200 };
      } catch (err) {
        return {
          method: 'mailto',
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    case 'none':
      return { method: 'none', status: 0, error: 'no method' };
  }
}
