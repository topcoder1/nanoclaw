// src/memory/shared/paths.ts
import path from 'path';
import fs from 'fs';

/**
 * Resolve the host-side root of the shared memory store.
 * Defaults to `<projectRoot>/groups/global/memory`. Override with
 * NANOCLAW_MEMORY_DIR for tests.
 */
export function memoryRoot(): string {
  if (process.env.NANOCLAW_MEMORY_DIR) {
    return process.env.NANOCLAW_MEMORY_DIR;
  }
  return path.join(process.cwd(), 'groups', 'global', 'memory');
}

export function candidateDir(): string {
  return path.join(memoryRoot(), 'candidate');
}

export function rejectedDir(): string {
  return path.join(candidateDir(), 'rejected');
}

export function archivedDir(): string {
  return path.join(memoryRoot(), '.archived');
}

export function auditLogPath(): string {
  return path.join(memoryRoot(), '.audit.log');
}

export function indexPath(): string {
  return path.join(memoryRoot(), 'MEMORY.md');
}

export function factPath(slug: string): string {
  return path.join(memoryRoot(), `${slug}.md`);
}

/** Create all directories used by the store (idempotent). */
export function ensureMemoryDirs(): void {
  for (const dir of [memoryRoot(), candidateDir(), rejectedDir(), archivedDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
