import type { EventBus } from './event-bus.js';

interface ActiveTask {
  taskId: string;
  groupJid: string;
  label: string;
  startedAt: number;
}

interface PendingItem {
  id: string;
  label: string;
  addedAt: number;
}

interface StatusBarOpts {
  onUpdate: (text: string) => void;
  debounceMs?: number;
}

export class StatusBarManager {
  private activeTasks = new Map<string, ActiveTask>();
  private pendingItems = new Map<string, PendingItem>();
  private autoHandledCount = 0;
  private draftsEnrichedCount = 0;
  private blockedCount = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: Required<StatusBarOpts>;
  private unsubscribers: Array<() => void> = [];

  constructor(bus: EventBus, opts: StatusBarOpts) {
    this.opts = { debounceMs: 2000, ...opts };

    this.unsubscribers.push(
      bus.on('task.started', (e) => {
        this.activeTasks.set(e.payload.taskId, {
          taskId: e.payload.taskId,
          groupJid: e.payload.groupJid,
          label: e.payload.containerName,
          startedAt: e.timestamp,
        });
        this.scheduleUpdate();
      }),
    );

    this.unsubscribers.push(
      bus.on('task.progress', (e) => {
        const task = this.activeTasks.get(e.payload.taskId);
        if (task) {
          task.label = e.payload.label;
          this.scheduleUpdate();
        }
      }),
    );

    this.unsubscribers.push(
      bus.on('task.complete', (e) => {
        this.activeTasks.delete(e.payload.taskId);
        if (e.payload.status === 'error') {
          this.blockedCount++;
        }
        this.scheduleUpdate();
      }),
    );
  }

  addPendingItem(id: string, label: string): void {
    this.pendingItems.set(id, { id, label, addedAt: Date.now() });
    this.scheduleUpdate();
  }

  removePendingItem(id: string): void {
    this.pendingItems.delete(id);
    this.scheduleUpdate();
  }

  incrementAutoHandled(): void {
    this.autoHandledCount++;
    this.scheduleUpdate();
  }

  incrementDraftsEnriched(): void {
    this.draftsEnrichedCount++;
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(), this.opts.debounceMs);
  }

  private render(): void {
    const lines: string[] = [];
    lines.push(`<b>NANOCLAW STATUS</b>`);
    lines.push('─'.repeat(20));

    // Active tasks
    if (this.activeTasks.size > 0) {
      lines.push(`<b>ACTIVE (${this.activeTasks.size})</b>`);
      for (const task of this.activeTasks.values()) {
        lines.push(`● ${task.label}`);
      }
    }

    // Pending items
    if (this.pendingItems.size > 0) {
      lines.push('');
      lines.push(`<b>NEEDS YOU (${this.pendingItems.size})</b>`);
      for (const item of this.pendingItems.values()) {
        lines.push(item.label);
      }
    }

    // Daily stats
    const stats: string[] = [];
    if (this.autoHandledCount > 0) stats.push(`${this.autoHandledCount} auto-handled`);
    if (this.draftsEnrichedCount > 0) stats.push(`${this.draftsEnrichedCount} drafts enriched`);
    if (this.pendingItems.size > 0) stats.push(`${this.pendingItems.size} needs you`);
    if (this.blockedCount > 0) stats.push(`${this.blockedCount} blocked`);

    if (stats.length > 0) {
      lines.push('');
      lines.push(`TODAY: ${stats.join(' · ')}`);
    }

    this.opts.onUpdate(lines.join('\n'));
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
