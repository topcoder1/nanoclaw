import { describe, it, expect, vi } from 'vitest';
import {
  resolveExecutor,
  registerExecutor,
  isWhitelistedUrl,
} from '../executor-registry.js';
import type { SignExecutor } from '../executor-registry.js';
import type { SignVendor } from '../types.js';

describe('executor-registry', () => {
  it('throws for unknown vendor', () => {
    expect(() => resolveExecutor('unknown' as SignVendor)).toThrow(
      /Unknown sign vendor/,
    );
  });

  it('registerExecutor + resolveExecutor round-trip', () => {
    const fake: SignExecutor = {
      vendor: 'docusign',
      urlHostWhitelist: [/^.*\.docusign\.net$/],
      sign: vi.fn(),
      extractDocText: vi.fn(),
      downloadSignedPdf: vi.fn(),
    };
    registerExecutor(fake);
    expect(resolveExecutor('docusign')).toBe(fake);
  });

  it('isWhitelistedUrl checks host against patterns', () => {
    const exec: SignExecutor = {
      vendor: 'docusign',
      urlHostWhitelist: [/^.*\.docusign\.net$/, /^app\.docusign\.com$/],
      sign: vi.fn(),
      extractDocText: vi.fn(),
      downloadSignedPdf: vi.fn(),
    };
    expect(isWhitelistedUrl(exec, 'https://na3.docusign.net/Signing/abc')).toBe(
      true,
    );
    expect(isWhitelistedUrl(exec, 'https://app.docusign.com/x')).toBe(true);
    expect(isWhitelistedUrl(exec, 'https://evil.com/fake-docusign')).toBe(
      false,
    );
    expect(isWhitelistedUrl(exec, 'not-a-url')).toBe(false);
  });
});
