/**
 * Which Gmail MCP tools the agent may use, and which it must never see.
 *
 * The agent runs with `permissionMode: 'bypassPermissions'`, and in that mode
 * `allowedTools` restricts nothing: it only pre-approves the tools it lists, and
 * the mode approves every other tool ("`allowed_tools` does not constrain
 * `bypassPermissions`" — Agent SDK permissions docs). So leaving a tool out of
 * the allowed list never kept the agent from calling it. `disallowedTools`
 * does: a bare tool name there removes the tool from the request, and the agent
 * cannot attempt it in any mode.
 *
 * Blocked:
 * - `send_email` (2026-09-24): agents draft, Jonathan sends — from Gmail, or
 *   from a Claude Code session where every send raises a permission prompt.
 * - `create_filter`: its `forward` action sends matching mail on to any
 *   verified forwarding address, a send with no send call.
 *   `create_filter_from_template` stays: its templates only label, archive or
 *   mark mail.
 * - The four tools that destroy mail. The allowed list below always meant to
 *   exclude them ("so the agent cannot permanently destroy emails"), but under
 *   bypassPermissions leaving them out of it did nothing.
 *
 * Anything the safe list does not name is blocked too. The Gmail MCP package
 * is third-party and a new release can add a tool that sends mail, so
 * exposedTools() and denyBlockedGmailTools() let a Gmail tool through only
 * when SAFE_GMAIL_TOOL_SUFFIXES names it. The package is also pinned
 * (container/Dockerfile and the npx args that start it), so a new release
 * arrives only with a reviewed bump.
 *
 * Limit: this hides the tools; it is not a security boundary. The agent keeps
 * Bash, and the container mounts each account's Gmail OAuth credentials
 * (src/container-runner.ts), so it could still call the Gmail API directly.
 * Gmail has no OAuth scope that allows drafts but not sending (`gmail.compose`
 * covers both), so a hard boundary means keeping the credentials out of the
 * container, e.g. a host-side proxy that refuses send and delete.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

export const GMAIL_ACCOUNT_NAMES = [
  'gmail',
  'gmail-personal',
  'gmail-whoisxml',
  'gmail-attaxion',
  'gmail-dev',
] as const;

/** Gmail tools the agent may use (pre-approved; never the blocked ones). */
export const SAFE_GMAIL_TOOL_SUFFIXES = [
  'search_emails',
  'read_email',
  'draft_email',
  'modify_email',
  'batch_modify_emails',
  'list_email_labels',
  'download_attachment',
  'create_label',
  'update_label',
  'create_filter_from_template',
  'get_filter',
  'get_or_create_label',
  'list_filters',
] as const;

/** Gmail tools the agent must never see, whatever the permission mode. */
export const BLOCKED_GMAIL_TOOL_SUFFIXES = [
  'send_email',
  'create_filter',
  'delete_email',
  'batch_delete_emails',
  'delete_label',
  'delete_filter',
] as const;

function forAllAccounts(suffixes: readonly string[]): string[] {
  return GMAIL_ACCOUNT_NAMES.flatMap((acct) =>
    suffixes.map((suffix) => `mcp__${acct}__${suffix}`),
  );
}

/** Expand the safe Gmail tools for all accounts into allowedTools entries. */
export function safeGmailTools(): string[] {
  return forAllAccounts(SAFE_GMAIL_TOOL_SUFFIXES);
}

/** Expand the blocked Gmail tools for all accounts into disallowedTools entries. */
export function blockedGmailTools(): string[] {
  return forAllAccounts(BLOCKED_GMAIL_TOOL_SUFFIXES);
}

/**
 * True for a prefixed MCP tool name (`mcp__<server>__<tool>`) the agent must
 * not use: any tool of a Gmail server (one whose name starts with `gmail`)
 * that safeGmailTools() does not name. That covers the blocked list, a tool a
 * newer package release adds, and every tool of an account missing from
 * GMAIL_ACCOUNT_NAMES.
 */
export function isBlockedGmailTool(prefixedName: string): boolean {
  return (
    prefixedName.startsWith('mcp__gmail') &&
    !safeGmailTools().includes(prefixedName)
  );
}

/**
 * A server's tools under their prefixed names (`mcp__<server>__<tool>`),
 * keeping only the safe tools of a Gmail server. The MCP bridge builds every
 * provider's tool set with this, because the Vercel runner has no
 * disallowedTools.
 */
export function exposedTools<T>(
  server: string,
  tools: Record<string, T>,
): Record<string, T> {
  const exposed: Record<string, T> = {};
  for (const [toolName, toolDef] of Object.entries(tools)) {
    const prefixedName = `mcp__${server}__${toolName}`;
    if (!isBlockedGmailTool(prefixedName)) exposed[prefixedName] = toolDef;
  }
  return exposed;
}

/**
 * PreToolUse hook that denies every tool isBlockedGmailTool() blocks.
 * disallowedTools removes only the tools BLOCKED_GMAIL_TOOL_SUFFIXES names;
 * this also stops any other, such as a tool a newer release adds. Hooks run
 * before the permission mode, and "a hook deny applies even in
 * bypassPermissions mode" (Agent SDK permissions docs).
 */
export const denyBlockedGmailTools: HookCallback = async (input) => {
  if (
    input.hook_event_name !== 'PreToolUse' ||
    !isBlockedGmailTool(input.tool_name)
  ) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${input.tool_name} is not on the agent's Gmail allow-list`,
    },
  };
};
