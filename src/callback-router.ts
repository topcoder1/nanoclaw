import type {
  CallbackQuery,
  CallbackResult,
  Channel,
  Action,
} from './types.js';
import type { ArchiveTracker } from './archive-tracker.js';
import type { AutoApprovalTimer } from './auto-approval.js';
import type { StatusBarManager } from './status-bar.js';
import type { GmailOps } from './gmail-ops.js';
import type { DraftEnrichmentWatcher } from './draft-enrichment.js';
import type { EventBus } from './event-bus.js';
import { getDraftIdForThread } from './draft-enrichment.js';
import type Database from 'better-sqlite3';
import { MINI_APP_URL } from './config.js';

export interface FullEmailUrlInput {
  emailId: string;
  account: string;
  draftIdForThread: string | null;
}

export function resolveFullEmailUrl(input: FullEmailUrlInput): string {
  const base = (MINI_APP_URL || '').replace(/\/$/, '');
  if (input.draftIdForThread) {
    return `${base}/reply/${encodeURIComponent(input.draftIdForThread)}?account=${encodeURIComponent(input.account)}`;
  }
  return `${base}/email/${encodeURIComponent(input.emailId)}?account=${encodeURIComponent(input.account)}`;
}
import {
  plaintextPreview,
  getCachedEmailBody,
  cacheEmailBody,
  cacheEmailMeta,
} from './email-preview.js';
import { resolveSingleContactEmail } from './contacts-lookup.js';
import { logger } from './logger.js';
import {
  handleArchive as handleTriageArchive,
  handleDismiss as handleTriageDismiss,
  handleSnooze as handleTriageSnooze,
  handleOverride as handleTriageOverride,
} from './triage/queue-actions.js';
import { handleQaCallback } from './qa-approval.js';

export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  gmailOps?: GmailOps;
  calendarOps?: {
    rsvp(account: string, eventId: string, response: string): Promise<void>;
  };
  draftWatcher?: DraftEnrichmentWatcher;
  db?: Database.Database;
  findChannel: (jid: string) => (Channel & Record<string, any>) | undefined;
  /**
   * Inject a synthesized user reply back into the agent session that asked
   * the question. Used for Yes/No answers so the originating agent learns
   * the decision and can proceed. Returns true if delivered to an active
   * container; false falls back to enqueuing a new container run.
   */
  injectUserReply?: (jid: string, text: string) => boolean;
  bus?: EventBus;
}

/**
 * Refresh the pinned archive-queue dashboard. Imported lazily to avoid a
 * static cycle between callback-router and daily-digest. Errors are swallowed
 * — a stale dashboard is preferable to throwing inside a button handler.
 */
async function refreshArchiveDashboard(): Promise<void> {
  try {
    const { postArchiveDashboard } = await import('./daily-digest.js');
    await postArchiveDashboard();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'refreshArchiveDashboard failed (non-fatal)',
    );
  }
}

/**
 * Route callback queries from inline buttons to the appropriate handler.
 * Callback data format: "action:entityId" or "action:entityId:extra"
 *
 * Optionally returns a toast string for the channel to surface as transient
 * UI feedback (Telegram: answerCallbackQuery text). Returning `undefined`
 * yields a silent ack.
 */
export async function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): Promise<CallbackResult | void> {
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
      case 'sign': {
        const subAction = entityId;
        const ceremonyId = extra;
        const reason = extra2 || 'user_dismissed';
        if (subAction === 'approve') {
          deps.bus?.emit('sign.approved', {
            type: 'sign.approved',
            source: 'callback-router',
            timestamp: Date.now(),
            payload: { ceremonyId, userId: query.senderName },
          });
        } else if (subAction === 'cancel') {
          deps.bus?.emit('sign.cancelled', {
            type: 'sign.cancelled',
            source: 'callback-router',
            timestamp: Date.now(),
            payload: { ceremonyId, reason },
          });
        } else {
          logger.warn(
            { subAction, data: query.data },
            'Unknown sign sub-action',
          );
        }
        break;
      }

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
        if (!email) {
          // No `acted_emails` row for this id. Most common cause: the card's
          // emailId didn't match the thread_id recorded at post time, or the
          // email was already archived in a prior action. Either way, fall
          // back to looking up the tracker record so the click isn't silent.
          const tracked = deps.archiveTracker.getByEmailId?.(entityId) ?? null;
          logger.warn(
            {
              entityId,
              alreadyArchived: Boolean(tracked?.archived_at),
            },
            'confirm_archive: no unarchived entry for this id',
          );
          if (channel?.editMessageTextAndButtons) {
            const label = tracked?.archived_at
              ? '✅ Already archived.'
              : "⚠️ Couldn't find this email to archive. It may have been cleared already.";
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              label,
              [],
            );
          }
          break;
        }
        if (!deps.gmailOps) {
          logger.warn(
            { entityId },
            'confirm_archive: gmailOps unavailable, cannot archive',
          );
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              '⚠️ Gmail not connected — cannot archive right now.',
              [],
            );
          }
          break;
        }
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
          // Per-email archive can shrink the archive queue; keep the
          // pinned dashboard count honest. Fire-and-forget — a stale
          // count is preferable to a thrown handler.
          void refreshArchiveDashboard();
          return { toast: '🗃 Archived' };
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
                  // Route through the unified retry: dispatcher so all
                  // retry flows share one code path. Legacy retry_archive
                  // case below remains as a back-compat alias.
                  callbackData: `retry:confirm_archive:${entityId}`,
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
        // Legacy back-compat alias — re-dispatch through the unified retry.
        // New callback data uses retry:confirm_archive:<id>.
        await handleCallback(
          { ...query, data: `retry:confirm_archive:${entityId}` },
          deps,
        );
        break;
      }

      case 'expand': {
        const account = extra;
        let body = getCachedEmailBody(entityId);
        if (!body && deps.gmailOps && account) {
          if ('getMessageMeta' in deps.gmailOps) {
            const meta = await (deps.gmailOps as any).getMessageMeta(
              account,
              entityId,
            );
            if (meta) {
              cacheEmailMeta(entityId, meta);
              body = meta.body;
            }
          }
          if (!body) {
            body = await deps.gmailOps.getMessageBody(account, entityId);
            if (body) cacheEmailBody(entityId, body);
          }
        }
        if (!body) {
          // Body couldn't be fetched — don't leave the button looking
          // unresponsive. Surface a retry so transient Gmail issues
          // (token expiry, network blip, empty payload) aren't a dead end.
          logger.warn(
            { entityId, account, hasGmailOps: Boolean(deps.gmailOps) },
            'expand: no body available',
          );
          if (channel?.editMessageTextAndButtons) {
            const reason = !deps.gmailOps
              ? '⚠️ Gmail not connected — cannot expand.'
              : !account
                ? '⚠️ Missing account on this card — cannot expand.'
                : "⚠️ Couldn't load this email. Try again.";
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              reason,
              deps.gmailOps && account
                ? [
                    {
                      label: '🔄 Retry',
                      callbackData: `retry:expand:${entityId}:${account}`,
                      style: 'primary',
                    },
                    {
                      label: '❌ Dismiss',
                      callbackData: `dismiss_failure:${entityId}`,
                      style: 'secondary',
                    },
                  ]
                : [],
            );
          }
          break;
        }
        if (channel?.editMessageTextAndButtons) {
          const preview = plaintextPreview(body, 800);
          const actedExpand = deps.archiveTracker.getByEmailId
            ? deps.archiveTracker.getByEmailId(entityId)
            : null;
          const threadIdExpand = actedExpand?.thread_id ?? null;
          const draftIdExpand =
            threadIdExpand && account && deps.db
              ? getDraftIdForThread(deps.db, account, threadIdExpand)
              : null;
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
                  ? resolveFullEmailUrl({
                      emailId: entityId,
                      account,
                      draftIdForThread: draftIdExpand,
                    })
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
        const body = getCachedEmailBody(entityId);
        if (body && channel?.editMessageTextAndButtons) {
          const summary = plaintextPreview(body, 300);
          // collapse callback carries account as `extra` (collapse:entityId:account).
          // Fall back to acted_emails lookup for legacy callbacks that lack it.
          const actedCollapse = deps.archiveTracker.getByEmailId
            ? deps.archiveTracker.getByEmailId(entityId)
            : null;
          const threadIdCollapse = actedCollapse?.thread_id ?? null;
          const accountCollapse = extra || actedCollapse?.account || '';
          const draftIdCollapse =
            threadIdCollapse && accountCollapse && deps.db
              ? getDraftIdForThread(deps.db, accountCollapse, threadIdCollapse)
              : null;
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            summary,
            [
              {
                label: '📧 Expand',
                callbackData: accountCollapse
                  ? `expand:${entityId}:${accountCollapse}`
                  : `expand:${entityId}`,
                style: 'secondary',
              },
              {
                label: '🌐 Full Email',
                callbackData: `noop:${entityId}`,
                webAppUrl: MINI_APP_URL
                  ? resolveFullEmailUrl({
                      emailId: entityId,
                      account: accountCollapse,
                      draftIdForThread: draftIdCollapse,
                    })
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

      case 'retry_send': {
        // Retry a failed draft send. entityId = draftId. Account is resolved
        // from draft_originals (stored when the draft was enriched).
        if (!deps.db || !deps.gmailOps) {
          logger.warn(
            { draftId: entityId },
            'retry_send: db or gmailOps missing',
          );
          break;
        }
        const row = deps.db
          .prepare('SELECT account FROM draft_originals WHERE draft_id = ?')
          .get(entityId) as { account: string } | undefined;
        if (!row) {
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              '⚠️ Draft no longer exists — cannot retry.',
              [],
            );
          }
          break;
        }
        try {
          await deps.gmailOps.sendDraft(row.account, entityId);
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              '✅ Sent on retry.',
              [],
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { draftId: entityId, account: row.account, err },
            'retry_send failed',
          );
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              `❌ Retry failed: ${msg}`,
              [],
            );
          }
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
          // Route the answer back to the originating agent so it can act on
          // the decision. Without this, Yes/No buttons are cosmetic — the
          // agent never learns the user said yes to "should I forward X?".
          if (deps.injectUserReply) {
            const reply =
              answer === 'yes'
                ? '✅ Yes — proceed.'
                : answer === 'no'
                  ? '❌ No — do not proceed.'
                  : answer === 'handled'
                    ? '✓ Already handled out-of-band — stop this task and treat as resolved. Do not take further action or send a reply.'
                    : `User answered: ${answer}`;
            const delivered = deps.injectUserReply(query.chatJid, reply);
            logger.info(
              { questionId, answer, delivered, chatJid: query.chatJid },
              'Answer routed to agent',
            );
          }
          // Acknowledge the click by replacing buttons with a confirmation
          // line so the user sees the system registered the answer.
          if (channel?.editMessageButtons) {
            await channel
              .editMessageButtons(query.chatJid, query.messageId, [])
              .catch(() => {});
          }
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

      case 'forward_person': {
        // entityId = action id (transient), extra = URI-encoded person name.
        // Try to resolve the name against the macOS Contacts DB on the host
        // first — skips an agent round-trip when the contact is unambiguous.
        // Falls back to delegating the lookup to the agent (which has the
        // container-side search_contacts MCP tool) when no single match
        // exists on the host.
        const person = decodeURIComponent(extra || '');
        if (!person) {
          logger.warn({ entityId }, 'forward_person missing person name');
          break;
        }
        const resolvedEmail = resolveSingleContactEmail(person);
        if (deps.injectUserReply) {
          const reply = resolvedEmail
            ? `✅ Yes — forward it to ${person} <${resolvedEmail}>.`
            : `✅ Yes — forward it. Look up ${person} via search_contacts to get their email address, then send.`;
          deps.injectUserReply(query.chatJid, reply);
          logger.info(
            { person, resolvedOnHost: Boolean(resolvedEmail) },
            'forward_person routed',
          );
        }
        if (channel?.editMessageButtons) {
          await channel
            .editMessageButtons(query.chatJid, query.messageId, [])
            .catch(() => {});
        }
        break;
      }

      case 'retry': {
        // entityId = original action (expand | archive | confirm_archive),
        // extra/extra2 = params to re-dispatch.
        const retryAction = entityId;
        const retryData =
          retryAction === 'expand'
            ? `expand:${extra}:${extra2}`
            : retryAction === 'archive'
              ? `archive:${extra}`
              : retryAction === 'confirm_archive'
                ? `confirm_archive:${extra}`
                : null;
        if (!retryData) {
          logger.warn({ retryAction }, 'Unknown retry action');
          break;
        }
        await handleCallback({ ...query, data: retryData }, deps);
        break;
      }

      case 'dismiss_failure': {
        if (channel?.editMessageButtons) {
          await channel
            .editMessageButtons(query.chatJid, query.messageId, [])
            .catch(() => {});
        }
        break;
      }

      case 'triage': {
        // Triage v1 queue-button callbacks.
        // Formats:
        //   triage:archive:<itemId>
        //   triage:dismiss:<itemId>
        //   triage:snooze:1h:<itemId>
        //   triage:snooze:tomorrow:<itemId>
        //   triage:override:attention:<itemId>
        //   triage:override:archive:<itemId>
        // After initial split: action='triage', entityId=<sub>, extra, extra2.
        const sub = entityId;
        let triageToast: string | undefined;
        // When set, collapse the card message text to this one-liner status
        // (matches the existing `confirm_archive` "✅ Archived" pattern).
        // Skip for failures so the user can retry without scrolling away.
        let collapseText: string | undefined;
        if (sub === 'archive_all') {
          // Mass-archive the whole archive queue.
          //
          // Gmail is source of truth: for every gmail-sourced candidate, we
          // archive the thread in Gmail first and only resolve locally on
          // success. Items that fail (or are missing metadata) stay queued
          // so the user can retry — the reconciler would re-surface them
          // anyway if we local-resolved without archiving in Gmail.
          if (deps.db) {
            const rows = deps.db
              .prepare(
                `SELECT id, source, thread_id, metadata FROM tracked_items
                 WHERE state = 'queued'
                   AND (queue = 'archive_candidate'
                        OR (queue IS NULL AND classification = 'digest'))`,
              )
              .all() as Array<{
              id: string;
              source: string;
              thread_id: string | null;
              metadata: string | null;
            }>;

            // Empty-queue path: dashboard pin is stale — items were resolved
            // by the reconciler, junk-reaper, or another path that didn't
            // trigger a refresh. Re-render the pin so the count drops to 0
            // and tell the user explicitly that the click was a no-op.
            if (rows.length === 0) {
              logger.info(
                { matched: 0, chatJid: query.chatJid },
                'Mass archive via dashboard button (empty queue — refreshing stale dashboard)',
              );
              await refreshArchiveDashboard();
              return {
                toast: '✓ Queue was already empty — dashboard refreshed',
              };
            }

            const succeededIds: string[] = [];
            let failed = 0;

            for (const row of rows) {
              let account: string | null = null;
              if (row.metadata) {
                try {
                  const m = JSON.parse(row.metadata) as { account?: string };
                  account = typeof m.account === 'string' ? m.account : null;
                } catch {
                  // malformed metadata — treat as missing account
                }
              }

              // Non-gmail items: resolve locally with no Gmail call.
              if (row.source !== 'gmail' || !row.thread_id) {
                succeededIds.push(row.id);
                continue;
              }

              if (!deps.gmailOps || !account) {
                failed++;
                continue;
              }

              try {
                await deps.gmailOps.archiveThread(account, row.thread_id);
                succeededIds.push(row.id);
              } catch (err) {
                failed++;
                logger.warn(
                  {
                    itemId: row.id,
                    account,
                    threadId: row.thread_id,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  'archive_all: Gmail archive failed, leaving item queued',
                );
              }
            }

            let archived = 0;
            if (succeededIds.length > 0) {
              const ph = succeededIds.map(() => '?').join(',');
              const info = deps.db
                .prepare(
                  `UPDATE tracked_items
                   SET state = 'resolved',
                       resolution_method = 'manual:archive_all',
                       resolved_at = ?
                   WHERE state = 'queued'
                     AND id IN (${ph})`,
                )
                .run(Date.now(), ...succeededIds);
              archived = info.changes;
            }

            logger.info(
              {
                count: archived,
                failed,
                matched: rows.length,
                chatJid: query.chatJid,
              },
              'Mass archive via dashboard button',
            );
            // Refresh the dashboard immediately so the user sees 0 pending.
            await refreshArchiveDashboard();
            triageToast =
              failed > 0
                ? `🗂 Archived ${archived} · ⚠️ ${failed} failed`
                : `🗂 Archived ${archived}`;
          }
          return triageToast ? { toast: triageToast } : undefined;
        }
        if (sub === 'archive') {
          const result = await handleTriageArchive(extra, {
            gmailOps: deps.gmailOps,
          });
          // Per-card archive shrinks the archive queue (or graduates an
          // attention item out of inbox). Either way, refresh the pin.
          void refreshArchiveDashboard();
          // Defensive: tests mock handleTriageArchive without a return value.
          // Treat that as a successful archive for toast purposes.
          if (!result || result.archived) {
            triageToast = '🗃 Archived';
            collapseText = '🗃 Archived';
          } else if (result.reason === 'gmail_failed') {
            // Don't collapse — the item is still queued and the user may
            // want to retry from this card.
            triageToast = '⚠️ Gmail archive failed — item kept';
          } else if (result.reason === 'missing') {
            triageToast = '⚠️ Item not found (already resolved?)';
            collapseText = '⚠️ Item not found (already resolved?)';
          } else {
            triageToast = '⚠️ Could not archive';
          }
        } else if (sub === 'dismiss') {
          handleTriageDismiss(extra);
          triageToast = '✓ Dismissed';
          collapseText = '✓ Dismissed';
        } else if (sub === 'snooze') {
          const duration = extra;
          const itemId = extra2;
          if (duration === '1h') {
            handleTriageSnooze(itemId, duration);
            triageToast = '⏰ Snoozed 1h';
            collapseText = '⏰ Snoozed 1h';
          } else if (duration === 'tomorrow') {
            handleTriageSnooze(itemId, duration);
            triageToast = '⏰ Snoozed until tomorrow 8am';
            collapseText = '⏰ Snoozed until tomorrow 8am';
          } else {
            logger.warn(
              { duration, data: query.data },
              'Unknown triage snooze duration',
            );
          }
        } else if (sub === 'override') {
          const target = extra;
          const itemId = extra2;
          if (target === 'attention') {
            handleTriageOverride(itemId, 'attention');
            triageToast = '✓ Moved to attention';
            collapseText = '📥 Moved to attention';
          } else if (target === 'archive') {
            handleTriageOverride(itemId, 'archive_candidate');
            // Override into archive_candidate may have moved an attention
            // card into the archive queue — the pinned count needs to bump.
            void refreshArchiveDashboard();
            triageToast = '✓ Moved to archive queue';
            collapseText = '🗃 Moved to archive queue';
          } else {
            logger.warn(
              { target, data: query.data },
              'Unknown triage override target',
            );
          }
        } else {
          logger.warn({ sub, data: query.data }, 'Unknown triage sub-action');
        }
        // Collapse the card on success: replace text + clear buttons in one
        // edit. On failure (no collapseText), just clear the buttons so the
        // original card remains readable for retry context.
        if (collapseText && channel?.editMessageTextAndButtons) {
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            collapseText,
            [],
          );
        } else if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, []);
        }
        return triageToast ? { toast: triageToast } : undefined;
      }

      case 'qa': {
        // QA autopilot approval-flow callbacks. Format:
        //   qa:merge:<proposalId>    ff-merge branch to main, push, restart
        //   qa:close:<proposalId>    delete branch + worktree, drop proposal
        //   qa:details:<proposalId>  send full agent transcript
        const sub = entityId;
        const proposalId = extra;
        await handleQaCallback(sub, proposalId, query, channel);
        break;
      }

      default:
        logger.warn({ action, data: query.data }, 'Unknown callback action');
    }
  } catch (err) {
    logger.error({ err, action, entityId }, 'Callback handler failed');
    if (channel?.editMessageTextAndButtons) {
      const message = `⚠️ ${action} failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      // Emit retry buttons for Gmail-backed actions so a transient outage
      // (token expiry, network blip, channel not yet registered) doesn't
      // leave the user stuck. entityId + extra preserve the original call.
      const retryableActions = new Set([
        'expand',
        'archive',
        'confirm_archive',
      ]);
      const retryActions: Action[] = retryableActions.has(action)
        ? [
            {
              label: '🔄 Retry',
              callbackData: `retry:${action}:${entityId}:${extra}`,
              style: 'primary',
            },
            {
              label: '❌ Dismiss',
              callbackData: `dismiss_failure:${entityId}`,
              style: 'secondary',
            },
          ]
        : [];
      await channel
        .editMessageTextAndButtons(
          query.chatJid,
          query.messageId,
          message,
          retryActions,
        )
        .catch(() => {});
    }
  }
}
