import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import {
  SAFE_GMAIL_TOOL_SUFFIXES,
  blockedGmailTools,
  isBlockedGmailTool,
  safeGmailTools,
} from '../../container/agent-runner/src/gmail-tools.js';

// The agent runs in bypassPermissions, where allowedTools restricts nothing:
// only disallowedTools keeps a tool out of reach. These names are hardcoded on
// purpose — a test that takes its expectations from the list it checks can
// never catch that list narrowing.
const ACCOUNTS = [
  'gmail',
  'gmail-personal',
  'gmail-whoisxml',
  'gmail-attaxion',
  'gmail-dev',
];
const MUST_BLOCK = [
  'send_email',
  'delete_email',
  'batch_delete_emails',
  'delete_label',
  'delete_filter',
];

describe('agent-runner Gmail tools', () => {
  it('blocks sending and destroying mail for every account', () => {
    const blocked = new Set(blockedGmailTools());
    const missing = ACCOUNTS.flatMap((acct) =>
      MUST_BLOCK.map((suffix) => `mcp__${acct}__${suffix}`),
    ).filter((tool) => !blocked.has(tool));
    expect(missing).toEqual([]);
  });

  it('never pre-approves a blocked tool, and still lets the agent draft', () => {
    const safe = new Set(safeGmailTools());
    expect(blockedGmailTools().filter((tool) => safe.has(tool))).toEqual([]);
    expect(
      SAFE_GMAIL_TOOL_SUFFIXES.filter((suffix) => MUST_BLOCK.includes(suffix)),
    ).toEqual([]);
    expect(safe.has('mcp__gmail-personal__draft_email')).toBe(true);
  });

  it('the runner hands the blocked tools to disallowedTools', () => {
    // A list nobody passes to the query blocks nothing.
    const src = readFileSync(
      new URL('../../container/agent-runner/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("permissionMode: 'bypassPermissions'");
    expect(src).toContain('disallowedTools: blockedGmailTools()');
    expect(src).not.toContain("'send_email'");
  });

  it('the MCP bridge drops blocked tools for every provider', () => {
    // The Vercel runner (OpenAI, Google, Ollama, ...) takes every tool the
    // bridge returns and has no disallowedTools, so the bridge must drop them.
    expect(isBlockedGmailTool('mcp__gmail-whoisxml__send_email')).toBe(true);
    expect(isBlockedGmailTool('mcp__gmail-dev__batch_delete_emails')).toBe(
      true,
    );
    expect(isBlockedGmailTool('mcp__gmail-personal__draft_email')).toBe(false);
    expect(isBlockedGmailTool('mcp__notion__send_email')).toBe(false);
    const bridge = readFileSync(
      new URL(
        '../../container/agent-runner/src/mcp-bridge.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(bridge).toContain('if (isBlockedGmailTool(prefixedName)) continue;');
  });
});
