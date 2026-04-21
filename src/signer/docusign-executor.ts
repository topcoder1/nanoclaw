import type { Page, BrowserContext } from 'playwright-core';
import type {
  SignExecutor,
  SignExecutorInput,
  SignExecutorResult,
} from './executor-registry.js';
import type { FieldTag } from './types.js';
import { matchProfileFieldByLabel } from './profile.js';
import { logger } from '../logger.js';

const ACCESS_CODE_URL_PATTERNS = [/accessCode/i, /authenticate/i, /idcheck/i];
const EXPIRED_URL_PATTERNS = [/expired/i, /\/error/i];

function abortRace<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function formatDate(fmt: string): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return fmt.replace('MM', mm).replace('DD', dd).replace('YYYY', yyyy);
}

async function detectErrorState(page: Page): Promise<string | null> {
  const url = page.url();
  if (ACCESS_CODE_URL_PATTERNS.some((re) => re.test(url)))
    return 'auth_challenge';
  if (EXPIRED_URL_PATTERNS.some((re) => re.test(url)))
    return 'invite_expired_or_used';

  // DOM-based error detection (works for fixture pages served over http)
  const accessCode = await page.$('[data-qa="access-code"]');
  if (accessCode) return 'auth_challenge';
  const expiredBanner = await page.$('[data-qa="error-expired"]');
  if (expiredBanner) return 'invite_expired_or_used';

  return null;
}

async function clickContinueIfPresent(page: Page): Promise<void> {
  const agree = await page.$('[data-qa="agree-esign"]');
  if (agree) {
    await agree.check().catch(() => undefined);
  }
  const continueBtn = await page.$('[data-qa="continue-button"]');
  if (continueBtn) {
    await continueBtn.click().catch(() => undefined);
  }
}

interface TagInfo {
  type: FieldTag;
  label: string;
  inputSelector: string;
}

async function listTags(page: Page): Promise<TagInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await page.$$eval('.tag', (els: any[]) =>
    els.map((el: any) => {
      const input = el.querySelector('.tag-input');
      return {
        type: (el.getAttribute('data-tag-type') as string) || '',
        label: (el.getAttribute('data-tag-label') as string) || '',
        qa: (input?.getAttribute('data-qa') as string) || '',
      };
    }),
  );
  return raw
    .filter((t): t is { type: FieldTag; label: string; qa: string } =>
      ['signature', 'initial', 'date_signed', 'text', 'check'].includes(t.type),
    )
    .map((t) => ({
      type: t.type,
      label: t.label,
      inputSelector: `[data-qa="${t.qa}"]`,
    }));
}

async function resolveTagValue(
  tag: TagInfo,
  input: SignExecutorInput,
): Promise<string | null> {
  const { profile } = input;
  switch (tag.type) {
    case 'signature':
      return profile.fullName;
    case 'initial':
      return profile.initials;
    case 'date_signed':
      return formatDate(profile.defaultDateFormat);
    case 'text': {
      const match = matchProfileFieldByLabel(profile, tag.label);
      if (match) return match.value;
      // Ask user
      const supplied = await input.onFieldInputNeeded({
        ceremonyId: input.ceremony.id,
        fieldLabel: tag.label,
        fieldType: 'text',
      });
      return supplied;
    }
    case 'check':
      // Leave unchecked by default; if required, ask user
      return null;
  }
}

async function fillTag(page: Page, tag: TagInfo, value: string): Promise<void> {
  await page.fill(tag.inputSelector, value, { timeout: 15_000 });
}

export const docusignExecutor: SignExecutor = {
  vendor: 'docusign',
  urlHostWhitelist: [/(^|\.)docusign\.net$/i, /(^|\.)docusign\.com$/i],

  async extractDocText(page: Page): Promise<string> {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = await frame.evaluate(
          () => (globalThis as any).document?.body?.textContent || '',
        );
        if (text && text.length > 50) return text;
      } catch {
        // frame may be cross-origin
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (
      (await page.evaluate(
        () => (globalThis as any).document?.body?.textContent || '',
      )) || ''
    );
  },

  async sign(input: SignExecutorInput): Promise<SignExecutorResult> {
    const { ceremony, context, signal } = input;
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    try {
      const gotoP = page.goto(ceremony.signUrl, { waitUntil: 'domcontentloaded' });
      gotoP.catch(() => undefined); // suppress unhandled rejection if abortRace wins
      await abortRace(gotoP, signal);
      const err = await detectErrorState(page);
      if (err) throw new Error(err);

      await clickContinueIfPresent(page);
      if (signal.aborted) throw new Error('aborted');

      const tags = await listTags(page);
      if (tags.length === 0) throw new Error('not_signer');

      for (const tag of tags) {
        if (signal.aborted) throw new Error('aborted');
        const value = await resolveTagValue(tag, input);
        if (value === null || value === '') {
          if (tag.type === 'check') continue;
          throw new Error('field_input_timeout');
        }
        await fillTag(page, tag, value);
      }

      if (signal.aborted) throw new Error('aborted');
      const finish = await page.$('[data-qa="finish-button"]');
      if (!finish) throw new Error('layout_changed');
      await abortRace(
        Promise.all([
          page.waitForURL(/completion/i, { timeout: 15_000 }),
          finish.click(),
        ]),
        signal,
      );

      // Confirmation page reached
      const completionHeader = await page.$('[data-qa="signing-complete"]');
      if (!completionHeader) throw new Error('layout_changed');

      return {
        signedPdfPath: page.url(),
        completionScreenshotPath: null,
      };
    } catch (err) {
      await page.close().catch(() => undefined);
      logger.warn(
        { err, ceremonyId: ceremony.id, component: 'signer/docusign-executor' },
        'DocuSign executor threw',
      );
      throw err;
    }
  },

  async downloadSignedPdf(page: Page, destPath: string): Promise<void> {
    // Prefer HTTP fetch fallback — <a download> doesn't reliably fire Playwright's download event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const href = await page.$eval(
      '[data-qa="download-button"]',
      (el: any) => el.href as string,
    );
    const url = new URL(href, page.url()).toString();
    const resp = await page.request.get(url);
    if (!resp.ok()) throw new Error(`download_failed:${resp.status()}`);
    const body = await resp.body();
    await (await import('node:fs/promises')).writeFile(destPath, body);
  },
};
