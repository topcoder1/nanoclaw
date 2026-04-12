import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    ...overrides,
  };
}

// --- Tests ---

describe('SignalChannel factory registration', () => {
  it('calls registerChannel("signal", ...) on import', () => {
    expect(registerChannel).toHaveBeenCalledWith('signal', expect.any(Function));
  });

  it('factory returns null when SIGNAL_API_URL is missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({ SIGNAL_PHONE_NUMBER: '+15550001234' });

    const [, factory] = vi.mocked(registerChannel).mock.calls.find(
      ([name]) => name === 'signal',
    )!;

    const result = factory(createTestOpts());
    expect(result).toBeNull();
  });

  it('factory returns null when SIGNAL_PHONE_NUMBER is missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({ SIGNAL_API_URL: 'http://localhost:8080' });

    const [, factory] = vi.mocked(registerChannel).mock.calls.find(
      ([name]) => name === 'signal',
    )!;

    const result = factory(createTestOpts());
    expect(result).toBeNull();
  });
});

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sig: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:+15550009999')).toBe(true);
    });

    it('owns sig:group: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:group:abc123')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.isConnected()).toBe(false);
    });
  });
});
