import express from 'express';
import type Database from 'better-sqlite3';
import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';
import { muteThread, unmuteThread } from '../triage/mute-filter.js';

export interface ActionDeps {
  db: Database.Database;
  gmailOps?: GmailOps;
}

export function createActionsRouter(deps: ActionDeps): express.Router {
  const router = express.Router();

  function lookupItem(id: string):
    | { id: string; thread_id: string | null; account: string | null }
    | null {
    const row = deps.db
      .prepare(
        'SELECT id, thread_id, metadata FROM tracked_items WHERE id = ?',
      )
      .get(id) as
      | { id: string; thread_id: string | null; metadata: string | null }
      | undefined;
    if (!row) return null;
    let account: string | null = null;
    if (row.metadata) {
      try {
        account = (JSON.parse(row.metadata) as { account?: string }).account ?? null;
      } catch {
        logger.debug(
          { id, component: 'mini-app-actions' },
          'metadata JSON.parse failed',
        );
      }
    }
    return { id: row.id, thread_id: row.thread_id, account };
  }

  router.post('/api/email/:id/mute', async (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id || !item.account) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found or missing thread/account',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    muteThread(deps.db, {
      threadId: item.thread_id,
      account: item.account,
    });
    if (deps.gmailOps) {
      try {
        await deps.gmailOps.archiveThread(item.account, item.thread_id);
      } catch (err) {
        logger.error(
          { err, id: req.params.id, component: 'mini-app-actions' },
          'Mute archive failed',
        );
      }
    }
    res.json({ ok: true });
  });

  router.delete('/api/email/:id/mute', (req, res) => {
    const item = lookupItem(req.params.id);
    if (!item || !item.thread_id) {
      res.status(404).json({
        ok: false,
        error: 'Tracked item not found',
        code: 'ITEM_NOT_FOUND',
      });
      return;
    }
    unmuteThread(deps.db, item.thread_id);
    res.json({ ok: true });
  });

  return router;
}
