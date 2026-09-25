import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import {
  SAFE_GMAIL_TOOL_SUFFIXES,
  blockedGmailTools,
  denyBlockedGmailTools,
  exposedTools,
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
  'create_filter', // its forward action sends mail on
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
    expect(safe.has('mcp__gmail-personal__create_filter_from_template')).toBe(
      true,
    );
  });

  it('the runner hands the blocked tools to disallowedTools', () => {
    // A list nobody passes to the query blocks nothing.
    const src = readFileSync(
      new URL('../../container/agent-runner/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("permissionMode: 'bypassPermissions'");
    // Anchored to a whole line, so a commented-out line does not satisfy it.
    expect(src).toMatch(/^\s*disallowedTools: blockedGmailTools\(\),\s*$/m);
    expect(src).not.toContain("'send_email'");
  });

  it('the MCP bridge drops blocked tools for every provider', () => {
    // The Vercel runner (OpenAI, Google, Ollama, ...) takes every tool the
    // bridge returns and has no disallowedTools, so the bridge must drop them.
    expect(
      exposedTools('gmail-personal', {
        send_email: 1,
        create_filter: 2,
        draft_email: 3,
      }),
    ).toEqual({ 'mcp__gmail-personal__draft_email': 3 });
    // Control: another server's send tool is not ours to drop.
    expect(exposedTools('notion', { send_email: 1 })).toEqual({
      mcp__notion__send_email: 1,
    });
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
    // A live call, not a comment, and no second way into the tool set.
    expect(bridge).toMatch(
      /^\s*Object\.assign\(allTools, exposedTools\(name, tools\)\);\s*$/m,
    );
    expect(bridge).not.toMatch(/allTools\[/);
  });

  it('hides any Gmail tool the safe list does not name', () => {
    // Fail closed: the package is third-party, and a new release can add a
    // tool that sends mail. forward_email is not one of today's tools.
    expect(
      exposedTools('gmail-personal', { forward_email: 1, search_emails: 2 }),
    ).toEqual({ 'mcp__gmail-personal__search_emails': 2 });
    // A Gmail account the safe list does not know gets no tools at all.
    expect(
      exposedTools('gmail-work', { search_emails: 1, send_email: 2 }),
    ).toEqual({});
    // Control: every tool of a server that is not Gmail's passes through.
    expect(exposedTools('notion', { send_email: 1, new_tool: 2 })).toEqual({
      mcp__notion__send_email: 1,
      mcp__notion__new_tool: 2,
    });
  });

  it('the PreToolUse hook denies any Gmail tool the safe list does not name', async () => {
    const decide = (toolName: string) =>
      denyBlockedGmailTools(
        {
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: {},
          tool_use_id: 'toolu_test',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/workspace/group',
        },
        'toolu_test',
        { signal: new AbortController().signal },
      );
    const DENY = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    };
    expect(await decide('mcp__gmail-personal__send_email')).toMatchObject(DENY);
    expect(await decide('mcp__gmail__create_filter')).toMatchObject(DENY);
    expect(await decide('mcp__gmail-personal__forward_email')).toMatchObject(
      DENY,
    );
    expect(await decide('mcp__gmail-work__search_emails')).toMatchObject(DENY);
    expect(await decide('mcp__gmail-personal__draft_email')).toEqual({});
    // Controls: tools that are not Gmail's go on to the permission mode.
    expect(await decide('mcp__notion__send_email')).toEqual({});
    expect(await decide('Bash')).toEqual({});
  });

  it('the runner registers the hook for every tool call', () => {
    // bypassPermissions approves any tool disallowedTools does not name; a
    // PreToolUse deny still holds in that mode.
    const src = readFileSync(
      new URL('../../container/agent-runner/src/index.ts', import.meta.url),
      'utf8',
    );
    // A whole live line, with no matcher narrowing which calls reach it.
    expect(src).toMatch(
      /^\s*PreToolUse: \[\{ hooks: \[denyBlockedGmailTools\] \}\],\s*$/m,
    );
  });

  it('pins the Gmail MCP package wherever it is installed or started', () => {
    // A new release can add tools. Bump the pin only after classifying every
    // tool the new release has in gmail-tools.ts. Hardcoded on purpose.
    const PINNED = '@gongrzhe/server-gmail-autoauth-mcp@1.1.11';
    for (const file of [
      '../../container/Dockerfile',
      '../../container/agent-runner/src/index.ts',
      '../../container/agent-runner/src/mcp-bridge.ts',
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const refs = text.match(/@gongrzhe\/server-gmail-autoauth-mcp[^\s'"]*/g);
      expect(refs, file).not.toBeNull();
      expect(new Set(refs), file).toEqual(new Set([PINNED]));
    }
  });
});
