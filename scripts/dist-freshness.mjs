#!/usr/bin/env node
/**
 * dist/ freshness stamp + check for the service launcher.
 *
 * `npm run build` ends with `stamp`, which writes a content hash of every
 * build input (src/** plus tsconfig.json) to dist/.src-hash. The launcher
 * (NanoClaw.app/Contents/MacOS/NanoClaw) runs `check` before exec'ing
 * dist/index.js and refuses to start a dist/ whose stamp is missing or no
 * longer matches src/.
 *
 * Why this exists (2026-09-06): a box ran a dist/ built on 2026-04-17 for five
 * months while its src/ carried the 2026-07-01 SSE reconnect-storm fix (#90).
 * `git pull` updates src/; nothing rebuilt dist/; and every launchd restart
 * (65 of them) reloaded the pre-fix build, which hammered the SuperPilot
 * backend at ~80 connection attempts/s (~40 GB/day of egress). Nothing tied
 * the artifact being executed to the sources it was built from.
 *
 * Deliberately plain ESM JavaScript with no imports outside node: it must run
 * BEFORE the build it validates, so it cannot itself live in dist/ or need
 * tsx.
 *
 * Usage:
 *   node scripts/dist-freshness.mjs stamp [--root DIR]   # last step of build
 *   node scripts/dist-freshness.mjs check [--root DIR]   # before exec
 *
 * `check` exit codes: 0 fresh; 2 dist/index.js missing; 3 no stamp (dist/ was
 * built by an older build script); 4 stale (src/ changed since the build).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STAMP_FILE = path.join('dist', '.src-hash');
/** Build inputs, relative to the repo root. Every regular file under src/. */
const INPUT_DIRS = ['src'];
const INPUT_FILES = ['tsconfig.json'];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // no such input dir: nothing to hash
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Sorted, root-relative, '/'-separated paths of every build input. */
export function listInputs(root) {
  const files = [];
  for (const d of INPUT_DIRS) walk(path.join(root, d), files);
  for (const f of INPUT_FILES) {
    const p = path.join(root, f);
    if (existsSync(p)) files.push(p);
  }
  return files
    .map((p) => path.relative(root, p).split(path.sep).join('/'))
    .sort();
}

/** sha256 over (path, size, bytes) of every build input, in sorted order. */
export function hashInputs(root) {
  const h = createHash('sha256');
  for (const rel of listInputs(root)) {
    const buf = readFileSync(path.join(root, ...rel.split('/')));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

export function stamp(root) {
  const digest = hashInputs(root);
  writeFileSync(path.join(root, STAMP_FILE), `${digest}\n`);
  return digest;
}

export function check(root) {
  if (!existsSync(path.join(root, 'dist', 'index.js'))) {
    return {
      code: 2,
      reason: 'dist/index.js is missing — run `npm run build`',
    };
  }
  const stampPath = path.join(root, STAMP_FILE);
  if (!existsSync(stampPath)) {
    return {
      code: 3,
      reason: `${STAMP_FILE} is missing — dist/ was built by an older build script; run \`npm run build\``,
    };
  }
  const recorded = readFileSync(stampPath, 'utf8').trim();
  const current = hashInputs(root);
  if (recorded !== current) {
    return {
      code: 4,
      reason:
        `dist/ is STALE: src/ changed since it was built ` +
        `(stamp ${recorded.slice(0, 12)}, src ${current.slice(0, 12)}) — run \`npm run build\``,
    };
  }
  return { code: 0, reason: 'dist/ matches src/' };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--root' && rest[i + 1]) root = path.resolve(rest[++i]);
  }
  if (cmd === 'stamp') {
    const digest = stamp(root);
    console.log(
      `[dist-freshness] stamped ${STAMP_FILE} ${digest.slice(0, 12)}`,
    );
    return 0;
  }
  if (cmd === 'check') {
    const r = check(root);
    (r.code === 0 ? console.log : console.error)(
      `[dist-freshness] ${r.reason}`,
    );
    return r.code;
  }
  console.error('usage: dist-freshness.mjs <stamp|check> [--root DIR]');
  return 64;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
