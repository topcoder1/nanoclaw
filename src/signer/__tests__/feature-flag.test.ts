import { describe, it, expect, afterEach } from 'vitest';
import { isSignerAutoSignEnabled } from '../feature-flag.js';

describe('isSignerAutoSignEnabled', () => {
  afterEach(() => {
    delete process.env.SIGNER_AUTO_SIGN_ENABLED;
  });

  it('returns false when env var is not set', () => {
    delete process.env.SIGNER_AUTO_SIGN_ENABLED;
    expect(isSignerAutoSignEnabled()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.SIGNER_AUTO_SIGN_ENABLED = 'true';
    expect(isSignerAutoSignEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.SIGNER_AUTO_SIGN_ENABLED = 'false';
    expect(isSignerAutoSignEnabled()).toBe(false);
  });

  it('returns false when env var is "1"', () => {
    process.env.SIGNER_AUTO_SIGN_ENABLED = '1';
    expect(isSignerAutoSignEnabled()).toBe(false);
  });
});
