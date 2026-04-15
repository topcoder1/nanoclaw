import fs from 'fs';
import path from 'path';
import { z } from 'zod';

interface ToolDefinition {
  description: string;
  parameters: z.ZodType<any>;
  execute: (args: any, context: any) => Promise<{ success: boolean }>;
}

function writeIpcFile(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `vercel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

export function buildIpcTools(
  ipcDir: string,
  chatJid: string,
  groupFolder: string,
): Record<string, ToolDefinition> {
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');

  return {
    send_message: {
      description: 'Send a message to the chat',
      parameters: z.object({
        text: z.string().describe('Message text to send'),
      }),
      execute: async ({ text }: { text: string }) => {
        writeIpcFile(messagesDir, {
          type: 'message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    schedule: {
      description: 'Schedule a task for later execution',
      parameters: z.object({
        when: z.string().describe('When to run (cron expression or relative time)'),
        prompt: z.string().describe('Task prompt'),
        label: z.string().optional().describe('Human-readable label'),
      }),
      execute: async ({ when, prompt, label }: { when: string; prompt: string; label?: string }) => {
        writeIpcFile(tasksDir, {
          type: 'schedule',
          chatJid,
          groupFolder,
          when,
          prompt,
          label,
        });
        return { success: true };
      },
    },

    relay_message: {
      description: 'Relay a message to the main group channel',
      parameters: z.object({
        text: z.string().describe('Message to relay'),
      }),
      execute: async ({ text }: { text: string }) => {
        writeIpcFile(messagesDir, {
          type: 'relay_message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    learn_feedback: {
      description: 'Record a learned rule from this interaction',
      parameters: z.object({
        rule: z.string().describe('The rule or pattern learned'),
        source: z.enum(['user_feedback', 'outcome_pattern', 'agent_reported']),
      }),
      execute: async ({ rule, source }: { rule: string; source: string }) => {
        writeIpcFile(messagesDir, {
          type: 'learn_feedback',
          chatJid,
          groupFolder,
          rule,
          source,
        });
        return { success: true };
      },
    },
  };
}
