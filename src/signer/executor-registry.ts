import type { Page, BrowserContext } from 'playwright-core';
import type { SignVendor, SignerProfile, SignCeremony } from './types.js';
import type { SignFieldInputNeededEvent } from '../events.js';

export interface SignExecutorInput {
  ceremony: SignCeremony;
  profile: SignerProfile;
  context: BrowserContext;
  onFieldInputNeeded: (evt: SignFieldInputNeededEvent['payload']) => Promise<string | null>;
  /** Abort signal — resolved when the ceremony's 90s deadline fires. */
  signal: AbortSignal;
}

export interface SignExecutorResult {
  signedPdfPath: string;
  completionScreenshotPath: string | null;
}

export interface SignExecutor {
  vendor: SignVendor;
  /** Regexes matched against `new URL(signUrl).hostname`. */
  urlHostWhitelist: RegExp[];
  /** Fetches doc text from the signing page (used by summarizer). */
  extractDocText(page: Page): Promise<string>;
  /** Runs the full signing ceremony. Throws on non-field-input failures. */
  sign(input: SignExecutorInput): Promise<SignExecutorResult>;
  /** Downloads the final signed PDF. Called after `sign` completes successfully. */
  downloadSignedPdf(page: Page, destPath: string): Promise<void>;
}

const registry = new Map<SignVendor, SignExecutor>();

export function registerExecutor(executor: SignExecutor): void {
  registry.set(executor.vendor, executor);
}

export function resolveExecutor(vendor: SignVendor): SignExecutor {
  const e = registry.get(vendor);
  if (!e) throw new Error(`Unknown sign vendor: ${vendor}`);
  return e;
}

export function isWhitelistedUrl(exec: SignExecutor, url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return exec.urlHostWhitelist.some((re) => re.test(host));
  } catch {
    return false;
  }
}
