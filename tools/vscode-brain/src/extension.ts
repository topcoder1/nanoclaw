/**
 * vscode-brain — three commands that query the NanoClaw second-brain from
 * inside VS Code:
 *
 *   - Brain: recall this symbol      — word under cursor
 *   - Brain: recall selection        — current selection
 *   - Brain: open this repo's journal — opens <git-root>/docs/journal.md
 *
 * The first two hit GET /api/brain/recall on the brain miniapp (default
 * localhost:3847) and render results in a side webview. Clicking a repo
 * hit opens the file at the right line; clicking an email/note hit deep-
 * links to /brain/ku/<id> in the system browser, where richer entity
 * metadata is browseable.
 *
 * Why this is worth its own surface (not just the chat /recall command):
 * answers come back without round-tripping through chat, and the symbol-
 * boundary chunking shipped in claw v1.3b means a query for a function
 * name actually lands inside that function's chunk.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface RecallHit {
  ku_id: string;
  text: string;
  source_type: string;
  source_ref: string | null;
  finalScore: number;
  rankScore: number;
  recencyScore: number;
  recorded_at: string;
}

interface RecallResponse {
  query: string;
  count: number;
  results: RecallHit[];
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function readToken(): string {
  const cfg = vscode.workspace.getConfiguration('brain');
  const tokenPath = expandTilde(cfg.get<string>('serviceTokenPath') || '');
  if (!tokenPath) return '';
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    // Loopback works without a token — the brain endpoint short-circuits
    // auth for IPs in {127.0.0.1, ::1, ''}. If the user has pointed
    // brain.apiUrl at a non-localhost host, missing token will surface as
    // a 401 from the server, which we render in the webview as-is.
    return '';
  }
}

async function callRecall(query: string): Promise<RecallResponse | string> {
  const cfg = vscode.workspace.getConfiguration('brain');
  const base = (cfg.get<string>('apiUrl') || 'http://localhost:3847/api/brain').replace(/\/$/, '');
  const limit = cfg.get<number>('limit') ?? 10;
  const token = readToken();

  const url = `${base}/recall?q=${encodeURIComponent(query)}&limit=${limit}`;
  const headers: Record<string, string> = {};
  if (token) headers['x-service-token'] = token;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return `Brain API ${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
    return (await res.json()) as RecallResponse;
  } catch (err) {
    return `Brain API unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function typeTag(sourceType: string): string {
  switch (sourceType) {
    case 'email': return '✉️ email';
    case 'repo':  return '📄 repo';
    case 'note':  return '📝 note';
    default:      return `🧠 ${sourceType}`;
  }
}

/** Parse a repo source_ref like `repo_name:path/to/file.ts#L20-L40` into
 * components so we can convert it back into a file URI on click. The
 * path is interpreted relative to a workspace folder whose basename
 * matches `repo_name`. Returns null for unknown shapes. */
function parseRepoRef(ref: string): { repo: string; relPath: string; startLine?: number; endLine?: number } | null {
  const m = /^([^:]+):([^#]+)(?:#L(\d+)-L(\d+))?$/.exec(ref);
  if (!m) return null;
  return {
    repo: m[1],
    relPath: m[2],
    startLine: m[3] ? parseInt(m[3], 10) : undefined,
    endLine:   m[4] ? parseInt(m[4], 10) : undefined,
  };
}

function findWorkspaceRepo(repoName: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find(
    (f) => path.basename(f.uri.fsPath) === repoName,
  );
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderResults(query: string, response: RecallResponse | string, base: string): string {
  if (typeof response === 'string') {
    return `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:16px">
      <h2>Recall failed</h2>
      <p>${htmlEscape(response)}</p>
      <p class="hint">Is the brain miniapp running? Check <code>launchctl list | grep nanoclaw</code>.</p>
    </body></html>`;
  }

  const cfg = vscode.workspace.getConfiguration('brain');
  const floor = cfg.get<number>('scoreFloor') ?? 0.2;
  const hits = response.results.filter((h) => h.finalScore >= floor);

  const items = hits.map((h) => {
    const tag = typeTag(h.source_type);
    const score = h.finalScore.toFixed(2);
    const date = h.recorded_at.slice(0, 10);
    const firstLine = h.text.split('\n', 1)[0].slice(0, 110);
    const snippet = h.text.split('\n').slice(0, 4).join('\n').slice(0, 320);
    const ref = h.source_ref ?? '';
    // Repo hits get a click handler that posts to the extension to open
    // the file at the right line; everything else opens the miniapp KU
    // page so you get entities/chain/feedback buttons.
    const action = h.source_type === 'repo' && ref
      ? `data-action="open-repo" data-ref="${htmlEscape(ref)}"`
      : `data-action="open-ku" data-ku="${htmlEscape(h.ku_id)}"`;
    const subtitle = h.source_type === 'repo' && ref
      ? htmlEscape(ref)
      : htmlEscape(firstLine);
    return `
      <div class="hit" ${action} role="button" tabindex="0">
        <div class="row1">
          <span class="tag">${htmlEscape(tag)}</span>
          <span class="score">score ${score}</span>
          <span class="date">${htmlEscape(date)}</span>
        </div>
        <div class="subtitle">${subtitle}</div>
        <pre class="snippet">${htmlEscape(snippet)}</pre>
      </div>`;
  }).join('');

  const empty = hits.length === 0
    ? `<p class="empty">No hits above the score floor (${floor}). Try lowering <code>brain.scoreFloor</code> or rephrasing.</p>`
    : '';

  return `<!doctype html><html><head><style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    h2 { margin: 0 0 4px 0; font-size: 13px; font-weight: 600; }
    .query { color: var(--vscode-descriptionForeground); margin-bottom: 12px; word-wrap: break-word; }
    .hit { padding: 10px; margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; }
    .hit:hover { background: var(--vscode-list-hoverBackground); }
    .row1 { display: flex; gap: 10px; align-items: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .tag { font-weight: 600; color: var(--vscode-foreground); }
    .subtitle { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
    .snippet { font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; margin: 4px 0 0 0; color: var(--vscode-descriptionForeground); max-height: 80px; overflow: hidden; }
    .empty { color: var(--vscode-descriptionForeground); }
  </style></head><body>
    <h2>${hits.length} hit${hits.length === 1 ? '' : 's'} for</h2>
    <div class="query">${htmlEscape(response.query)}</div>
    ${items}${empty}
    <script>
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('.hit').forEach((el) => {
        const fire = () => {
          const action = el.getAttribute('data-action');
          if (action === 'open-repo') {
            vscode.postMessage({ type: 'open-repo', ref: el.getAttribute('data-ref') });
          } else {
            vscode.postMessage({ type: 'open-ku', ku: el.getAttribute('data-ku'), base: ${JSON.stringify(base)} });
          }
        };
        el.addEventListener('click', fire);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(); });
      });
    </script>
  </body></html>`;
}

let panel: vscode.WebviewPanel | undefined;

function showResults(query: string, response: RecallResponse | string): void {
  const cfg = vscode.workspace.getConfiguration('brain');
  const base = (cfg.get<string>('apiUrl') || 'http://localhost:3847/api/brain').replace(/\/api\/brain$/, '');
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'brainRecall',
      'Brain',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(handleMessage);
  }
  panel.title = `Brain · ${query.slice(0, 30)}`;
  panel.webview.html = renderResults(query, response, base);
  panel.reveal(vscode.ViewColumn.Beside, true);
}

async function handleMessage(msg: { type: string; ref?: string; ku?: string; base?: string }): Promise<void> {
  if (msg.type === 'open-repo' && msg.ref) {
    const parsed = parseRepoRef(msg.ref);
    if (!parsed) {
      vscode.window.showWarningMessage(`Brain: cannot parse source_ref "${msg.ref}"`);
      return;
    }
    const wsRoot = findWorkspaceRepo(parsed.repo);
    if (!wsRoot) {
      vscode.window.showWarningMessage(
        `Brain: repo "${parsed.repo}" not in this workspace. Open it as a folder to enable click-through.`,
      );
      return;
    }
    const fileUri = vscode.Uri.joinPath(wsRoot.uri, parsed.relPath);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    if (parsed.startLine) {
      const line = Math.max(0, parsed.startLine - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    }
  } else if (msg.type === 'open-ku' && msg.ku && msg.base) {
    vscode.env.openExternal(vscode.Uri.parse(`${msg.base}/brain/ku/${encodeURIComponent(msg.ku)}`));
  }
}

async function recallSymbol(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Brain: no active editor.');
    return;
  }
  const range = editor.document.getWordRangeAtPosition(editor.selection.active);
  if (!range) {
    vscode.window.showInformationMessage('Brain: no symbol under cursor — try "Brain: recall selection" instead.');
    return;
  }
  const symbol = editor.document.getText(range);
  // Pad with the filename so a recall on a generic identifier ("init",
  // "handler") at least gets some scope. Symbol-aware chunks (claw v1.3b)
  // means hits will land inside the chunk that contains this symbol.
  const filename = path.basename(editor.document.uri.fsPath);
  const query = `${symbol} ${filename}`;
  await runQuery(query);
}

async function recallSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Brain: no active editor.');
    return;
  }
  const text = editor.document.getText(editor.selection).trim();
  if (!text) {
    vscode.window.showInformationMessage('Brain: empty selection. Highlight some text first.');
    return;
  }
  // Cap: recall queries get tokenized + embedded, very long inputs are
  // wasteful. 500 chars is plenty for "what do I know about THIS BLOCK".
  await runQuery(text.slice(0, 500));
}

async function runQuery(query: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Brain: recall "${query.slice(0, 40)}"` },
    async () => {
      const response = await callRecall(query);
      showResults(query, response);
    },
  );
}

async function openJournal(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  // Prefer the active editor's workspace folder; fall back to the first
  // workspace root. Looking up git root with a child_process is overkill
  // when the user is almost certainly already in a workspace folder.
  let folder: vscode.WorkspaceFolder | undefined;
  if (editor) {
    folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  }
  if (!folder) {
    folder = vscode.workspace.workspaceFolders?.[0];
  }
  if (!folder) {
    vscode.window.showWarningMessage('Brain: open a folder first.');
    return;
  }
  const journal = vscode.Uri.joinPath(folder.uri, 'docs', 'journal.md');
  try {
    await vscode.workspace.fs.stat(journal);
  } catch {
    const choice = await vscode.window.showInformationMessage(
      `Brain: no journal at ${journal.fsPath}. Generate one with \`claw journal ${path.basename(folder.uri.fsPath)}\`?`,
      'Run claw journal',
    );
    if (choice === 'Run claw journal') {
      const term = vscode.window.createTerminal({ name: 'claw journal', cwd: folder.uri.fsPath });
      term.show();
      term.sendText(`claw journal ${path.basename(folder.uri.fsPath)}`);
    }
    return;
  }
  const doc = await vscode.workspace.openTextDocument(journal);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('brain.recallSymbol', recallSymbol),
    vscode.commands.registerCommand('brain.recallSelection', recallSelection),
    vscode.commands.registerCommand('brain.openJournal', openJournal),
  );
}

export function deactivate(): void {
  panel?.dispose();
  panel = undefined;
}
