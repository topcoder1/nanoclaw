import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

// Mock container-only dependencies that aren't installed on the host
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}));
vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: vi.fn(),
}));

describe('MCP bridge config builder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('registers nanoclaw server when mcp file exists', async () => {
    const originalExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr.endsWith('nanoclaw-mcp.js')) return true;
      return originalExists(pathStr);
    });

    vi.resetModules();
    const { buildMcpServerConfigs } =
      await import('../../container/agent-runner/src/mcp-bridge.js');

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('nanoclaw');
    expect(configs['nanoclaw'].env.NANOCLAW_CHAT_JID).toBe('test@chat');
    expect(configs['nanoclaw'].env.NANOCLAW_IS_MAIN).toBe('0');
  });

  it('registers gmail server when credentials exist', async () => {
    const originalExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === '/home/node/.gmail-mcp/credentials.json') return true;
      return originalExists(pathStr);
    });

    vi.resetModules();
    const { buildMcpServerConfigs } =
      await import('../../container/agent-runner/src/mcp-bridge.js');

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('gmail-personal');
  });

  it('registers notion server when token env var is set', async () => {
    process.env.NOTION_TOKEN = 'test-notion-token';

    vi.resetModules();
    const { buildMcpServerConfigs } =
      await import('../../container/agent-runner/src/mcp-bridge.js');

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('notion');

    delete process.env.NOTION_TOKEN;
  });

  it('returns empty config when no servers are available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    vi.resetModules();
    const { buildMcpServerConfigs } =
      await import('../../container/agent-runner/src/mcp-bridge.js');

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(Object.keys(configs)).toHaveLength(0);
  });
});

describe('connectMcpServers', () => {
  it('returns only the safe Gmail tools, and every tool of the other servers', async () => {
    const { connectMcpServers } =
      await import('../../container/agent-runner/src/mcp-bridge.js');
    const toolsByServer: Record<string, Record<string, string>> = {
      'gmail-personal': {
        search_emails: 'gmail search',
        send_email: 'gmail send',
        forward_email: 'gmail forward',
      },
      notion: { send_email: 'notion send', search: 'notion search' },
    };
    const closed: string[] = [];
    // Never started: the injected connect below stands in for the transport.
    const config = { command: '/nonexistent/test-mcp', args: [], env: {} };

    const { tools, cleanup } = await connectMcpServers(
      { 'gmail-personal': config, broken: config, notion: config },
      async (name: string) => {
        if (name === 'broken') throw new Error('spawn failed');
        return {
          tools: async () => toolsByServer[name],
          close: async () => {
            closed.push(name);
          },
        };
      },
    );

    // One server failing to connect costs only its own tools.
    expect(tools).toEqual({
      'mcp__gmail-personal__search_emails': 'gmail search',
      mcp__notion__send_email: 'notion send',
      mcp__notion__search: 'notion search',
    });
    await cleanup();
    expect(closed).toEqual(['gmail-personal', 'notion']);
  });
});
