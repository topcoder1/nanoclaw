/**
 * src/ipc.ts main-group wiring.
 *
 * The email_trigger IPC handler picks the chat the email-intelligence agent
 * runs on: a registered Telegram group first (so replies reach the same
 * container session), else "the main group". That fallback must go through
 * the ownership-checked `findMainGroupJid` helper (src/main-group.ts), never
 * a scan for the first `is_main=1` row: several such rows coexist, one per
 * channel, and an unowned one (a WhatsApp JID on a Telegram-only box) hands
 * runAgent and sendMessage a chat nothing can deliver to.
 *
 * Counterpart of main-group-wiring.test.ts, which pins src/index.ts (#106).
 * The handler itself is exercised for real in email-trigger-pipeline.test.ts;
 * this file guards the source so the naive scan cannot be reintroduced, and
 * pins the index.ts wiring that hands ipc.ts the connected channels — main()
 * cannot be imported without side effects, so that link is checked by text.
 */

import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ipcSrc = readFileSync(path.join(SRC_DIR, 'ipc.ts'), 'utf8');
const indexSrc = readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');

/**
 * The pre-fix shape: scan registeredGroups for a row flagged isMain, in its
 * common spellings — Object.entries / keys / values over `registeredGroups`
 * or `deps.registeredGroups()`, find or filter, any whitespace inside the
 * parens. A tripwire, not a proof: a text check exists to stop the deleted
 * lines coming back by copy-paste, and a for-of or reduce rewrite would slip
 * past it. The handler's behaviour itself is pinned by
 * email-trigger-pipeline.test.ts, whatever syntax a regression uses.
 */
const NAIVE_LOOKUP =
  /Object\.(entries|keys|values)\(\s*(deps\.)?registeredGroups(\(\))?\s*\)\s*\.(find|filter)\(\s*[\s\S]{0,80}?isMain/;

/** Slice `src` from `anchor` to the first `end` after it. */
function block(src: string, anchor: string, end: string): string {
  const start = src.indexOf(anchor);
  expect(start, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, start + anchor.length);
  expect(stop, `end not found after anchor: ${end}`).toBeGreaterThan(start);
  return src.slice(start, stop);
}

describe('src/ipc.ts main-group wiring', () => {
  it('has no registeredGroups find/filter scan for an is_main row anywhere in the file', () => {
    // `isMain` privilege checks on the source group are not lookups and do
    // not match this; nor does the for-of that builds the folder → isMain
    // privilege map (a map build, not a JID pick). Only find/filter-ing
    // registeredGroups for a main row does.
    expect(ipcSrc).not.toMatch(NAIVE_LOOKUP);
  });

  it('email_trigger falls back to a main group a connected channel owns', () => {
    const b = block(ipcSrc, "case 'email_trigger':", "case 'relay_message':");
    expect(b).toMatch(
      /findMainGroupJid\(registeredGroups, deps\.channels\(\)\)/,
    );
    expect(b).not.toMatch(NAIVE_LOOKUP);
    // Telegram-first is deliberate (replies must reach the same session);
    // only the fallback changed.
    expect(b).toMatch(/jid\.startsWith\('tg:'\)/);
  });

  it('index.ts hands the IPC watcher the connected channels', () => {
    // A getter, like `registeredGroups`: `channels` is read at call time,
    // not captured when the deps object is built at startup. The block runs
    // to the call's own close (the first two-space `});`), so reordering
    // keys inside the deps object cannot truncate it.
    const b = block(indexSrc, 'startIpcWatcher({', '\n  });');
    expect(b).toMatch(/channels: \(\) => channels,/);
  });
});
