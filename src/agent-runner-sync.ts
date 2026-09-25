import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Hash of every file under dir: each relative path with its content's hash. */
function hashTree(dir: string): string {
  const tree = crypto.createHash('sha256');
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .sort();
  for (const rel of files) {
    const content = fs.readFileSync(path.join(dir, rel));
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    tree.update(`${rel}\0${digest}\n`);
  }
  return tree.digest('hex');
}

/**
 * Copy the agent-runner source over a group's writable copy of it whenever
 * the source differs from what that copy was made from, so a change to any
 * runner file deploys, not only a change to index.ts. A copy with no index.ts
 * is re-made too.
 *
 * The source hash is recorded beside the copy, outside the container mount,
 * so an agent editing its own /app/src can neither force nor block a
 * re-copy: its edits last until the source next changes. Comparing file
 * times instead let an agent's edit, being newer, pin a stale runner.
 *
 * Returns true when it copied.
 */
export function syncAgentRunnerSrc(srcDir: string, destDir: string): boolean {
  const stampFile = `${destDir}.sha256`;
  const srcHash = hashTree(srcDir);
  const current =
    fs.existsSync(path.join(destDir, 'index.ts')) &&
    fs.existsSync(stampFile) &&
    fs.readFileSync(stampFile, 'utf8') === srcHash;
  if (current) return false;
  fs.cpSync(srcDir, destDir, { recursive: true });
  fs.writeFileSync(stampFile, srcHash);
  return true;
}
