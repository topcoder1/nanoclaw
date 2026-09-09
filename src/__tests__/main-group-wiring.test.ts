/**
 * src/index.ts main-group wiring.
 *
 * Every "send this to / run this on the main group" path must resolve the
 * group through the ownership-checked `findMainGroupJid` helper
 * (src/main-group.ts), never by taking the first `is_main=1` row. Multiple
 * such rows legitimately coexist — one per channel — and an unordered scan of
 * registered_groups returns whichever was added first, which on a real box
 * was a WhatsApp row while Telegram was the connected primary.
 *
 * History: #104 fixed deal-watch, #105 fixed the daily digest, and this file
 * pins the remaining sites: status bar + failure escalator, draft-with-ai,
 * the signer chat id, webhook routing, the Gmail auth-expired alert, and the
 * resolver handed to channels. Two of those (status bar, signer) were also
 * captured ONCE at startup rather than per call.
 *
 * These read the real src/index.ts: main() cannot be imported without side
 * effects, and a replica-only test keeps passing while the orchestrator
 * quietly regresses (see tests/regression/test_dist-freshness-guard.test.ts).
 */

import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'index.ts',
);
const src = readFileSync(INDEX, 'utf8');

/** The pre-fix shape: scan registeredGroups for a row flagged isMain. */
const NAIVE_LOOKUP =
  /Object\.(entries|keys)\(registeredGroups\)\s*\.find\([\s\S]{0,80}?isMain/;

const HELPER = /findMainGroupJid\(registeredGroups, channels\)/;

/** Slice src from `anchor` to the first `end` after it. */
function block(anchor: string, end: string): string {
  const start = src.indexOf(anchor);
  expect(start, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, start + anchor.length);
  expect(stop, `end not found after anchor: ${end}`).toBeGreaterThan(start);
  return src.slice(start, stop);
}

describe('src/index.ts main-group wiring', () => {
  it('has no "first is_main row" lookup left anywhere in the file', () => {
    // `group.isMain` privilege checks are not lookups and do not match this;
    // only scanning registeredGroups for a main row does.
    expect(src).not.toMatch(NAIVE_LOOKUP);
  });

  it('every main-group notification path resolves at call time', () => {
    // `mainGroupEntry` was the once-at-startup capture shared by seven
    // consumers. Its removal is file-wide, not just in the status-bar block —
    // that block-scoped check alone let four later listeners slip through.
    expect(src).not.toMatch(/mainGroupEntry/);
    // Exact on purpose: status bar sendProgress + sendMessage, failure
    // escalator, MessageBatcher onFlush, email.snooze.waked,
    // email.draft.enriched, email.draft.send_failed. Adding a consumer means
    // bumping this deliberately, not silently.
    expect(src.match(/resolveMainGroupJid\(\)/g)?.length).toBe(7);
  });

  it('status bar + failure escalator resolve per call through the helper', () => {
    const b = block(
      '// Main-group notifications (status bar',
      '// Message batcher',
    );
    expect(b).toMatch(HELPER);
    expect(b).not.toMatch(NAIVE_LOOKUP);
    // The three consumers in this block resolve at call time.
    expect(b.match(/resolveMainGroupJid\(\)/g)?.length).toBe(3);
  });

  it('draft-with-ai spawns on a main group a connected channel owns', () => {
    const b = block(
      '// Spawn a container agent that calls gmail.users.drafts.create',
      "'Draft-with-AI agent task spawned'",
    );
    expect(b).toMatch(HELPER);
    expect(b).not.toMatch(NAIVE_LOOKUP);
    expect(b).toMatch(/const mainGroup = registeredGroups\[mainJid\]/);
  });

  it('signer chat id is the main group the telegram channel owns', () => {
    const b = block(
      "const mainGroupRoot = path.join(GROUPS_DIR, 'main');",
      'startSigner({',
    );
    // It delivers via sendTelegramMessage, so a generic "any channel" pick is
    // not enough — it must be restricted to the telegram channel.
    expect(b).toMatch(/startsWith\('telegram'\)/);
    expect(b).toMatch(
      /findMainGroupJid\(registeredGroups, \[signerTelegram\]\)/,
    );
    expect(b).not.toMatch(NAIVE_LOOKUP);
    // The env fallback survives for boxes with no registered telegram main.
    expect(b).toMatch(/process\.env\.MAIN_GROUP_CHAT_ID/);
  });

  it('webhook events route to a main group a connected channel owns', () => {
    const b = block(
      "eventBus.on('webhook.received'",
      '// Browser sidecar health monitoring',
    );
    expect(b).toMatch(HELPER);
    expect(b).not.toMatch(NAIVE_LOOKUP);
    expect(b).toMatch(/const mainGroup = registeredGroups\[mainJid\]/);
  });

  it('the Gmail auth-expired alert targets an owned main group', () => {
    const b = block('startGmailRefreshLoop({', 'startSessionCleanup();');
    expect(b).toMatch(HELPER);
    expect(b).not.toMatch(NAIVE_LOOKUP);
  });

  it('channels are handed the ownership-checked resolver', () => {
    const b = block(
      'const channelOpts',
      '// Create and connect all registered channels.',
    );
    expect(b).toMatch(
      /mainGroupJid: \(\) => findMainGroupJid\(registeredGroups, channels\)/,
    );
  });
});
