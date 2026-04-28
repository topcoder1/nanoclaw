import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('tool-bridge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tools-test-'));
    fs.mkdirSync(path.join(tempDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tasks'), { recursive: true });

    // Stub fetch so trust gateway calls return approved. Without a stub, fetch
    // throws (no gateway in tests) and the bridge correctly fails closed —
    // which would block the IPC-write paths these tests are designed to cover.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ decision: 'approved' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('buildIpcTools returns tool definitions with correct names', async () => {
    const { buildIpcTools } =
      await import('../../container/agent-runner/src/tool-bridge.js');
    const tools = buildIpcTools(tempDir, 'test-jid', 'test-group');
    expect(Object.keys(tools)).toContain('send_message');
    expect(Object.keys(tools)).toContain('schedule');
    expect(Object.keys(tools)).toContain('relay_message');
    expect(Object.keys(tools)).toContain('learn_feedback');
  });

  it('send_message tool writes JSON file to messages dir', async () => {
    const { buildIpcTools } =
      await import('../../container/agent-runner/src/tool-bridge.js');
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.send_message.execute(
      { text: 'hello world' },
      { toolCallId: 'tc1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'messages'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'messages', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('message');
    expect(data.text).toBe('hello world');
    expect(data.chatJid).toBe('chat@jid');
  });

  it('schedule tool writes JSON file to tasks dir', async () => {
    const { buildIpcTools } =
      await import('../../container/agent-runner/src/tool-bridge.js');
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.schedule.execute(
      { when: '0 8 * * *', prompt: 'daily check', label: 'Morning check' },
      { toolCallId: 'tc2', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'tasks'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'tasks', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('schedule');
    expect(data.prompt).toBe('daily check');
  });

  it('learn_feedback tool writes to messages dir', async () => {
    const { buildIpcTools } =
      await import('../../container/agent-runner/src/tool-bridge.js');
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.learn_feedback.execute(
      { rule: 'Always check auth first', source: 'user_feedback' },
      { toolCallId: 'tc3', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'messages'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'messages', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('learn_feedback');
  });

  it('fails closed when trust gateway is unreachable (does not silently allow)', async () => {
    // Override the approve-everything stub with one that simulates network failure.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const { buildIpcTools } =
      await import('../../container/agent-runner/src/tool-bridge.js');
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.send_message.execute(
      { text: 'should not be sent' },
      { toolCallId: 'tc-fail', messages: [], abortSignal: undefined as any },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/trust gateway unreachable/i);

    // No IPC file should have been written
    const files = fs.readdirSync(path.join(tempDir, 'messages'));
    expect(files).toHaveLength(0);
  });
});
