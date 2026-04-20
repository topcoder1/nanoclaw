import { escapeHtml } from './escape.js';
import {
  renderActionRow,
  type Classification,
  type SenderKind,
  type Subtype,
} from './action-row.js';

export interface EmailFullData {
  mode?: 'view' | 'reply'; // default: 'view' (backward compatible)
  draftId?: string; // required when mode === 'reply'
  account?: string; // used by both reply mode and view-mode archive button
  emailId?: string; // used by view-mode archive button
  // Real Gmail thread/message id (source_id stripped of "gmail:" prefix). Used
  // by the Archive button (so the server can call Gmail API directly) and by
  // the "Open in Gmail" link (anchor must be a Gmail id, not nanoclaw's id).
  gmailId?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
  classification?: Classification;
  senderKind?: SenderKind;
  subtype?: Subtype;
  hasUnsubscribeHeader?: boolean;
}

// Gmail's extractTextBody prefers text/plain, so many messages arrive as raw
// plaintext (URLs in "(https://...)" form, no tags). Rendering that inside an
// iframe srcdoc makes everything one unformatted blob. Detect HTML vs plain
// text and render each appropriately.
function looksLikeHtml(body: string): boolean {
  return /<(html|body|div|p|br|table|tr|td|span|a\s|img|h[1-6]|ul|ol|li)\b/i.test(
    body,
  );
}

// Gmail deep-link URL, routed by account type:
// - Workspace domain (e.g. @attaxion.com): /a/DOMAIN/ — Gmail looks up
//   the signed-in user for that Workspace domain, or prompts sign-in if
//   none. Works even when the user hasn't added that specific email to
//   Chrome's account picker.
// - Personal gmail.com (or no account): /mail/u/EMAIL/ or bare /mail/.
// The previous /u/EMAIL/ form 404'd for the user because the Attaxion
// Workspace account wasn't in their browser session even though our
// backend had OAuth for it.
function buildGmailOpenUrl(account: string, threadId: string): string {
  const id = threadId || '';
  if (!account) return `https://mail.google.com/mail/#inbox/${id}`;
  const domain = (account.split('@')[1] || '').toLowerCase();
  if (domain && domain !== 'gmail.com' && domain !== 'googlemail.com') {
    return `https://mail.google.com/a/${domain}/#inbox/${id}`;
  }
  return `https://mail.google.com/mail/u/${account}/#inbox/${id}`;
}

function renderPlainTextBody(body: string): string {
  // Escape, then linkify bare URLs, then convert newlines.
  const escaped = escapeHtml(body);
  // Capture URL greedily, then peel trailing punctuation/closing brackets
  // that are almost never part of the URL itself — common in plain-text
  // emails that wrap links like "[Gusto] (https://gusto.com)".
  const linkified = escaped.replace(/(https?:\/\/[^\s<>"]+)/g, (url) => {
    const m = url.match(/^(.*?)([).,;:!?]+)$/);
    const clean = m ? m[1] : url;
    const trail = m ? m[2] : '';
    return `<a href="${clean}" target="_blank" rel="noopener" style="color:#58a6ff;">${clean}</a>${trail}`;
  });
  // Double-newline => paragraph; single => <br>.
  const paragraphs = linkified
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div class="body" style="font-size:14px;line-height:1.6;color:#c9d1d9;word-wrap:break-word;">${paragraphs}</div>`;
}

export function renderEmailFull(data: EmailFullData): string {
  const mode = data.mode ?? 'view';
  const attachmentsHtml =
    data.attachments.length > 0
      ? `<div style="border-top:1px solid #21262d;padding-top:12px;margin-top:12px;"><div style="font-size:11px;color:#484f58;margin-bottom:8px;">ATTACHMENTS</div>${data.attachments.map((a) => `<div style="font-size:13px;color:#58a6ff;">📎 ${escapeHtml(a.name)} (${escapeHtml(a.size)})</div>`).join('')}</div>`
      : '';

  const bodyHtml = looksLikeHtml(data.body)
    ? `<div class="body">
  <iframe
    sandbox=""
    srcdoc="${escapeHtml(data.body)}"
    style="width:100%;border:none;min-height:300px;background:#0d1117;color-scheme:dark;"
    onload="this.style.height=this.contentDocument.body.scrollHeight+'px'"
  ></iframe>
</div>`
    : renderPlainTextBody(data.body);

  const actionRowHtml = renderActionRow({
    emailId: data.emailId || '',
    account: data.account || '',
    threadId: data.gmailId || '',
    classification: data.classification ?? null,
    senderKind: data.senderKind ?? null,
    subtype: data.subtype ?? null,
    hasUnsubscribeHeader: data.hasUnsubscribeHeader ?? false,
  });

  const viewControls = `${bodyHtml}
  ${attachmentsHtml}
  ${actionRowHtml}
<script>
(function(){
  const OPEN_GMAIL_URL = ${JSON.stringify(buildGmailOpenUrl(data.account || '', data.gmailId || data.emailId || ''))};

  function showBanner(text, actionLabel, actionFn) {
    const existing = document.querySelector('.action-banner');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'action-banner';
    div.style.cssText = 'border-top:1px solid #21262d;padding-top:12px;margin-top:12px;color:#c9d1d9;';
    div.textContent = text;
    if (actionLabel && actionFn) {
      const a = document.createElement('button');
      a.textContent = actionLabel;
      a.style.cssText = 'margin-left:12px;background:#21262d;color:#c9d1d9;padding:6px 12px;border-radius:6px;border:none;';
      a.onclick = () => { actionFn(); div.remove(); };
      div.appendChild(a);
    }
    document.body.appendChild(div);
  }

  function toggleMoreRow() {
    const row = document.getElementById('more-row');
    if (!row) return;
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
  }

  async function handleArchive(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving...';
    try {
      const resp = await fetch('/api/email/' + encodeURIComponent(id) + '/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: btn.dataset.account,
          threadId: btn.dataset.threadId || undefined,
        }),
      });
      if (resp.ok) {
        btn.textContent = 'Archived';
        btn.style.opacity = '0.5';
        if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.close();
      } else {
        btn.textContent = 'Failed - Retry';
        btn.disabled = false;
      }
    } catch (e) {
      btn.textContent = 'Failed - Retry';
      btn.disabled = false;
    }
  }

  async function handleMute(id, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Muting…';
    const r = await fetch('/api/email/' + encodeURIComponent(id) + '/mute', {
      method: 'POST',
    });
    const j = await r.json();
    if (j.ok) {
      showBanner('🔇 Muted', 'Unmute', () =>
        fetch('/api/email/' + encodeURIComponent(id) + '/mute', { method: 'DELETE' }),
      );
    } else {
      btn.disabled = false;
      btn.textContent = original;
      alert(j.error || 'Mute failed');
    }
  }

  function handleSnooze(id, btn) {
    if (btn.parentElement?.querySelector('.snooze-dropdown')) return;
    const wrap = document.createElement('div');
    wrap.className = 'snooze-dropdown';
    wrap.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;';
    const labels = {
      '1h': '1 hour',
      'tomorrow-8am': 'Tomorrow 8am',
      'next-monday-8am': 'Next Mon 8am',
      'next-week': 'Next week',
      custom: 'Custom…',
    };
    ['1h', 'tomorrow-8am', 'next-monday-8am', 'next-week', 'custom'].forEach((d) => {
      const b = document.createElement('button');
      b.textContent = labels[d];
      b.style.cssText = 'background:#21262d;color:#c9d1d9;padding:6px 10px;border-radius:6px;border:none;font-size:12px;';
      b.onclick = async () => {
        let wakeAt;
        if (d === 'custom') {
          const v = prompt('Snooze until (ISO datetime, e.g. 2026-04-21T09:00)?');
          if (!v) return;
          wakeAt = new Date(v).toISOString();
        }
        const res = await fetch('/api/email/' + encodeURIComponent(id) + '/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: d, wake_at: wakeAt }),
        });
        const j = await res.json();
        if (!j.ok) {
          alert(j.error || 'Snooze failed');
          return;
        }
        wrap.remove();
        const when = new Date(j.wake_at).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        });
        showBanner('💤 Snoozed until ' + when, 'Unsnooze', () =>
          fetch('/api/email/' + encodeURIComponent(id) + '/snooze', { method: 'DELETE' }),
        );
      };
      wrap.appendChild(b);
    });
    btn.parentElement.appendChild(wrap);
  }

  async function handleUnsubscribe(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Unsubscribing…';
    const res = await fetch('/api/email/' + encodeURIComponent(id) + '/unsubscribe', { method: 'POST' });
    const j = await res.json();
    if (j.ok) {
      showBanner('✅ Unsubscribed and archived (' + j.method + ')', null, null);
    } else if (j.code === 'NO_UNSUBSCRIBE_HEADER') {
      showBanner('No unsubscribe link in headers', 'Open in Gmail', () => {
        window.open(OPEN_GMAIL_URL, '_blank', 'noopener');
      });
      btn.disabled = false;
      btn.textContent = '📭 Unsubscribe';
    } else {
      showBanner('⚠️ Unsubscribe may have failed — ' + (j.error || 'unknown'), 'Open in Gmail', () => {
        window.open(OPEN_GMAIL_URL, '_blank', 'noopener');
      });
      btn.disabled = false;
      btn.textContent = '📭 Unsubscribe';
    }
  }

  async function handleChip(kind, id) {
    const chips = document.querySelectorAll('.chip');
    chips.forEach((c) => {
      c.disabled = true;
    });
    const r = await fetch('/api/email/' + encodeURIComponent(id) + '/canned-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    const j = await r.json();
    if (!j.ok) {
      chips.forEach((c) => {
        c.disabled = false;
      });
      alert(j.error || 'Canned reply failed');
      return;
    }
    const countdown = Math.max(0, Math.round((j.sendAt - Date.now()) / 1000));
    showUndoBanner(j.draftId, countdown);
  }

  function showUndoBanner(draftId, countdown) {
    const div = document.createElement('div');
    div.className = 'action-banner';
    div.style.cssText = 'border-top:1px solid #21262d;padding-top:12px;margin-top:12px;color:#c9d1d9;';
    const label = document.createElement('span');
    label.innerHTML = 'Sending in <span id="cd">' + countdown + '</span>s';
    div.appendChild(label);
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    undo.style.cssText = 'margin-left:12px;background:#f85149;color:#fff;padding:6px 12px;border-radius:6px;border:none;';
    undo.onclick = async () => {
      await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send/cancel', { method: 'POST' });
      div.remove();
      document.querySelectorAll('.chip').forEach((c) => { c.disabled = false; });
    };
    div.appendChild(undo);
    document.body.appendChild(div);
    const timer = setInterval(() => {
      countdown -= 1;
      const el = document.getElementById('cd');
      if (el) el.textContent = String(countdown);
      if (countdown <= 0) {
        clearInterval(timer);
        div.innerHTML = '<span style="color:#6ca368;">Sent.</span>';
        setTimeout(() => div.remove(), 3000);
      }
    }, 1000);
  }

  async function handleQuickDraft(id, btn) {
    btn.disabled = true;
    btn.textContent = '⚡ Drafting…';
    const res = await fetch('/api/email/' + encodeURIComponent(id) + '/draft-with-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const j = await res.json();
    if (!j.ok) {
      btn.disabled = false;
      btn.textContent = '⚡ Quick draft';
      alert(j.error || 'Draft failed');
      return;
    }
    pollDraftTask(j.taskId, btn);
  }

  function handleDraftPrompt(id, btn) {
    if (document.getElementById('draft-prompt-input')) return;
    const ta = document.createElement('textarea');
    ta.id = 'draft-prompt-input';
    ta.placeholder = 'What should the reply say? (e.g. "decline politely, suggest next Tues")';
    ta.style.cssText = 'display:block;width:100%;min-height:72px;margin-top:8px;padding:8px;background:#0d1117;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;font:inherit;';
    const sub = document.createElement('button');
    sub.textContent = 'Draft';
    sub.style.cssText = 'margin-top:6px;background:#1f6feb;color:#fff;padding:8px 14px;border-radius:6px;border:none;';
    sub.onclick = async () => {
      const intent = ta.value.trim();
      if (!intent) return;
      btn.disabled = true;
      sub.disabled = true;
      sub.textContent = 'Drafting…';
      const res = await fetch('/api/email/' + encodeURIComponent(id) + '/draft-with-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      const j = await res.json();
      if (!j.ok) {
        alert(j.error || 'Draft failed');
        btn.disabled = false;
        sub.disabled = false;
        sub.textContent = 'Draft';
        return;
      }
      ta.remove();
      sub.remove();
      pollDraftTask(j.taskId, btn);
    };
    btn.parentElement.appendChild(ta);
    btn.parentElement.appendChild(sub);
  }

  function pollDraftTask(taskId, btn) {
    const deadline = Date.now() + 50_000;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        btn.disabled = false;
        alert('Draft timed out');
        return;
      }
      const res = await fetch('/api/draft-status/' + encodeURIComponent(taskId));
      const j = await res.json();
      if (j.status === 'ready' && j.draftId) {
        clearInterval(timer);
        window.location.href = '/reply/' + encodeURIComponent(j.draftId);
      } else if (j.status === 'failed') {
        clearInterval(timer);
        btn.disabled = false;
        alert('Draft failed: ' + (j.error || ''));
      }
    }, 1500);
  }

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest('[data-action],[data-chip]');
    if (!btn) return;
    const emailId = btn.dataset.emailId;
    if (!emailId) return;
    const action = btn.dataset.action;
    const chip = btn.dataset.chip;
    if (chip) return handleChip(chip, emailId);
    switch (action) {
      case 'archive':      return handleArchive(emailId, btn);
      case 'snooze':       return handleSnooze(emailId, btn);
      case 'mute':         return handleMute(emailId, btn);
      case 'unsubscribe':  return handleUnsubscribe(emailId, btn);
      case 'quick-draft':  return handleQuickDraft(emailId, btn);
      case 'draft-prompt': return handleDraftPrompt(emailId, btn);
      case 'more':         return toggleMoreRow();
      case 'open-gmail':
        window.open(OPEN_GMAIL_URL, '_blank', 'noopener');
        return;
    }
  });
})();
</script>`;

  const replyControls =
    mode === 'reply' && data.draftId && data.account
      ? renderReplyControls(data.draftId, data.account, data.body)
      : viewControls;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.subject)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .meta { font-size: 12px; color: #8b949e; line-height: 1.6; }
    .body { font-size: 14px; line-height: 1.6; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .compose { width: 100%; box-sizing: border-box; background: #0d1117; color: #c9d1d9; border: 1px solid #21262d; border-radius: 6px; padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 180px; }
    .undo-banner { display: none; border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; color: #c9d1d9; font-size: 14px; }
    .undo-banner .countdown { color: #58a6ff; font-weight: 600; }
    .err { color: #f85149; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="subject">${escapeHtml(data.subject)}</div>
    <div class="meta">
      <div><b>From:</b> ${escapeHtml(data.from)}</div>
      <div><b>To:</b> ${escapeHtml(data.to)}</div>
      ${data.cc ? `<div><b>CC:</b> ${escapeHtml(data.cc)}</div>` : ''}
      <div><b>Date:</b> ${escapeHtml(data.date)}</div>
    </div>
  </div>
  ${replyControls}
</body>
</html>`;
}

function renderReplyControls(
  draftId: string,
  account: string,
  draftBody: string,
): string {
  return `
  <textarea id="compose" class="compose" placeholder="Agent's draft — edit before sending">${escapeHtml(draftBody)}</textarea>
  <div class="err" id="err" style="display:none"></div>
  <div class="actions" id="actions">
    <button class="btn" id="send-btn" style="background:#1f6feb;color:#fff;">Send</button>
    <button class="btn" id="edit-gmail-btn">Edit in Gmail</button>
    <button class="btn" id="archive-btn" style="background:#276749;color:#c6f6d5;">Archive</button>
  </div>
  <div class="undo-banner" id="undo-banner">
    Sending in <span class="countdown" id="countdown">10</span>s —
    <button class="btn" id="undo-btn" style="background:#f85149;color:#fff;margin-left:8px;">Undo</button>
  </div>
  <script>
    (function(){
      const draftId = ${JSON.stringify(draftId)};
      const account = ${JSON.stringify(account)};
      const compose = document.getElementById('compose');
      const sendBtn = document.getElementById('send-btn');
      const editBtn = document.getElementById('edit-gmail-btn');
      const archiveBtn = document.getElementById('archive-btn');
      const actions = document.getElementById('actions');
      const banner = document.getElementById('undo-banner');
      const undoBtn = document.getElementById('undo-btn');
      const countdown = document.getElementById('countdown');
      const err = document.getElementById('err');
      let countdownTimer = null;

      function showError(msg){ err.textContent = msg; err.style.display = 'block'; }
      function clearError(){ err.style.display = 'none'; }
      async function saveBody(){
        clearError();
        const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/save', {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ body: compose.value }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'Save failed');
      }

      sendBtn.addEventListener('click', async () => {
        try {
          sendBtn.disabled = true;
          await saveBody();
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}',
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || 'Send failed');
          actions.style.display = 'none';
          banner.style.display = 'block';
          let remaining = 10;
          countdown.textContent = remaining;
          countdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(countdownTimer);
              banner.innerHTML = '<span style="color:#6ca368;">Sent.</span>';
              setTimeout(() => { banner.style.display = 'none'; }, 3000);
            } else {
              countdown.textContent = remaining;
            }
          }, 1000);
        } catch (e) {
          sendBtn.disabled = false;
          showError(String(e.message || e));
        }
      });

      undoBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send/cancel', {
            method: 'POST',
          });
          const j = await res.json();
          if (countdownTimer) clearInterval(countdownTimer);
          if (j.cancelled) {
            banner.style.display = 'none';
            actions.style.display = 'flex';
            sendBtn.disabled = false;
          } else {
            banner.innerHTML = '<span style="color:#f85149;">Too late — already sent.</span>';
          }
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      editBtn.addEventListener('click', async () => {
        try {
          await saveBody();
          // Gmail's /u/EMAIL/ router needs a literal "@", not "%40" —
          // encodeURIComponent would percent-encode it and trigger a 404.
          const url = 'https://mail.google.com/mail/u/' + account + '/#drafts?compose=' + encodeURIComponent(draftId);
          window.open(url, '_blank');
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      archiveBtn.addEventListener('click', () => {
        // Existing archive pathway: Telegram callback handles it; close mini-app.
        window.close();
      });
    })();
  </script>
  `;
}
