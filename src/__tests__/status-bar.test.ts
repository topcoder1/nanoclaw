import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBarManager } from '../status-bar.js';
import { EventBus } from '../event-bus.js';
import type { TaskStartedEvent, TaskCompleteEvent } from '../events.js';

describe('StatusBarManager', () => {
  let bus: EventBus;
  let manager: StatusBarManager;
  let lastUpdate: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    lastUpdate = null;
    manager = new StatusBarManager(bus, {
      onUpdate: (text) => { lastUpdate = text; },
    });
  });

  afterEach(() => {
    manager.destroy();
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('updates when a task starts', () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        containerName: 'c1',
        slotIndex: 0,
      },
    } as TaskStartedEvent);

    vi.advanceTimersByTime(2000);
    expect(lastUpdate).not.toBeNull();
    expect(lastUpdate).toContain('ACTIVE');
  });

  it('removes task on completion', () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', containerName: 'c1', slotIndex: 0 },
    } as TaskStartedEvent);

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: { taskId: 't1', groupJid: 'tg:123', status: 'success', durationMs: 5000 },
    } as TaskCompleteEvent);

    vi.advanceTimersByTime(2000);
    expect(lastUpdate).not.toContain('t1');
  });

  it('tracks daily auto-handled count', () => {
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();

    vi.advanceTimersByTime(2000);
    expect(lastUpdate).toContain('3');
  });

  it('debounces rapid updates', () => {
    const onUpdate = vi.fn();
    manager.destroy();
    manager = new StatusBarManager(bus, { onUpdate });

    for (let i = 0; i < 10; i++) {
      manager.incrementAutoHandled();
    }

    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
