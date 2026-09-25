/**
 * Which Gmail MCP tools the agent may use, and which it must never see.
 *
 * The agent runs with `permissionMode: 'bypassPermissions'`, and in that mode
 * `allowedTools` restricts nothing: it only pre-approves the tools it lists, and
 * the mode approves every other tool ("`allowed_tools` does not constrain
 * `bypassPermissions`" — Agent SDK permissions docs). So leaving a tool out of
 * the allowed list never kept the agent from calling it. Only `disallowedTools`
 * does: a bare tool name there removes the tool from the request, and the agent
 * cannot attempt it in any mode.
 *
 * Blocked:
 * - `send_email` (2026-09-24): agents draft, Jonathan sends — from Gmail, or
 *   from a Claude Code session where every send raises a permission prompt.
 * - The four tools that destroy mail. The allowed list below always meant to
 *   exclude them ("so the agent cannot permanently destroy emails"), but under
 *   bypassPermissions leaving them out of it did nothing.
 */

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
  'create_filter',
  'create_filter_from_template',
  'get_filter',
  'get_or_create_label',
  'list_filters',
] as const;

/** Gmail tools the agent must never see, whatever the permission mode. */
export const BLOCKED_GMAIL_TOOL_SUFFIXES = [
  'send_email',
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

/** True for a prefixed MCP tool name (`mcp__<server>__<tool>`) that is blocked. */
export function isBlockedGmailTool(prefixedName: string): boolean {
  return blockedGmailTools().includes(prefixedName);
}
