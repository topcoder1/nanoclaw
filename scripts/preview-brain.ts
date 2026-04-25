/**
 * Preview harness — mounts the mini-app against the production brain.db
 * with Telegram auth disabled so /brain/* routes are reachable from a
 * browser without going through the Mini App. Used for local UI
 * verification of brain UI changes (e.g. the entities Projects tab).
 *
 * STORE_DIR is resolved against `process.cwd()` at module load time
 * ([src/config.ts:35](src/config.ts:35)). This script must read the main
 * repo's `store/brain.db` even when invoked from a worktree, so we chdir
 * BEFORE any import that pulls in config.js — that means dynamic imports
 * after the chdir.
 */

async function main(): Promise<void> {
  process.env.TELEGRAM_INITDATA_REQUIRED = 'false';
  process.chdir('/Users/topcoder1/dev/nanoclaw');

  const { _initTestDatabase, getDb } = await import('../src/db.js');
  const { getBrainDb } = await import('../src/brain/db.js');
  const { createMiniAppServer } = await import('../src/mini-app/server.js');

  // Mini-app needs a nanoclaw DB even though we only care about /brain;
  // in-memory is fine — we won't be hitting tracked_items routes.
  _initTestDatabase();

  const stubGmailOps = {
    getMessageBody: async () => '',
    getMessageMeta: async () => ({
      subject: '',
      from: '',
      to: '',
      date: '',
      body: '',
    }),
    getThreadInboxStatus: async () => 'in' as const,
  };

  const brainDb = getBrainDb();
  const port = Number(process.env.PORT) || 3849;
  const app = createMiniAppServer({
    port,
    db: getDb(),
    gmailOps: stubGmailOps as unknown as Parameters<
      typeof createMiniAppServer
    >[0]['gmailOps'],
    brainDb,
  });

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[preview-brain] http://localhost:${port}/brain/entities?type=project`,
    );
  });
}

main().catch((err) => {
  console.error('preview-brain failed:', err);
  process.exit(1);
});
