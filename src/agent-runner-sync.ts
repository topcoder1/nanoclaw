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
 * so nothing an agent does to its own /app/src keeps a stale runner in
 * place: its edits last until the source next changes. (Comparing file
 * times let an agent's edit, being newer, pin the old runner.)
 *
 * A re-copy mirrors the source: files it no longer has are removed, since
 * the entrypoint compiles every file in /app/src. The copy is emptied in
 * place rather than deleted, so a running container's mount of it stays
 * valid.
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
  // Record no source until the new copy is complete, so a copy that fails
  // partway is re-made rather than taken for current.
  fs.rmSync(stampFile, { force: true });
  if (fs.existsSync(destDir)) {
    for (const entry of fs.readdirSync(destDir)) {
      fs.rmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
  fs.cpSync(srcDir, destDir, { recursive: true });
  fs.writeFileSync(stampFile, srcHash);
  return true;
}
