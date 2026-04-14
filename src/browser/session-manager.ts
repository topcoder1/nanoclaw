/**
 * Browser Session Manager
 *
 * Manages per-group browser context lifecycle as a state machine.
 * For v1, this tracks state only — actual CDP connections happen
 * when the browser sidecar infrastructure is running.
 */
import { logger } from '../logger.js';
import { BROWSER_MAX_CONTEXTS } from '../config.js';

export type ContextState = 'creating' | 'active' | 'closing' | 'closed';

export interface BrowserContext {
  groupId: string;
  state: ContextState;
  createdAt: number;
  /** Profile directory path for this group's browser data */
  profileDir: string | null;
}

export interface BrowserContextEvent {
  type: 'browser.context.created' | 'browser.context.closed';
  groupId: string;
  timestamp: number;
}

type EventHandler = (event: BrowserContextEvent) => void;

export class BrowserSessionManager {
  private contexts = new Map<string, BrowserContext>();
  private handlers = new Map<string, EventHandler[]>();
  private maxContexts: number;

  constructor(maxContexts?: number) {
    this.maxContexts = maxContexts ?? BROWSER_MAX_CONTEXTS;
  }

  /**
   * Create a new browser context for a group.
   * Throws if max concurrent contexts would be exceeded.
   */
  async createContext(
    groupId: string,
    profileDir?: string,
  ): Promise<BrowserContext> {
    // Check if context already exists
    const existing = this.contexts.get(groupId);
    if (existing && existing.state === 'active') {
      return existing;
    }

    // Check capacity
    const activeCount = this.getActiveContextCount();
    if (activeCount >= this.maxContexts) {
      throw new Error(
        `Cannot create browser context for "${groupId}": ` +
          `max concurrent contexts reached (${this.maxContexts})`,
      );
    }

    const context: BrowserContext = {
      groupId,
      state: 'creating',
      createdAt: Date.now(),
      profileDir: profileDir ?? null,
    };

    this.contexts.set(groupId, context);

    // In v1, transition directly to active (no real CDP connection).
    // When sidecar is running, this is where we'd connect via CDP.
    context.state = 'active';

    logger.info({ groupId }, 'Browser context created');
    this.emit({
      type: 'browser.context.created',
      groupId,
      timestamp: Date.now(),
    });

    return context;
  }

  /**
   * Get an existing active context for a group.
   */
  getContext(groupId: string): BrowserContext | null {
    const ctx = this.contexts.get(groupId);
    if (!ctx || ctx.state !== 'active') return null;
    return ctx;
  }

  /**
   * Close and clean up a browser context.
   */
  async closeContext(groupId: string): Promise<void> {
    const ctx = this.contexts.get(groupId);
    if (!ctx) return;
    if (ctx.state === 'closed' || ctx.state === 'closing') return;

    ctx.state = 'closing';

    // In v1, no real CDP cleanup needed.
    // When sidecar is running, this is where we'd close the CDP context.
    ctx.state = 'closed';
    this.contexts.delete(groupId);

    logger.info({ groupId }, 'Browser context closed');
    this.emit({
      type: 'browser.context.closed',
      groupId,
      timestamp: Date.now(),
    });
  }

  /**
   * Close all active contexts.
   */
  async closeAll(): Promise<void> {
    const groupIds = [...this.contexts.keys()];
    for (const groupId of groupIds) {
      await this.closeContext(groupId);
    }
  }

  /**
   * Number of active (non-closed) browser contexts.
   */
  getActiveContextCount(): number {
    let count = 0;
    for (const ctx of this.contexts.values()) {
      if (ctx.state === 'active' || ctx.state === 'creating') {
        count++;
      }
    }
    return count;
  }

  /**
   * List all active context group IDs.
   */
  getActiveGroupIds(): string[] {
    const ids: string[] = [];
    for (const ctx of this.contexts.values()) {
      if (ctx.state === 'active') {
        ids.push(ctx.groupId);
      }
    }
    return ids;
  }

  /**
   * Subscribe to browser context events.
   */
  on(
    eventType: BrowserContextEvent['type'],
    handler: EventHandler,
  ): () => void {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);

    // Return unsubscribe function
    return () => {
      const current = this.handlers.get(eventType) || [];
      const idx = current.indexOf(handler);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  private emit(event: BrowserContextEvent): void {
    const handlers = this.handlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error(
          { error: err, eventType: event.type },
          'Browser context event handler threw',
        );
      }
    }
  }
}
