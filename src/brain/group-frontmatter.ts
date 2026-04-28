/**
 * Per-chat ingest config from `groups/<folder>/CLAUDE.md` YAML frontmatter,
 * plus a chat_id → registered-group resolver. Cache invalidates on file mtime.
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { GROUPS_DIR } from '../config.js';
import { getRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';

export interface ChatIngestConfig {
  brain_ingest: 'off' | 'window';
  window_idle_min?: number;
  window_cap?: number;
}

interface CacheEntry {
  mtimeMs: number;
  config: ChatIngestConfig;
}

const cache = new Map<string, CacheEntry>();
const FRONTMATTER_DELIM = '---';
const DEFAULT_CONFIG: ChatIngestConfig = { brain_ingest: 'off' };

/** Test helper — drop the in-memory cache. */
export function _resetGroupFrontmatterCache(): void {
  cache.clear();
}

export function readChatIngestConfig(groupFolder: string): ChatIngestConfig {
  const claudeMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(claudeMd);
  } catch {
    return DEFAULT_CONFIG;
  }
  const cached = cache.get(groupFolder);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;

  let raw: string;
  try {
    raw = fs.readFileSync(claudeMd, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  const config = parseConfig(raw);
  cache.set(groupFolder, { mtimeMs: stat.mtimeMs, config });
  return config;
}

function parseConfig(raw: string): ChatIngestConfig {
  if (!raw.startsWith(FRONTMATTER_DELIM)) return DEFAULT_CONFIG;
  const end = raw.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length);
  if (end < 0) return DEFAULT_CONFIG;
  const front = raw.slice(FRONTMATTER_DELIM.length, end).trim();
  let parsed: unknown;
  try {
    parsed = yaml.load(front);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'group-frontmatter: malformed YAML — treating as brain_ingest:off',
    );
    return DEFAULT_CONFIG;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_CONFIG;
  const fm = parsed as Record<string, unknown>;

  const mode = fm.brain_ingest;
  if (mode !== 'window') return DEFAULT_CONFIG;

  const idleRaw = fm.window_idle_min;
  const capRaw = fm.window_cap;
  return {
    brain_ingest: 'window',
    window_idle_min:
      typeof idleRaw === 'number' && idleRaw > 0 ? idleRaw : undefined,
    window_cap: typeof capRaw === 'number' && capRaw > 0 ? capRaw : undefined,
  };
}

export interface ResolvedGroup {
  jid: string;
  folder: string;
}

/**
 * Translate a chat_id from a channel into the registered-group folder, if any.
 * Conventions match the spec §9 + existing channel JID logic:
 *   - Discord:        dc:<channelId>
 *   - Signal group:   sig:group:<groupId>
 *   - Signal 1:1:     sig:<number-or-uuid>
 */
export function resolveGroupForChat(
  platform: 'discord' | 'signal',
  chat_id: string,
): ResolvedGroup | null {
  const candidates: string[] =
    platform === 'discord'
      ? [`dc:${chat_id}`]
      : [`sig:group:${chat_id}`, `sig:${chat_id}`];
  for (const jid of candidates) {
    const group = getRegisteredGroup(jid);
    if (group) return { jid, folder: group.folder };
  }
  return null;
}
