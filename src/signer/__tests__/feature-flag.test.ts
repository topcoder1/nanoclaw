import { describe, it, expect, afterEach, vi } from 'vitest';

// readEnvValue (in src/env.ts) reads .env from disk when process.env is
// unset. Mock it so this test exercises the feature-flag logic without
// being at the mercy of the developer's local .env file. Without the
// mock, "returns false when env var is not set" would fail whenever the
// developer has SIGNER_AUTO_SIGN_ENABLED=true in .env (matches their
// running install) — a false-negative that has nothing to do with the
// function under test.
const readEnvValueMock = vi.fn<(name: string) => string | undefined>();
vi.mock('../../env.js', () => ({
  readEnvValue: (name: string) => readEnvValueMock(name),
}));

import { isSignerAutoSignEnabled } from '../feature-flag.js';

describe('isSignerAutoSignEnabled', () => {
  afterEach(() => {
    readEnvValueMock.mockReset();
  });

  it('returns false when env var is not set', () => {
    readEnvValueMock.mockReturnValue(undefined);
    expect(isSignerAutoSignEnabled()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    readEnvValueMock.mockReturnValue('true');
    expect(isSignerAutoSignEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    readEnvValueMock.mockReturnValue('false');
    expect(isSignerAutoSignEnabled()).toBe(false);
  });

  it('returns false when env var is "1"', () => {
    readEnvValueMock.mockReturnValue('1');
    expect(isSignerAutoSignEnabled()).toBe(false);
  });
});
