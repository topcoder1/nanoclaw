import { sendTelegramMessage } from '../channels/telegram.js';
import { MINI_APP_URL } from '../config.js';
import { isSignInvite } from './sign-detector.js';

export interface PushAttentionInput {
  chatId: string;
  itemId: string;
  title: string;
  reason: string;
  sender: string;
  /** When set, renders callback_data Sign/Cancel buttons instead of the legacy URL button. */
  signerCeremonyId?: string;
}

type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

/**
 * Post a per-email attention message to Telegram with inline action buttons.
 * Button callback_data strings match the handlers registered by the
 * triage callback router (snooze 1h/tomorrow, dismiss, archive, override).
 *
 * When the email looks like an e-signature invite and MINI_APP_URL is
 * configured, a top row with a "✍ Sign" URL button is prepended. The
 * button deep-links to /api/email/:id/sign, which resolves to the
 * vendor's signing page (DocuSign/Adobe Sign/etc.) — never auto-signs.
 */
export async function pushAttentionItem(
  input: PushAttentionInput,
): Promise<void> {
  const text = `📌 *${input.title}*\nfrom: ${input.sender}\nreason: ${input.reason}`;

  // Single row of four compact actions. "Move to archive queue" was dropped
  // — its learning signal (negative override) is now what Archive records
  // by default when clicked from an attention card, since an archive action
  // on a classifier-escalated item IS the classifier being wrong.
  const keyboard: InlineButton[][] = [
    [
      { text: '⏰ 1h', callback_data: `triage:snooze:1h:${input.itemId}` },
      {
        text: '⏰ Tomorrow',
        callback_data: `triage:snooze:tomorrow:${input.itemId}`,
      },
      { text: '✕ Dismiss', callback_data: `triage:dismiss:${input.itemId}` },
      { text: '🗃 Archive', callback_data: `triage:archive:${input.itemId}` },
    ],
  ];

  if (isSignInvite({ from: input.sender, subject: input.title })) {
    if (input.signerCeremonyId) {
      keyboard.unshift([
        {
          text: '✍ Sign',
          callback_data: `sign:approve:${input.signerCeremonyId}`,
        },
        {
          text: '✕ Cancel Sign',
          callback_data: `sign:cancel:${input.signerCeremonyId}`,
        },
      ]);
    } else if (MINI_APP_URL) {
      const base = MINI_APP_URL.replace(/\/$/, '');
      keyboard.unshift([
        {
          text: '✍ Sign',
          url: `${base}/api/email/${encodeURIComponent(input.itemId)}/sign`,
        },
      ]);
    }
  }

  await sendTelegramMessage(input.chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}
