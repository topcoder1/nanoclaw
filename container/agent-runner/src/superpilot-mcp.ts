/**
 * SuperPilot MCP Server — lightweight bridge that exposes SuperPilot API
 * endpoints as MCP tools for the NanoClaw agent.
 *
 * Runs as a stdio MCP server inside the container. Proxies HTTP requests
 * to the SuperPilot production API at SUPERPILOT_API_URL.
 *
 * Auth: NANOCLAW_SERVICE_TOKEN passed as Bearer token.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.SUPERPILOT_API_URL || 'https://app.inboxsuperpilot.com/api';
const SERVICE_TOKEN = process.env.NANOCLAW_SERVICE_TOKEN || '';

// Brain miniapp lives on the host. Container-to-host reach varies by
// runtime: Docker Desktop / Apple Container both expose host.docker.internal.
// Fall through to localhost (works under host network) and finally to "off"
// when the env var is set to an empty string — useful for tests / when the
// brain isn't running.
const BRAIN_API_URL =
  process.env.BRAIN_API_URL ?? 'http://host.docker.internal:3847/api/brain';

interface BrainHit {
  ku_id: string;
  text: string;
  source_type: string;
  source_ref: string | null;
  finalScore: number;
}

/**
 * Pull top-K brain hits for a draft prompt. Used by `compose_draft` to layer
 * brain.db context (emails + repo docs + user notes) on top of SuperPilot's
 * built-in SP-KB grounding. Mirrors the agent-side auto-recall thresholds so
 * what the agent "knows" matches what the drafter sees.
 *
 * Returns "" on any failure — drafting must never fail because the brain is
 * unavailable. The SuperPilot side still grounds via SP KB and contact memory.
 */
async function fetchBrainContext(query: string, limit = 5): Promise<string> {
  if (!BRAIN_API_URL || query.trim().length < 8) return '';
  try {
    const url = new URL(`${BRAIN_API_URL}/recall`);
    url.searchParams.set('q', query.slice(0, 500));
    url.searchParams.set('limit', String(limit));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url.toString(), {
      headers: { 'X-Service-Token': SERVICE_TOKEN },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const data = (await res.json()) as { results?: BrainHit[] };
    const hits = (data.results ?? []).filter((h) => h.finalScore >= 0.25);
    if (hits.length === 0) return '';
    const lines = hits.slice(0, limit).map((h) => {
      const tag =
        h.source_type === 'email'
          ? '✉️'
          : h.source_type === 'repo'
            ? '📄'
            : h.source_type === 'note'
              ? '📝'
              : '🧠';
      const label =
        h.source_type === 'repo' && h.source_ref
          ? h.source_ref
          : h.text.split('\n', 1)[0].slice(0, 110);
      const body = h.text.split('\n').slice(0, 3).join(' ').slice(0, 220);
      return `- ${tag} ${label}: ${body}`;
    });
    return (
      `<brain_context>\nRelevant items the brain surfaced for this draft. ` +
      `Use only if useful; do not quote verbatim.\n${lines.join('\n')}\n</brain_context>\n\n`
    );
  } catch {
    return '';
  }
}

async function apiGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${API_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      'X-Service-Token': SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SuperPilot API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPost(path: string, body?: any): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Service-Token': SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SuperPilot API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPut(path: string, body?: any): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: {
      'X-Service-Token': SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SuperPilot API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const server = new McpServer({
  name: 'superpilot',
  version: '1.0.0',
});

// --- Triaged Emails ---

server.tool(
  'get_triaged_emails',
  'Get recently triaged/classified emails from SuperPilot. Returns emails with their type, priority, suggested action, and whether they need a reply.',
  {
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — get emails triaged after this time. Defaults to last 24 hours.'),
    account: z
      .string()
      .optional()
      .describe('Filter by Gmail account alias (e.g. "personal", "whoisxml")'),
  },
  async (args) => {
    try {
      const since = args.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const data = await apiGet('/nanoclaw/triaged-emails', {
        since,
        ...(args.account ? { account: args.account } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- Knowledge Base Search ---

server.tool(
  'search_kb',
  'Semantic search across the SuperPilot knowledge base. Finds relevant documents, templates, and saved content.',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (default 10, max 50)'),
  },
  async (args) => {
    try {
      const data = await apiGet('/nanoclaw/kb/search', {
        q: args.query,
        ...(args.limit ? { limit: String(args.limit) } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- Auto-Draft Management ---

server.tool(
  'get_autodraft_settings',
  'Get current auto-draft settings — which contacts have auto-drafting enabled/disabled, blocked senders, etc.',
  {},
  async () => {
    try {
      const data = await apiGet('/auto-draft/settings');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'update_autodraft_settings',
  'Update auto-draft settings. Can enable/disable auto-drafting, change settings.',
  {
    settings: z.string().describe('JSON string of settings to update (partial update supported)'),
  },
  async (args) => {
    try {
      const data = await apiPut('/auto-draft/settings', JSON.parse(args.settings));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_active_drafts',
  'Get currently active auto-drafted emails that are pending review.',
  {},
  async () => {
    try {
      const data = await apiGet('/auto-draft/active');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_autodraft_status',
  'Get auto-draft sync status — whether it is running, last sync time, error count.',
  {},
  async () => {
    try {
      const data = await apiGet('/autodraft-status/my-status');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- Contact Intelligence ---

server.tool(
  'get_contact_memory',
  'Get SuperPilot\'s memory/context about a specific contact — past interactions, preferences, communication style.',
  {
    email: z.string().describe('Contact email address'),
  },
  async (args) => {
    try {
      const data = await apiGet(`/contacts/${encodeURIComponent(args.email)}/memory`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_contact_voice_profile',
  'Get the writing voice/style profile for a contact — how they write, preferred tone, formality level.',
  {
    email: z.string().describe('Contact email address'),
  },
  async (args) => {
    try {
      const data = await apiGet(`/contacts/${encodeURIComponent(args.email)}/voice-profile`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_vip_contacts',
  'Get the VIP contacts list — high-priority contacts that get special handling.',
  {},
  async () => {
    try {
      const data = await apiGet('/contacts/vip-list');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- Email Composition ---

server.tool(
  'compose_draft',
  'Generate an email draft using SuperPilot AI — uses contact memory, voice profile, SuperPilot KB, AND brain.db (emails + repo docs + user notes) for personalized drafts.',
  {
    thread_id: z.string().optional().describe('Thread ID to reply to (omit for new email)'),
    to: z.string().describe('Recipient email address'),
    subject: z.string().optional().describe('Email subject (for new emails)'),
    instructions: z.string().describe('What the email should say/accomplish'),
    use_brain: z
      .boolean()
      .optional()
      .describe('Inject brain.db context into the instructions (default true). Set false for sensitive drafts where you do not want past notes/emails surfaced.'),
  },
  async (args) => {
    try {
      const useBrain = args.use_brain !== false;
      let instructions = args.instructions;
      if (useBrain) {
        // Query the brain on (subject + instructions) so a reply about
        // "renewal" surfaces the past renewal thread + any notes you saved.
        const queryParts = [args.subject, args.instructions]
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        const brainBlock = await fetchBrainContext(queryParts.join(' — '));
        if (brainBlock) instructions = brainBlock + instructions;
      }
      const data = await apiPost('/compose/draft', {
        thread_id: args.thread_id,
        to: args.to,
        subject: args.subject,
        instructions,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- Thread Exclusions (stop auto-drafting for specific threads) ---

server.tool(
  'block_autodraft_thread',
  'Stop auto-drafting for a specific email thread. Use when the user says "stop drafting for this thread" or "don\'t auto-reply to this".',
  {
    thread_id: z.string().describe('Gmail thread ID to exclude from auto-drafting'),
  },
  async (args) => {
    try {
      const data = await apiPost('/auto-draft/thread-exclusions', {
        thread_id: args.thread_id,
      });
      return {
        content: [{ type: 'text' as const, text: `Thread ${args.thread_id} excluded from auto-drafting.` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'block_autodraft_sender',
  'Block a sender from auto-drafting. No more auto-drafts for emails from this person. Accepts exact email or wildcard pattern (e.g. "*@company.com").',
  {
    email: z.string().describe('Sender email or pattern to block (e.g. "ryan@example.com" or "*@company.com")'),
  },
  async (args) => {
    try {
      const data = await apiPost('/auto-draft/settings/blocked-senders', {
        pattern: args.email,
      });
      return {
        content: [{ type: 'text' as const, text: `Blocked auto-drafting for ${args.email}.` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
