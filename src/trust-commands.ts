/**
 * Trust command parsing and response formatting.
 * Commands: trust status, never auto-execute [class], reset trust
 */

import {
  getAllTrustLevels,
  resetTrustLevels,
  setTrustAutoExecute,
} from './db.js';
import type { ActionClass } from './trust-engine.js';

export type TrustCommand =
  | { type: 'status' }
  | { type: 'never_auto'; actionClass: ActionClass }
  | { type: 'reset' };

/** Parse a trigger-stripped message into a trust command, or null. */
export function parseTrustCommand(text: string): TrustCommand | null {
  const lower = text.trim().toLowerCase();

  if (lower === 'trust status' || lower.startsWith('trust status')) {
    return { type: 'status' };
  }

  const neverMatch = lower.match(
    /^never\s+auto[-\s]?execute\s+([a-z]+\.[a-z]+)$/,
  );
  if (neverMatch) {
    return { type: 'never_auto', actionClass: neverMatch[1] as ActionClass };
  }

  if (lower === 'reset trust') {
    return { type: 'reset' };
  }

  return null;
}

const CONFIDENCE_BAR_LENGTH = 10;
function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * CONFIDENCE_BAR_LENGTH);
  return (
    '\u{2588}'.repeat(filled) +
    '\u{2591}'.repeat(CONFIDENCE_BAR_LENGTH - filled)
  );
}

/** Execute a trust command and return the response text. */
export function executeTrustCommand(
  command: TrustCommand,
  groupId: string,
): string {
  switch (command.type) {
    case 'status': {
      const levels = getAllTrustLevels(groupId);
      if (levels.length === 0) {
        return '\u{1F512} *Trust Status*\n\nNo trust data yet \u2014 everything requires approval (cold start).';
      }
      const lines = ['\u{1F512} *Trust Status*', ''];
      for (const level of levels) {
        const bar = confidenceBar(level.confidence);
        const pct = (level.confidence * 100).toFixed(0);
        const gate = !level.auto_execute ? ' \u{1F510} manual' : '';
        lines.push(
          `**${level.action_class}**${gate}`,
          `[${bar}] ${pct}% (${level.approvals}\u{2713} ${level.denials}\u{2717}, threshold ${(level.threshold * 100).toFixed(0)}%)`,
          '',
        );
      }
      return lines.join('\n').trim();
    }

    case 'never_auto': {
      setTrustAutoExecute(command.actionClass, groupId, false, 1.0);
      return `\u{1F510} \`${command.actionClass}\` is now permanently gated \u2014 will always ask for approval.`;
    }

    case 'reset': {
      resetTrustLevels(groupId);
      return '\u{1F504} Trust levels reset to cold start. All actions will require approval again.';
    }
  }
}
