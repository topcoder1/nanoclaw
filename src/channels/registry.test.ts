import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';

// The registry is module-level state, so we need a fresh module per test.
// We use dynamic import with cache-busting to isolate tests.
// However, since vitest runs each file in its own context and we control
// registration order, we can test the public API directly.

describe('channel registry', () => {
  // Note: registry is shared module state across tests in this file.
  // Tests are ordered to account for cumulative registrations.

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel('test-channel', factory);
    expect(getChannelFactory('test-channel')).toBe(factory);
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('another-channel', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('later registration overwrites earlier one', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('overwrite-test', factory1);
    registerChannel('overwrite-test', factory2);
    expect(getChannelFactory('overwrite-test')).toBe(factory2);
  });
});

/**
 * Regression guard for the 2026-09-08 Signal removal.
 *
 * The signal-cli-rest-api bridge this channel talked to had been dead since
 * 2026-05-08, so every box spent four months polling a dead localhost:18080
 * every two seconds. The channel was deleted outright.
 *
 * These assertions are deliberately static rather than importing the barrel:
 * `src/channels/index.js` self-registers every channel as an import side
 * effect, which is why src/index.test.ts mocks it away entirely. Reading the
 * source is enough to catch the failure mode that matters — Signal silently
 * coming back via a skill-branch merge — without dragging real channel
 * modules and their credential lookups into a unit test.
 */
describe('signal channel stays removed', () => {
  const channelsDir = path.dirname(fileURLToPath(import.meta.url));

  it('the self-registration barrel does not import a signal module', () => {
    const barrel = readFileSync(path.join(channelsDir, 'index.ts'), 'utf-8');
    expect(barrel).not.toMatch(/signal/i);
  });

  it('no signal channel module is present', () => {
    expect(existsSync(path.join(channelsDir, 'signal.ts'))).toBe(false);
  });
});
