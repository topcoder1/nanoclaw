import { classify } from './classification.js';
import { getDb } from './db.js';
import { eventBus } from './event-bus.js';
import { logger } from './logger.js';
import {
  getTrackedItemBySourceId,
  insertTrackedItem,
  updateDigestState,
  getDigestState,
} from './tracked-items.js';
import type { ItemClassifiedEvent } from './events.js';
import { isThreadMuted } from './triage/mute-filter.js';
import { classifySender, classifySubtype } from './triage/sender-kind.js';
import { triageEmail } from './triage/worker.js';
import { TRIAGE_DEFAULTS } from './triage/config.js';

export interface SSEEmail {
  thread_id: string;
  account: string;
  subject?: string;
  sender?: string;
  snippet?: string;
  superpilot_label?: string;
  // Upstream SuperPilot SSE signals. email_type is the 7-value enum
  // (people | newsletters | promotions | social | transactions | updates
  // | uncategorized) — persisted as the effective superpilot_label when
  // no explicit label is provided.
  email_type?: string;
  suggested_action?: string;
  needs_reply?: boolean;
}

export interface ClassifyResult {
  itemId: string;
  threadId: string;
  decision: 'push' | 'digest' | 'resolved';
  subject: string;
  sender: string;
}

export function classifyFromSSE(
  emails: SSEEmail[],
  groupName: string = 'main',
): ClassifyResult[] {
  const results: ClassifyResult[] = [];

  for (const email of emails) {
    const sourceId = `gmail:${email.thread_id}`;

    // Mute filter — if the thread is muted, skip intake entirely. We do
    // NOT archive here because classifyFromSSE has no gmailOps handle;
    // the SSE layer / reconciler is responsible for archiving. Mute
    // covers the common case where the user muted via the mini-app and
    // SuperPilot hasn't yet filtered the thread out upstream.
    if (isThreadMuted(getDb(), email.thread_id)) {
      logger.info(
        {
          thread_id: email.thread_id,
          component: 'triage',
          event: 'muted_skip',
        },
        'Muted thread — skipping SSE intake',
      );
      continue;
    }

    const existing = getTrackedItemBySourceId('gmail', sourceId);
    if (existing) {
      logger.debug(
        { threadId: email.thread_id },
        'SSE: already tracked, skipping',
      );
      continue;
    }

    const subject = email.subject || '(no subject)';
    const sender = email.sender || 'unknown';
    // Best-effort sender/subtype classification — SSE doesn't carry raw
    // headers or body, only subject + sender + snippet. classifySubtype
    // treats snippet as body (it's all the text we have), and
    // classifySender falls back to the localpart/domain heuristics when
    // headers are empty.
    const senderKind = classifySender({ from: sender, headers: {} });
    const subtype = classifySubtype({
      from: sender,
      gmailCategory: null,
      subject,
      body: email.snippet ?? '',
    });

    // Effective label: explicit superpilot_label wins, otherwise fall back
    // to upstream email_type. SuperPilot currently only ships email_type;
    // superpilot_label is retained for forward compat / testing.
    const effectiveLabel =
      email.superpilot_label ?? email.email_type ?? null;

    const result = classify({
      source: 'gmail',
      sourceId,
      superpilotLabel: effectiveLabel,
      trustTier: null,
      senderPattern: sender,
      title: subject,
      summary: null,
      userActed: false,
      metadata: { account: email.account, threadId: email.thread_id },
    });

    const itemId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    insertTrackedItem({
      id: itemId,
      source: 'gmail',
      source_id: sourceId,
      group_name: groupName,
      state: result.decision === 'push' ? 'pending' : 'queued',
      classification: result.decision,
      superpilot_label: effectiveLabel,
      trust_tier: null,
      title: subject,
      summary: null,
      thread_id: email.thread_id,
      detected_at: now,
      pushed_at: result.decision === 'push' ? now : null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: result.reason,
      metadata: { account: email.account, sender },
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
      sender_kind: senderKind,
      subtype,
      suggested_action: email.suggested_action ?? null,
      needs_reply:
        typeof email.needs_reply === 'boolean' ? email.needs_reply : null,
    });

    if (result.decision === 'digest') {
      const state = getDigestState(groupName);
      updateDigestState(groupName, { queued_count: state.queued_count + 1 });
    }

    const event: ItemClassifiedEvent = {
      type: 'item.classified',
      source: 'sse-classifier',
      timestamp: now,
      payload: {
        itemId,
        decision: result.decision,
        source: 'gmail',
        reason: result.reason as unknown as Record<string, unknown>,
      },
    };
    eventBus.emit('item.classified', event);

    if (TRIAGE_DEFAULTS.enabled) {
      // Fire-and-forget. Errors are logged inside triageEmail; this catch is a
      // belt-and-suspenders guard so triage failures never crash the classifier.
      void triageEmail({
        trackedItemId: itemId,
        emailBody: email.snippet || email.subject || '',
        sender,
        subject,
        superpilotLabel: email.superpilot_label ?? null,
        threadId: email.thread_id,
        account: email.account,
      }).catch((err) => {
        logger.warn(
          { err: String(err), itemId },
          'Triage worker error (async)',
        );
      });
    }

    results.push({
      itemId,
      threadId: email.thread_id,
      decision: result.decision,
      subject,
      sender,
    });

    logger.info(
      { threadId: email.thread_id, decision: result.decision, itemId },
      'SSE email classified inline',
    );
  }

  return results;
}
