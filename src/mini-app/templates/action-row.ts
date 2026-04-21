import { escapeHtml } from './escape.js';

export type Classification =
  | 'push'
  | 'digest'
  | 'transactional'
  | 'ignore'
  | null;
export type SenderKind = 'human' | 'bot' | 'unknown' | null;
export type Subtype = 'transactional' | null;

export interface ActionRowInput {
  emailId: string;
  account: string;
  threadId: string;
  classification: Classification;
  senderKind: SenderKind;
  subtype: Subtype;
  hasUnsubscribeHeader: boolean;
  // True when the email looks like an e-signature invite (DocuSign, Adobe
  // Sign, Dropbox Sign, PandaDoc, SignNow). Surfaces a primary "Sign" button
  // that deep-links to the vendor via /api/email/:id/sign.
  signable?: boolean;
  expanded?: boolean;
}

const ALL_ACTIONS = [
  'sign',
  'quick-draft',
  'draft-prompt',
  'archive',
  'snooze',
  'unsubscribe',
  'mute',
  'open-gmail',
] as const;

function primaryActions(i: ActionRowInput): string[] {
  // Signing is the dominant action for these emails — everything else
  // (archive/snooze/reply) is secondary until the user has signed.
  if (i.signable) {
    if (i.classification === 'push' && i.senderKind === 'human')
      return ['sign', 'quick-draft', 'archive'];
    return ['sign', 'archive', 'snooze'];
  }
  if (i.subtype === 'transactional') return ['archive', 'open-gmail'];
  if (i.classification === 'push' && i.senderKind === 'human')
    return ['quick-draft', 'draft-prompt', 'archive'];
  if (i.classification === 'push') return ['archive', 'snooze', 'open-gmail'];
  if (i.classification === 'digest' && i.hasUnsubscribeHeader)
    return ['unsubscribe', 'archive', 'snooze', 'mute'];
  if (i.classification === 'digest')
    return ['archive', 'snooze', 'mute', 'open-gmail'];
  return ['archive', 'open-gmail'];
}

function chipsFor(i: ActionRowInput): boolean {
  return (
    i.classification === 'push' &&
    i.senderKind === 'human' &&
    i.subtype !== 'transactional'
  );
}

function btn(
  action: string,
  label: string,
  opts: {
    emailId: string;
    account: string;
    threadId: string;
    style?: string;
  },
): string {
  const style = opts.style || 'background:#21262d;color:#c9d1d9;';
  return `<button class="btn" data-action="${action}" data-email-id="${escapeHtml(
    opts.emailId,
  )}" data-account="${escapeHtml(opts.account)}" data-thread-id="${escapeHtml(
    opts.threadId,
  )}" style="${style}padding:8px 14px;border-radius:6px;border:none;font-size:13px;">${escapeHtml(
    label,
  )}</button>`;
}

const LABELS: Record<string, string> = {
  sign: '✍ Sign',
  'quick-draft': '⚡ Quick draft',
  'draft-prompt': '✍️ Draft with prompt',
  archive: 'Archive',
  snooze: '💤 Snooze',
  unsubscribe: '📭 Unsubscribe',
  mute: '🔇 Mute thread',
  'open-gmail': 'Open in Gmail',
};

export function renderActionRow(input: ActionRowInput): string {
  const primary = primaryActions(input);
  const secondary = ALL_ACTIONS.filter(
    (a) =>
      !primary.includes(a) &&
      !(a === 'unsubscribe' && !input.hasUnsubscribeHeader) &&
      !(a === 'sign' && !input.signable),
  );

  const chipsHtml = chipsFor(input)
    ? `<div class="chips" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <button class="btn chip" data-chip="thanks" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Thanks</button>
        <button class="btn chip" data-chip="got-it" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Got it</button>
        <button class="btn chip" data-chip="will-do" data-email-id="${escapeHtml(input.emailId)}" style="background:#1f6feb;color:#fff;padding:6px 12px;border-radius:16px;border:none;font-size:12px;">Will do</button>
      </div>`
    : '';

  const primaryHtml = primary
    .map((a) => {
      const style =
        a === 'sign'
          ? 'background:#1f6feb;color:#fff;'
          : a === 'archive'
            ? 'background:#276749;color:#c6f6d5;'
            : undefined;
      return btn(a, LABELS[a], {
        emailId: input.emailId,
        account: input.account,
        threadId: input.threadId,
        style,
      });
    })
    .join('');

  const moreBtn = btn('more', '⋯ More', {
    emailId: input.emailId,
    account: input.account,
    threadId: input.threadId,
  });

  const secondaryHtml = secondary
    .map((a) =>
      btn(a, LABELS[a], {
        emailId: input.emailId,
        account: input.account,
        threadId: input.threadId,
      }),
    )
    .join('');

  const moreRowStyle = input.expanded ? 'display:flex;' : 'display:none;';

  return `
    ${chipsHtml}
    <div class="actions primary" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      ${primaryHtml}${moreBtn}
    </div>
    <div id="more-row" class="actions secondary" style="${moreRowStyle}gap:8px;flex-wrap:wrap;margin-top:8px;">
      ${secondaryHtml}
    </div>
  `;
}
