import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config before importing session-manager
vi.mock('../config.js', () => ({
  BROWSER_MAX_CONTEXTS: 3,
  BROWSER_CDP_URL: 'ws://localhost:9222',
  BROWSER_PROFILE_DIR: 'browser',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { BrowserSessionManager } from './session-manager.js';

describe('BrowserSessionManager', () => {
  let manager: BrowserSessionManager;

  beforeEach(() => {
    manager = new BrowserSessionManager();
  });

  describe('createContext', () => {
    it('creates a new active context', async () => {
      const ctx = await manager.createContext('group-1');
      expect(ctx.groupId).toBe('group-1');
      expect(ctx.state).toBe('active');
      expect(ctx.createdAt).toBeGreaterThan(0);
    });

    it('returns existing active context for same group', async () => {
      const ctx1 = await manager.createContext('group-1');
      const ctx2 = await manager.createContext('group-1');
      expect(ctx1).toBe(ctx2);
    });

    it('stores profileDir when provided', async () => {
      const ctx = await manager.createContext(
        'group-1',
        '/data/groups/group-1/browser',
      );
      expect(ctx.profileDir).toBe('/data/groups/group-1/browser');
    });

    it('defaults profileDir to null', async () => {
      const ctx = await manager.createContext('group-1');
      expect(ctx.profileDir).toBeNull();
    });

    it('enforces max concurrent contexts', async () => {
      await manager.createContext('g1');
      await manager.createContext('g2');
      await manager.createContext('g3');
      await expect(manager.createContext('g4')).rejects.toThrow(
        'max concurrent contexts reached',
      );
    });

    it('allows new context after closing one', async () => {
      await manager.createContext('g1');
      await manager.createContext('g2');
      await manager.createContext('g3');

      await manager.closeContext('g2');

      const ctx = await manager.createContext('g4');
      expect(ctx.state).toBe('active');
    });
  });

  describe('getContext', () => {
    it('returns null for unknown group', () => {
      expect(manager.getContext('nope')).toBeNull();
    });

    it('returns active context', async () => {
      await manager.createContext('group-1');
      const ctx = manager.getContext('group-1');
      expect(ctx).not.toBeNull();
      expect(ctx!.groupId).toBe('group-1');
    });

    it('returns null after context is closed', async () => {
      await manager.createContext('group-1');
      await manager.closeContext('group-1');
      expect(manager.getContext('group-1')).toBeNull();
    });
  });

  describe('closeContext', () => {
    it('removes context from tracking', async () => {
      await manager.createContext('group-1');
      expect(manager.getActiveContextCount()).toBe(1);

      await manager.closeContext('group-1');
      expect(manager.getActiveContextCount()).toBe(0);
    });

    it('is idempotent for unknown groups', async () => {
      // Should not throw
      await manager.closeContext('nonexistent');
    });

    it('is idempotent for already-closed groups', async () => {
      await manager.createContext('group-1');
      await manager.closeContext('group-1');
      await manager.closeContext('group-1'); // no throw
    });
  });

  describe('closeAll', () => {
    it('closes all active contexts', async () => {
      await manager.createContext('g1');
      await manager.createContext('g2');
      await manager.createContext('g3');
      expect(manager.getActiveContextCount()).toBe(3);

      await manager.closeAll();
      expect(manager.getActiveContextCount()).toBe(0);
    });
  });

  describe('getActiveContextCount', () => {
    it('starts at 0', () => {
      expect(manager.getActiveContextCount()).toBe(0);
    });

    it('increments on create', async () => {
      await manager.createContext('g1');
      expect(manager.getActiveContextCount()).toBe(1);
      await manager.createContext('g2');
      expect(manager.getActiveContextCount()).toBe(2);
    });
  });

  describe('getActiveGroupIds', () => {
    it('returns empty array initially', () => {
      expect(manager.getActiveGroupIds()).toEqual([]);
    });

    it('returns active group ids', async () => {
      await manager.createContext('g1');
      await manager.createContext('g2');
      const ids = manager.getActiveGroupIds();
      expect(ids).toContain('g1');
      expect(ids).toContain('g2');
    });
  });

  describe('events', () => {
    it('emits browser.context.created on create', async () => {
      const events: Array<{ type: string; groupId: string }> = [];
      manager.on('browser.context.created', (e) => events.push(e));

      await manager.createContext('group-1');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('browser.context.created');
      expect(events[0].groupId).toBe('group-1');
    });

    it('emits browser.context.closed on close', async () => {
      const events: Array<{ type: string; groupId: string }> = [];
      manager.on('browser.context.closed', (e) => events.push(e));

      await manager.createContext('group-1');
      await manager.closeContext('group-1');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('browser.context.closed');
      expect(events[0].groupId).toBe('group-1');
    });

    it('does not emit closed for unknown groups', async () => {
      const events: Array<{ type: string }> = [];
      manager.on('browser.context.closed', (e) => events.push(e));

      await manager.closeContext('nope');
      expect(events).toHaveLength(0);
    });

    it('unsubscribe stops events', async () => {
      const events: Array<{ type: string }> = [];
      const unsub = manager.on('browser.context.created', (e) =>
        events.push(e),
      );

      await manager.createContext('g1');
      expect(events).toHaveLength(1);

      unsub();
      await manager.createContext('g2');
      expect(events).toHaveLength(1); // no new event
    });

    it('swallows handler errors without crashing', async () => {
      manager.on('browser.context.created', () => {
        throw new Error('handler boom');
      });

      // Should not throw
      const ctx = await manager.createContext('g1');
      expect(ctx.state).toBe('active');
    });
  });

  describe('custom maxContexts', () => {
    it('respects constructor override', async () => {
      const small = new BrowserSessionManager(1);
      await small.createContext('g1');
      await expect(small.createContext('g2')).rejects.toThrow(
        'max concurrent contexts reached (1)',
      );
    });
  });
});
