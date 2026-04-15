import { CHAT_INTERFACE_CONFIG } from './config.js';
import type { ClassificationReason, ItemClassification } from './tracked-items.js';

export interface ClassificationInput {
  source: string;
  sourceId: string;
  superpilotLabel: string | null;
  trustTier: string | null;
  senderPattern: string;
  title: string;
  summary: string | null;
  userActed: boolean;
  metadata: Record<string, unknown>;
}

export interface ClassificationResult {
  decision: ItemClassification;
  reason: ClassificationReason;
}

export function classify(input: ClassificationInput): ClassificationResult {
  const { urgencyKeywords, vipList } = CHAT_INTERFACE_CONFIG;

  if (input.userActed) {
    return {
      decision: 'resolved',
      reason: { final: 'resolved' },
    };
  }

  if (input.source === 'gmail' && input.superpilotLabel) {
    return classifyEmail(input);
  }

  if (input.source === 'calendar') {
    return classifyCalendar(input);
  }

  if (input.source === 'discord') {
    return classifyDiscord(input, vipList);
  }

  if (hasUrgencyKeyword(input.title, urgencyKeywords)) {
    return {
      decision: 'push',
      reason: { final: 'push' },
    };
  }

  return { decision: 'digest', reason: { final: 'digest' } };
}

function classifyEmail(input: ClassificationInput): ClassificationResult {
  const reason: ClassificationReason = {
    superpilot: input.superpilotLabel ?? undefined,
    trust: input.trustTier ?? undefined,
    final: 'digest',
  };

  if (input.superpilotLabel === 'needs-attention') {
    reason.final = 'push';
    return { decision: 'push', reason };
  }

  if (
    input.superpilotLabel === 'fyi' ||
    input.superpilotLabel === 'newsletter' ||
    input.superpilotLabel === 'transactional'
  ) {
    reason.final = 'digest';
    return { decision: 'digest', reason };
  }

  if (hasUrgencyKeyword(input.title, CHAT_INTERFACE_CONFIG.urgencyKeywords)) {
    reason.final = 'push';
    return { decision: 'push', reason };
  }

  return { decision: 'digest', reason };
}

function classifyCalendar(input: ClassificationInput): ClassificationResult {
  const conflictInMinutes = input.metadata.conflictInMinutes as number | undefined;
  if (conflictInMinutes !== undefined && conflictInMinutes <= 30) {
    return {
      decision: 'push',
      reason: { calendar: `conflict_in_${conflictInMinutes}min`, final: 'push' },
    };
  }
  return {
    decision: 'digest',
    reason: {
      calendar: conflictInMinutes ? `conflict_in_${conflictInMinutes}min` : 'no_conflict',
      final: 'digest',
    },
  };
}

function classifyDiscord(input: ClassificationInput, vipList: string[]): ClassificationResult {
  const isMention = input.metadata.isMention as boolean | undefined;
  const isVip = vipList.some(v => input.senderPattern.toLowerCase().includes(v.toLowerCase()));

  if (isMention && isVip) {
    return {
      decision: 'push',
      reason: { final: 'push' },
    };
  }
  return {
    decision: 'digest',
    reason: { final: 'digest' },
  };
}

function hasUrgencyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}
