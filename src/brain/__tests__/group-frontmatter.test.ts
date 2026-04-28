import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpGroupsDir: string;
let tmpDataDir: string;
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return tmpGroupsDir;
  },
  get STORE_DIR() {
    return tmpDataDir;
  },
  QDRANT_URL: '',
}));

import {
  _initTestDatabase,
  _closeDatabase,
  setRegisteredGroup,
} from '../../db.js';
import {
  readChatIngestConfig,
  resolveGroupForChat,
  _resetGroupFrontmatterCache,
} from '../group-frontmatter.js';

function writeGroupClaudeMd(folder: string, body: string): void {
  const dir = path.join(tmpGroupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body, 'utf8');
}

beforeEach(() => {
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-groups-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
  _initTestDatabase();
  _resetGroupFrontmatterCache();
});

afterEach(() => {
  _closeDatabase();
  fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('group-frontmatter', () => {
  it('returns brain_ingest:off when no CLAUDE.md exists', () => {
    fs.mkdirSync(path.join(tmpGroupsDir, 'orphan'), { recursive: true });
    expect(readChatIngestConfig('orphan')).toEqual({
      brain_ingest: 'off',
      window_idle_min: undefined,
      window_cap: undefined,
    });
  });

  it('returns brain_ingest:off when CLAUDE.md has no frontmatter', () => {
    writeGroupClaudeMd('plain', '# just markdown\n\nnothing here.\n');
    expect(readChatIngestConfig('plain').brain_ingest).toBe('off');
  });

  it('parses brain_ingest:window with overrides', () => {
    writeGroupClaudeMd(
      'opted-in',
      '---\nbrain_ingest: window\nwindow_idle_min: 5\nwindow_cap: 20\n---\n\nbody\n',
    );
    expect(readChatIngestConfig('opted-in')).toEqual({
      brain_ingest: 'window',
      window_idle_min: 5,
      window_cap: 20,
    });
  });

  it('treats invalid brain_ingest values as off', () => {
    writeGroupClaudeMd('bogus', '---\nbrain_ingest: not-a-mode\n---\nbody\n');
    expect(readChatIngestConfig('bogus').brain_ingest).toBe('off');
  });

  it('treats malformed YAML as off (no throw)', () => {
    writeGroupClaudeMd(
      'broken',
      '---\nbrain_ingest: window\n  bad: indent\n---\n',
    );
    expect(readChatIngestConfig('broken').brain_ingest).toBe('off');
  });

  it('resolves a Discord chat_id to its registered group folder', () => {
    setRegisteredGroup('dc:111222', {
      name: 'g1',
      folder: 'discord-group',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('discord', '111222');
    expect(got).not.toBeNull();
    expect(got!.folder).toBe('discord-group');
    expect(got!.jid).toBe('dc:111222');
  });

  it('resolves a Signal group chat_id via sig:group: prefix', () => {
    setRegisteredGroup('sig:group:abc', {
      name: 'sigroup',
      folder: 'signal-group',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('signal', 'abc');
    expect(got!.folder).toBe('signal-group');
    expect(got!.jid).toBe('sig:group:abc');
  });

  it('falls back to sig:<number> for Signal 1:1 chats', () => {
    setRegisteredGroup('sig:+15551234567', {
      name: 'sig11',
      folder: 'signal-dm',
      trigger: '@nano',
      added_at: new Date().toISOString(),
    });
    const got = resolveGroupForChat('signal', '+15551234567');
    expect(got!.folder).toBe('signal-dm');
    expect(got!.jid).toBe('sig:+15551234567');
  });

  it('returns null when no registered group matches', () => {
    expect(resolveGroupForChat('discord', 'nope')).toBeNull();
    expect(resolveGroupForChat('signal', 'nope')).toBeNull();
  });
});
