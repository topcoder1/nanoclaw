/**
 * Preview harness — seeds an in-memory DB with attention items (one
 * signature invite, one normal) and mounts the mini-app on :3847.
 * Used only for local UI verification. Not shipped.
 */
import { _initTestDatabase, getDb } from '../src/db.js';
import { createMiniAppServer } from '../src/mini-app/server.js';
import type { EmailMeta } from '../src/gmail-ops.js';

_initTestDatabase();
const db = getDb();

const now = Date.now();
const insert = db.prepare(
  `INSERT INTO tracked_items (
    id, source, source_id, group_name, state, classification,
    title, detected_at, digest_count, metadata, queue
  ) VALUES (?, 'gmail', ?, 'main', 'pushed', 'push', ?, ?, 0, ?, 'attention')`,
);

insert.run(
  'preview-sign-1',
  'gmail:thread-sign',
  'You are invited to sign an electronic document — MSA',
  now - 2 * 3600_000,
  JSON.stringify({
    account: 'topcoder1@gmail.com',
    sender: 'DocuSign System <dse_NA4@docusign.net>',
  }),
);

insert.run(
  'preview-normal-1',
  'gmail:thread-release',
  '[GitHub] ChatGPT Codex Connector is released',
  now - 2 * 3600_000,
  JSON.stringify({
    account: 'topcoder1@gmail.com',
    sender: 'noreply@github.com',
  }),
);

insert.run(
  'preview-sign-subj-1',
  'gmail:thread-subj',
  'Please sign: updated lease agreement',
  now - 1 * 3600_000,
  JSON.stringify({
    account: 'topcoder1@gmail.com',
    sender: 'legal@counterparty.com',
  }),
);

// Stub gmailOps so the email detail route can render with a canned body
// that triggers the sign-URL detector.
const stubGmailOps = {
  getMessageBody: async (_account: string, id: string) => {
    if (id.includes('thread-sign')) {
      return 'Hi Jonathan,\n\nPlease review and sign: https://na4.docusign.net/Signing/EmailStart.aspx?a=preview\n\nThanks';
    }
    return 'Hello — this is a normal email body with no signing link.';
  },
  getMessageMeta: async (_account: string, id: string): Promise<EmailMeta> => ({
    subject: id.includes('thread-sign')
      ? 'You are invited to sign an electronic document — MSA'
      : 'Other email',
    from: id.includes('thread-sign')
      ? 'DocuSign System <dse_NA4@docusign.net>'
      : 'someone@example.com',
    to: 'topcoder1@gmail.com',
    date: 'Mon, 20 Apr 2026 22:33:05 +0000',
    body: id.includes('thread-sign')
      ? 'Hi Jonathan,\n\nPlease review and sign: https://na4.docusign.net/Signing/EmailStart.aspx?a=preview\n\nThanks'
      : 'Hello — this is a normal email body with no signing link.',
  }),
  getThreadInboxStatus: async () => 'in' as const,
};

const port = Number(process.env.PORT) || 3848;
const app = createMiniAppServer({
  port,
  db,
  gmailOps: stubGmailOps as unknown as Parameters<
    typeof createMiniAppServer
  >[0]['gmailOps'],
});
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[preview] mini-app on http://localhost:${port}`);
});
