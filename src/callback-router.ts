import type { CallbackQuery, Channel, Action } from './types.js';
import type { ArchiveTracker } from './archive-tracker.js';
import type { AutoApprovalTimer } from './auto-approval.js';
import type { StatusBarManager } from './status-bar.js';
import type { GmailOps } from './gmail-ops.js';
import type { DraftEnrichmentWatcher } from './draft-enrichment.js';
import { MINI_APP_URL } from './config.js';
import {
  truncatePreview,
  getCachedEmailBody,
  cacheEmailBody,
} from './email-preview.js';
import { logger } from './logger.js';

export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  gmailOps?: GmailOps;
  calendarOps?: {
    rsvp(account: string, eventId: string, response: string): Promise<void>;
  };
  draftWatcher?: DraftEnrichmentWatcher;
  findChannel: (jid: string) => (Channel & Record<string, any>) | undefined;
}

/**
 * Route callback queries from inline buttons to the appropriate handler.
 * Callback data format: "action:entityId" or "action:entityId:extra"
 */
export async function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): Promise<void> {
  const parts = query.data.split(':');
  const action = parts[0];
  const entityId = parts[1] || '';
  const extra = parts[2] || '';
  const extra2 = parts[3] || '';

  logger.debug(
    { action, entityId, extra, chatJid: query.chatJid },
    'Callback query received',
  );

  const channel = deps.findChannel(query.chatJid);

  try {
    switch (action) {
      case 'archive': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '✅ Confirm Archive',
              callbackData: `confirm_archive:${entityId}`,
              style: 'destructive-safe',
            },
            {
              label: '❌ Cancel',
              callbackData: `cancel_archive:${entityId}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'confirm_archive': {
        const unarchived = deps.archiveTracker.getUnarchived();
        const email = unarchived.find((e) => e.email_id === entityId);
        if (email && deps.gmailOps) {
          try {
            await deps.gmailOps.archiveThread(email.account, email.thread_id);
            deps.archiveTracker.markArchived(entityId, email.action_taken);
            if (channel?.editMessageTextAndButtons) {
              await channel.editMessageTextAndButtons(
                query.chatJid,
                query.messageId,
                '✅ Archived',
                [],
              );
            }
          } catch (archiveErr) {
            logger.warn(
              { err: String(archiveErr), entityId, account: email.account },
              'Archive failed, showing retry',
            );
            if (channel?.editMessageTextAndButtons) {
              await channel.editMessageTextAndButtons(
                query.chatJid,
                query.messageId,
                "⚠️ Couldn't archive. Try again later.",
                [
                  {
                    label: '🔄 Retry',
                    callbackData: `retry_archive:${entityId}`,
                    style: 'primary',
                  },
                  {
                    label: '❌ Dismiss',
                    callbackData: `dismiss:${entityId}`,
                    style: 'secondary',
                  },
                ],
              );
            }
          }
        }
        break;
      }

      case 'cancel_archive': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '🗄 Archive',
              callbackData: `archive:${entityId}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'retry_archive': {
        const unarchived = deps.archiveTracker.getUnarchived();
        const email = unarchived.find((e) => e.email_id === entityId);
        if (email && deps.gmailOps) {
          await deps.gmailOps.archiveThread(email.account, email.thread_id);
          deps.archiveTracker.markArchived(entityId, email.action_taken);
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              '✅ Archived',
              [],
            );
          }
        }
        break;
      }

      case 'expand': {
        const account = extra;
        let body = getCachedEmailBody(entityId);
        if (!body && deps.gmailOps && account) {
          body = await deps.gmailOps.getMessageBody(account, entityId);
          if (body) cacheEmailBody(entityId, body);
        }
        if (body && channel?.editMessageTextAndButtons) {
          const preview = truncatePreview(body, 800);
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            preview,
            [
              {
                label: '📧 Collapse',
                callbackData: `collapse:${entityId}:${account}`,
                style: 'secondary',
              },
              {
                label: '🌐 Full Email',
                callbackData: `noop:${entityId}`,
                webAppUrl: MINI_APP_URL
                  ? `${MINI_APP_URL}/email/${entityId}?account=${account}`
                  : undefined,
                style: 'secondary',
              },
              {
                label: '🗄 Archive',
                callbackData: `archive:${entityId}`,
                style: 'secondary',
              },
            ],
          );
        }
        break;
      }

      case 'collapse': {
        const account = extra;
        const body = getCachedEmailBody(entityId);
        if (body && channel?.editMessageTextAndButtons) {
          const summary = truncatePreview(body, 300);
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            summary,
            [
              {
                label: '📧 Expand',
                callbackData: account
                  ? `expand:${entityId}:${account}`
                  : `expand:${entityId}`,
                style: 'secondary',
              },
              {
                label: '🌐 Full Email',
                callbackData: `noop:${entityId}`,
                webAppUrl: MINI_APP_URL
                  ? `${MINI_APP_URL}/email/${entityId}${account ? '?account=' + account : ''}`
                  : undefined,
                style: 'secondary',
              },
              {
                label: '🗄 Archive',
                callbackData: `archive:${entityId}`,
                style: 'secondary',
              },
            ],
          );
        }
        break;
      }

      case 'revert': {
        if (deps.draftWatcher) {
          const reverted = await deps.draftWatcher.revert(entityId);
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              reverted
                ? '↩ Reverted to original'
                : '⚠️ Could not revert — original not found',
              [],
            );
          }
        }
        break;
      }

      case 'keep': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, []);
        }
        break;
      }

      case 'answer': {
        const questionId = entityId;
        const answer = extra;
        if (answer === 'defer') {
          logger.info({ questionId }, 'Answer deferred');
        } else {
          deps.statusBar.removePendingItem(questionId);
        }
        break;
      }

      case 'stop':
        deps.autoApproval.cancel(entityId);
        break;

      case 'dismiss':
        deps.statusBar.removePendingItem(entityId);
        break;

      case 'forward': {
        // entityId = threadId, extra = recipient, extra2 = account
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: `✅ Confirm Forward to ${extra.length > 20 ? extra.slice(0, 17) + '...' : extra}`,
              callbackData: `confirm_forward:${entityId}:${extra}:${extra2}`,
              style: 'primary',
            },
            {
              label: '❌ Cancel',
              callbackData: `cancel_forward:${entityId}:${extra}:${extra2}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'confirm_forward': {
        // entityId = threadId, extra = recipient, extra2 = account
        if (deps.gmailOps && 'forwardThread' in deps.gmailOps) {
          await (deps.gmailOps as any).forwardThread(
            extra2 || 'personal',
            entityId,
            extra,
          );
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              `✅ Forwarded to ${extra}`,
              [],
            );
          }
        }
        break;
      }

      case 'cancel_forward': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: `📨 Forward to ${extra.length > 20 ? extra.slice(0, 17) + '...' : extra}`,
              callbackData: `forward:${entityId}:${extra}:${extra2}`,
              style: 'primary',
            },
          ]);
        }
        break;
      }

      case 'open_url': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '✅ Confirm Open',
              callbackData: `confirm_open_url:${entityId}`,
              style: 'primary',
            },
            {
              label: '❌ Cancel',
              callbackData: `cancel_open_url:${entityId}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'confirm_open_url': {
        if (channel?.editMessageTextAndButtons) {
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            '✅ Opening link via browser...',
            [],
          );
        }
        logger.info(
          { actionId: entityId },
          'Open URL confirmed — delegating to browser sidecar',
        );
        break;
      }

      case 'cancel_open_url': {
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '🔗 Open Link',
              callbackData: `open_url:${entityId}`,
              style: 'primary',
            },
          ]);
        }
        break;
      }

      case 'rsvp': {
        // entityId = eventId or actionId, extra = 'accepted' | 'declined'
        const response = extra as 'accepted' | 'declined';
        if (deps.calendarOps) {
          try {
            await deps.calendarOps.rsvp('personal', entityId, response);
            const label =
              response === 'accepted' ? "✅ RSVP'd — attending" : '❌ Declined';
            if (channel?.editMessageTextAndButtons) {
              await channel.editMessageTextAndButtons(
                query.chatJid,
                query.messageId,
                label,
                [],
              );
            }
          } catch (err) {
            logger.warn(
              { err: String(err), entityId, response },
              'RSVP failed',
            );
            if (channel?.editMessageTextAndButtons) {
              await channel.editMessageTextAndButtons(
                query.chatJid,
                query.messageId,
                `⚠️ RSVP failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                [],
              );
            }
          }
        } else {
          logger.warn('RSVP requested but no calendarOps available');
        }
        break;
      }

      default:
        logger.warn({ action, data: query.data }, 'Unknown callback action');
    }
  } catch (err) {
    logger.error({ err, action, entityId }, 'Callback handler failed');
    if (channel?.editMessageTextAndButtons) {
      await channel
        .editMessageTextAndButtons(
          query.chatJid,
          query.messageId,
          `⚠️ ${action} failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          [],
        )
        .catch(() => {});
    }
  }
}
