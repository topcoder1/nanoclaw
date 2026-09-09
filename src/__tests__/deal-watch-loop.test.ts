/**
 * deal-watch-loop — main-group ownership + send-failure retry.
 *
 * Two coupled defects, both dormant while DEAL_WATCH_ENABLED is unset
 * (found during the 2026-09-08 Signal channel removal):
 *
 *  1. The loop's main-group lookup returned the first `is_main=1` row with no
 *     check that a connected channel owned that JID. Multiple `is_main=1` rows
 *     legitimately coexist — one per channel — so the loop could hand a
 *     WhatsApp JID to Telegram.
 *  2. The sender injected in src/index.ts returned instead of throwing when no
 *     channel owned the JID. A *resolved* send defeats the loop's retry guard:
 *     the alert is marked processed and the digest is lost permanently rather
 *     than retried on the next poll.
 *
 * Each half carries a negative control pinning the pre-fix behaviour, so the
 * fixtures provably discriminate instead of passing either way. The final
 * block reads the real src/index.ts, because a replica-only test keeps passing
 * if the orchestrator quietly goes back to returning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mutable script fixture, read by the mocked spawn on each poll.
const script = vi.hoisted(() => ({ stdout: '', exitCode: 0, runs: 0 }));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Stand in for `npx tsx scripts/deal-watch.ts --json` — emit the fixture on
// stdout, then close. Everything else in child_process stays real.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: () => {
      script.runs++;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const { stdout, exitCode } = script;
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
      });
      return child;
    },
  };
});

import {
  _initTestDatabase,
  _closeDatabase,
  getProcessedItemsSince,
} from '../db.js';
import { pollOnce } from '../deal-watch-loop.js';
import { findMainGroupJid } from '../main-group.js';
import { findChannel } from '../router.js';
import { Channel, RegisteredGroup } from '../types.js';

const WHATSAPP_MAIN = '1234567890@g.us';
const TELEGRAM_MAIN = 'tg:-1001234567890';
const EPOCH = '1970-01-01T00:00:00.000Z';

function mainRow(name: string): RegisteredGroup {
  return {
    name,
    folder: name,
    trigger: '',
    added_at: '2026-09-08T00:00:00.000Z',
    isMain: true,
  };
}

/**
 * Both `is_main=1` rows, WhatsApp FIRST. Insertion order is what makes this
 * fixture discriminating: a "return the first is_main row" lookup picks the
 * WhatsApp JID, which no connected Telegram channel owns.
 */
function bothMains(): Record<string, RegisteredGroup> {
  return {
    [WHATSAPP_MAIN]: mainRow('main-whatsapp'),
    [TELEGRAM_MAIN]: mainRow('main-telegram'),
  };
}

function fakeChannel(
  name: string,
  ownsJid: (jid: string) => boolean,
  sendMessage: Channel['sendMessage'] = vi.fn(async () => {}),
): Channel {
  return {
    name,
    connect: async () => {},
    sendMessage,
    isConnected: () => true,
    ownsJid,
    disconnect: async () => {},
  };
}

const telegramOwns = (jid: string) => jid.startsWith('tg:');
const whatsappOwns = (jid: string) => jid.endsWith('@g.us');

// The pre-fix lookup, spelled out so the negative controls can call it.
function preFixFindMainGroupJid(
  groups: Record<string, RegisteredGroup>,
): string | null {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return null;
}

describe('findMainGroupJid', () => {
  it('skips an is_main row no connected channel owns', () => {
    const telegram = fakeChannel('telegram', telegramOwns);
    expect(findMainGroupJid(bothMains(), [telegram])).toBe(TELEGRAM_MAIN);
  });

  it('negative control: the pre-fix lookup picks the unowned WhatsApp JID', () => {
    const groups = bothMains();
    const telegram = fakeChannel('telegram', telegramOwns);
    // Proves the fixture discriminates — without the ownership filter the
    // very same input yields a JID the only connected channel cannot send to.
    expect(preFixFindMainGroupJid(groups)).toBe(WHATSAPP_MAIN);
    expect(telegram.ownsJid(preFixFindMainGroupJid(groups)!)).toBe(false);
    expect(findMainGroupJid(groups, [telegram])).not.toBe(
      preFixFindMainGroupJid(groups),
    );
  });

  it('returns null when no connected channel owns any is_main row', () => {
    const discord = fakeChannel('discord', (jid) => jid.startsWith('dc:'));
    expect(findMainGroupJid(bothMains(), [discord])).toBeNull();
    expect(findMainGroupJid(bothMains(), [])).toBeNull();
  });

  it('restricts the lookup to the channels it is given', () => {
    const groups = bothMains();
    expect(
      findMainGroupJid(groups, [fakeChannel('whatsapp', whatsappOwns)]),
    ).toBe(WHATSAPP_MAIN);
    expect(
      findMainGroupJid(groups, [fakeChannel('telegram', telegramOwns)]),
    ).toBe(TELEGRAM_MAIN);
  });

  it('ignores rows that are not main', () => {
    const telegram = fakeChannel('telegram', telegramOwns);
    const groups: Record<string, RegisteredGroup> = {
      'tg:-100999': { ...mainRow('not-main'), isMain: false },
      [TELEGRAM_MAIN]: mainRow('main-telegram'),
    };
    expect(findMainGroupJid(groups, [telegram])).toBe(TELEGRAM_MAIN);
  });
});

// --- the sender src/index.ts injects ------------------------------------

/** Post-fix shape: throw so the loop's retry guard fires. */
function injectedSender(channels: Channel[]) {
  return async (jid: string, text: string): Promise<void> => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`deal-watch: no channel owns JID ${jid}`);
    await channel.sendMessage(jid, text);
  };
}

/** NEGATIVE CONTROL — pre-fix shape: log and return, resolving the send. */
function preFixSender(channels: Channel[]) {
  return async (jid: string, text: string): Promise<void> => {
    const channel = findChannel(channels, jid);
    if (!channel) return;
    await channel.sendMessage(jid, text);
  };
}

describe('deal-watch injected sender', () => {
  it('rejects when no channel owns the JID', async () => {
    await expect(injectedSender([])(TELEGRAM_MAIN, 'digest')).rejects.toThrow(
      /no channel owns JID/,
    );
  });

  it('negative control: the pre-fix sender resolved instead', async () => {
    await expect(
      preFixSender([])(TELEGRAM_MAIN, 'digest'),
    ).resolves.toBeUndefined();
  });
});

// --- the poll cycle ------------------------------------------------------

const CHURN_ALERT = {
  kind: 'churn' as const,
  deal: {
    id: 'deal-1',
    name: 'Acme renewal',
    amount: 120000,
    companyName: 'Acme',
    companyDomain: 'acme.com',
  },
  reasons: ['renewal in 14d', 'no activity for 30d'],
};

function scriptResult() {
  return JSON.stringify({
    momentum: [],
    atRisk: [],
    churn: [CHURN_ALERT],
    candidateCounts: { newDeals: 0, churn: 1, gongCalls: 1 },
  });
}

function dealWatchRows() {
  return getProcessedItemsSince(EPOCH).filter((r) => r.source === 'deal-watch');
}

describe('pollOnce', () => {
  beforeEach(() => {
    _initTestDatabase();
    script.stdout = scriptResult();
    script.exitCode = 0;
    script.runs = 0;
  });
  afterEach(() => _closeDatabase());

  it('sends to the main group the connected channel owns', async () => {
    const send = vi.fn(async () => {});
    const telegram = fakeChannel('telegram', telegramOwns, send);
    await pollOnce({
      sendMessage: injectedSender([telegram]),
      registeredGroups: bothMains,
      channels: () => [telegram],
    });
    expect(send).toHaveBeenCalledTimes(1);
    // The WhatsApp row is first in the map; picking it would have thrown.
    expect(send.mock.calls[0][0]).toBe(TELEGRAM_MAIN);
    expect(dealWatchRows()).toHaveLength(1);
  });

  it('leaves the alert unprocessed when the send rejects, so the next poll retries', async () => {
    const failing = vi.fn(async () => {
      throw new Error('grammy 400: chat not found');
    });
    const telegram = fakeChannel('telegram', telegramOwns, failing);
    const deps = {
      sendMessage: injectedSender([telegram]),
      registeredGroups: bothMains,
      channels: () => [telegram],
    };

    await pollOnce(deps);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(dealWatchRows()).toHaveLength(0);

    // Second poll: the same alert is still fresh and is retried.
    await pollOnce(deps);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(dealWatchRows()).toHaveLength(0);
  });

  it('negative control: a send that resolves without delivering marks the alert processed and loses it', async () => {
    // Exactly what the pre-fix src/index.ts sender did: nothing is delivered,
    // but the promise resolves, so the retry guard never fires.
    const swallowing = vi.fn(async () => {});
    const deps = {
      sendMessage: swallowing,
      registeredGroups: bothMains,
      channels: () => [fakeChannel('telegram', telegramOwns)],
    };

    await pollOnce(deps);
    expect(dealWatchRows()).toHaveLength(1);

    await pollOnce(deps);
    // Never retried — the digest is gone for good.
    expect(swallowing).toHaveBeenCalledTimes(1);
  });

  it('marks processed after a successful send and dedupes on the next poll', async () => {
    const send = vi.fn(async () => {});
    const telegram = fakeChannel('telegram', telegramOwns, send);
    const deps = {
      sendMessage: injectedSender([telegram]),
      registeredGroups: bothMains,
      channels: () => [telegram],
    };

    await pollOnce(deps);
    await pollOnce(deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dealWatchRows()).toHaveLength(1);
    expect(script.runs).toBe(2);
  });

  it('skips the send when no connected channel owns a main group', async () => {
    const send = vi.fn(async () => {});
    const discord = fakeChannel(
      'discord',
      (jid) => jid.startsWith('dc:'),
      send,
    );
    await pollOnce({
      sendMessage: injectedSender([discord]),
      registeredGroups: bothMains,
      channels: () => [discord],
    });
    expect(send).not.toHaveBeenCalled();
    // Nothing was delivered, so nothing may be marked processed.
    expect(dealWatchRows()).toHaveLength(0);
  });
});

// --- wiring guard --------------------------------------------------------

describe('src/index.ts deal-watch wiring', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const INDEX = path.resolve(HERE, '..', 'index.ts');

  function startDealWatchLoopCall(): string {
    const src = readFileSync(INDEX, 'utf8');
    const start = src.indexOf('startDealWatchLoop({');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n  });', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('throws rather than returns when no channel owns the JID', () => {
    const call = startDealWatchLoopCall();
    expect(call).toMatch(/if \(!channel\)[\s\S]{0,120}?throw new Error/);
    // The pre-fix shape — a bare `return;` in the no-channel branch — silently
    // marks every alert processed. It must not come back.
    expect(call).not.toMatch(/if \(!channel\) \{[\s\S]{0,200}?\breturn;/);
  });

  it('passes the channel list through so the loop can check ownership', () => {
    expect(startDealWatchLoopCall()).toMatch(/channels: \(\) => channels/);
  });
});
