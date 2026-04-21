import { sendTelegramMessage } from '../channels/telegram.js';
import { MINI_APP_URL } from '../config.js';
import { isSignInvite } from './sign-detector.js';

export interface PushAttentionInput {
  chatId: string;
  itemId: string;
  title: string;
  reason: string;
  sender: string;
  // When the caller has already resolved the vendor's signing URL from the
  // email body, pass it here. The Sign button will link straight to the
  // vendor (DocuSign/Adobe Sign/etc.) instead of routing through the
  // mini-app — skips the Cloudflare Access prompt on tap.
  signUrl?: string;
  /** When set (signer feature flag on + ceremony created), renders callback Sign/Cancel buttons for auto-sign instead of a URL button. Takes precedence over signUrl. */
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

  // Row 1: snooze + triage decisions. "Move to archive queue" was dropped
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

  // Row 0 (top): Sign (for e-sig invites) and/or Full Email. Without a way
  // to open the email, the user has to switch to Gmail to read past the
  // two-line reason — defeats the purpose of pushing the card.
  //
  // Sign-button precedence (highest first):
  //   1. signerCeremonyId → callback buttons that auto-sign via the signer
  //      module (ceremony, LLM summary, risk-flag double-confirm, etc.).
  //   2. signUrl → direct vendor URL, skips the mini-app route and its
  //      Cloudflare Access prompt. Manual sign on the vendor page.
  //   3. fallback → mini-app /api/email/:id/sign (302 to vendor; gated by
  //      Cloudflare Access).
  if (MINI_APP_URL) {
    const base = MINI_APP_URL.replace(/\/$/, '');
    const topRow: InlineButton[] = [];
    if (isSignInvite({ from: input.sender, subject: input.title })) {
      if (input.signerCeremonyId) {
        topRow.push({
          text: '✍ Sign',
          callback_data: `sign:approve:${input.signerCeremonyId}`,
        });
        topRow.push({
          text: '✕ Cancel Sign',
          callback_data: `sign:cancel:${input.signerCeremonyId}`,
        });
      } else {
        const signUrl =
          input.signUrl ??
          `${base}/api/email/${encodeURIComponent(input.itemId)}/sign`;
        topRow.push({ text: '✍ Sign', url: signUrl });
      }
    }
    topRow.push({
      text: '🌐 Full Email',
      url: `${base}/email/${encodeURIComponent(input.itemId)}`,
    });
    keyboard.unshift(topRow);
  }

  await sendTelegramMessage(input.chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}
