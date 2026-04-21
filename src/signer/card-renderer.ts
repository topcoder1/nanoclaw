import type { SignCeremony, RiskFlag } from './types.js';

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export interface Card {
  text: string;
  buttons: InlineButton[][];
}

function highFlags(flags: RiskFlag[]): RiskFlag[] {
  return flags.filter((f) => f.severity === 'high');
}

export function renderCeremonyCard(c: SignCeremony): Card {
  const highs = highFlags(c.riskFlags);
  const title = c.docTitle ?? '(no title)';
  const summaryBlock = c.summaryText ? `\n\n${c.summaryText}` : '';

  let header = `📝 *${title}*`;
  if (highs.length > 0) {
    const flagLines = highs
      .map((f) => `  • *${f.category}*: "${f.evidence}"`)
      .join('\n');
    header = `⚠️ ${highs.length} risks flagged\n\n${header}\n${flagLines}`;
  }

  return {
    text: `${header}${summaryBlock}`,
    buttons: [
      [
        { text: '✅ Sign', callback_data: `sign:approve:${c.id}` },
        { text: '❌ Dismiss', callback_data: `sign:cancel:${c.id}` },
        { text: '📄 Full doc', url: c.signUrl },
      ],
    ],
  };
}

export function renderDoubleConfirmCard(c: SignCeremony): Card {
  return {
    text: `⚠️⚠️ Tap again to confirm — *${c.docTitle ?? 'document'}*`,
    buttons: [
      [
        { text: '✅✅ Confirm', callback_data: `sign:approve:${c.id}` },
        { text: '❌ Cancel', callback_data: `sign:cancel:${c.id}` },
      ],
    ],
  };
}

export interface ReceiptInput {
  ceremony: SignCeremony;
  outcome: 'signed' | 'failed';
}

export function renderReceipt(input: ReceiptInput): Card {
  const { ceremony, outcome } = input;
  if (outcome === 'signed') {
    return {
      text: `✅ Signed — ${ceremony.docTitle ?? 'document'}`,
      buttons: [],
    };
  }
  return {
    text: `❌ Sign failed: ${ceremony.failureReason ?? 'unknown'}\n\n(${ceremony.docTitle ?? 'document'})`,
    buttons: [[{ text: '🖥 Open in browser', url: ceremony.signUrl }]],
  };
}
