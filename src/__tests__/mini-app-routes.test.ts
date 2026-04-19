import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createMiniAppServer } from '../mini-app/server.js';

describe('Mini App extended routes', () => {
  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE task_detail_state (
        task_id TEXT PRIMARY KEY, title TEXT, status TEXT,
        steps_json TEXT DEFAULT '[]', log_json TEXT DEFAULT '[]', started_at TEXT
      );
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY, account TEXT, original_body TEXT,
        enriched_at TEXT, expires_at TEXT
      );
      CREATE TABLE tracked_items (
        id TEXT PRIMARY KEY, source TEXT, source_id TEXT, group_name TEXT,
        state TEXT, title TEXT, thread_id TEXT, detected_at INTEGER,
        metadata TEXT
      );
    `);

    const mockGmailOps = {
      getMessageBody: vi.fn().mockResolvedValue('Full email body for test'),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };
    const mockDraftWatcher = {
      revert: vi.fn().mockResolvedValue(true),
    };

    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockGmailOps as any,
      draftWatcher: mockDraftWatcher as any,
    });

    return { app, db, mockGmailOps, mockDraftWatcher };
  }

  it('GET /email/:emailId returns HTML with fetched body', async () => {
    const { app, mockGmailOps } = setup();
    const res = await request(app).get('/email/msg123?account=personal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Full email body for test');
    expect(mockGmailOps.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg123',
    );
  });

  it('GET /email/:emailId renders real subject, from, to, date when getMessageMeta available', async () => {
    const { app, db, mockGmailOps } = setup();
    const metaMock = vi.fn().mockResolvedValue({
      subject: 'Hello from Test',
      from: 'sender@example.com',
      to: 'receiver@example.com',
      date: '2026-04-16T10:00:00Z',
      body: 'Test body content',
      cc: '',
    });
    (mockGmailOps as any).getMessageMeta = metaMock;
    const app2 = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockGmailOps as any,
      draftWatcher: undefined,
    });
    const res = await request(app2).get('/email/msg456?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hello from Test');
    expect(res.text).toContain('sender@example.com');
    expect(res.text).toContain('receiver@example.com');
    expect(res.text).toContain('2026-04-16T10:00:00Z');
    expect(metaMock).toHaveBeenCalledWith('personal', 'msg456');
  });

  it('GET /email/:emailId falls back to getMessageBody when getMessageMeta unavailable', async () => {
    const { app, mockGmailOps } = setup();
    // mockGmailOps does not have getMessageMeta
    const res = await request(app).get('/email/msg789?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Full email body for test');
    expect(mockGmailOps.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg789',
    );
  });

  it('GET /email/:emailId does not render raw script tags in body', async () => {
    const { app, db } = setup();
    // HTML-shaped body — routed through the iframe+sandbox path.
    const xssBody = '<div><script>alert("xss")</script></div>';
    const mockGmailOpsXss = {
      getMessageBody: vi.fn().mockResolvedValue(xssBody),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };
    const app2 = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockGmailOpsXss as any,
      draftWatcher: undefined,
    });
    const res = await request(app2).get('/email/xssmsg?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('sandbox');
  });

  it('GET /email/:emailId renders plain-text body as formatted HTML with clickable links', async () => {
    const { app, db } = setup();
    const plainBody =
      'Hello world.\n\nVisit https://example.com for details.\n\nCheers';
    const mockOps = {
      getMessageBody: vi.fn().mockResolvedValue(plainBody),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };
    const app2 = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockOps as any,
      draftWatcher: undefined,
    });
    const res = await request(app2).get('/email/plainmsg?account=personal');
    expect(res.status).toBe(200);
    // Bare URLs turned into anchors.
    expect(res.text).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener"',
    );
    // Paragraph structure preserved.
    expect(res.text).toMatch(/<p[^>]*>Hello world\.<\/p>/);
    // Must NOT use the plaintext-hostile iframe srcdoc path for plain bodies.
    expect(res.text).not.toContain('srcdoc="Hello world');
  });

  it('GET /email/:emailId escapes plain-text HTML-like fragments safely', async () => {
    const { app, db } = setup();
    const body = 'not html <script>alert(1)</script> end';
    const mockOps = {
      getMessageBody: vi.fn().mockResolvedValue(body),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };
    const app2 = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockOps as any,
      draftWatcher: undefined,
    });
    const res = await request(app2).get('/email/safemsg?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('GET /email/:emailId renders Open in Gmail as a link', async () => {
    const { app } = setup();
    const res = await request(app).get('/email/gmailmsg?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).toContain('mail.google.com');
    expect(res.text).toContain('gmailmsg');
  });

  it('GET /email/:emailId renders Archive button with data attributes', async () => {
    const { app } = setup();
    const res = await request(app).get('/email/archmsg?account=personal');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-email-id');
    expect(res.text).toContain('data-account');
    expect(res.text).toContain('archmsg');
    expect(res.text).toContain('personal');
  });

  it('POST /api/email/:emailId/archive calls gmailOps.archiveThread', async () => {
    const { app, mockGmailOps } = setup();
    (mockGmailOps.archiveThread as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    const res = await request(app)
      .post('/api/email/archmsg/archive')
      .send({ account: 'personal', threadId: 'thread123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockGmailOps.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread123',
    );
  });

  it('POST /api/email/:emailId/archive resolves Gmail thread id from tracked_items when not provided', async () => {
    const { app, db, mockGmailOps } = setup();
    (mockGmailOps.archiveThread as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    db.prepare(
      `INSERT INTO tracked_items (id, source, source_id, group_name, state, title, detected_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sse-123',
      'email',
      'gmail:19da1d9492abcdef',
      'g',
      'pending',
      't',
      Date.now(),
      JSON.stringify({ account: 'personal' }),
    );

    const res = await request(app)
      .post('/api/email/sse-123/archive')
      .send({ account: 'personal' });

    expect(res.status).toBe(200);
    expect(mockGmailOps.archiveThread).toHaveBeenCalledWith(
      'personal',
      '19da1d9492abcdef',
    );
  });

  it('GET /email/:emailId renders Open-in-Gmail URL scoped to the account and gmail id', async () => {
    const { app, db, mockGmailOps } = setup();
    db.prepare(
      `INSERT INTO tracked_items (id, source, source_id, group_name, state, title, detected_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sse-xyz',
      'email',
      'gmail:19da1d9492deadbeef',
      'g',
      'pending',
      't',
      Date.now(),
      JSON.stringify({ account: 'jonathan@attaxion.com' }),
    );
    (mockGmailOps as any).getMessageMeta = vi.fn().mockResolvedValue({
      subject: 'S',
      from: 'f',
      to: 't',
      date: 'd',
      body: 'B',
    });

    const res = await request(app).get('/email/sse-xyz');
    expect(res.status).toBe(200);
    // Path-position /u/EMAIL/ is what Gmail actually uses to route the right
    // account — ?authuser= alone is unreliable in practice (Gmail often
    // ignores it and falls back to account 0). Email is URL-encoded so the
    // "@" becomes %40.
    // Email must appear LITERAL — "%40" (percent-encoded @) makes Gmail 404.
    expect(res.text).toContain('/mail/u/jonathan@attaxion.com/');
    expect(res.text).not.toContain('/mail/u/jonathan%40attaxion.com/');
    // And the anchor must use the Gmail thread id, not nanoclaw's internal id.
    expect(res.text).toContain('#inbox/19da1d9492deadbeef');
    expect(res.text).not.toContain('#inbox/sse-xyz');
    // Must NOT hardcode /u/0/ — that forces Gmail's first-signed-in account,
    // which is the wrong inbox whenever account 0 isn't the target.
    expect(res.text).not.toContain('/mail/u/0/');
    // Archive button should carry data-thread-id with the resolved Gmail id.
    expect(res.text).toContain('data-thread-id="19da1d9492deadbeef"');
  });

  it('GET /draft-diff/:draftId shows diff view', async () => {
    const { app, db } = setup();
    db.prepare(
      `INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'd1',
      'personal',
      'Original draft text',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
    );

    const res = await request(app).get('/draft-diff/d1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Original draft text');
  });

  it('POST /api/draft/:draftId/revert calls draftWatcher.revert', async () => {
    const { app, mockDraftWatcher } = setup();
    const res = await request(app).post('/api/draft/d1/revert');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDraftWatcher.revert).toHaveBeenCalledWith('d1');
  });

  it('GET /draft-diff/:draftId returns 404 if not found', async () => {
    const { app } = setup();
    const res = await request(app).get('/draft-diff/nonexistent');
    expect(res.status).toBe(404);
  });
});
