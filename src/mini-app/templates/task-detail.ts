import { escapeHtml } from './escape.js';

export interface TaskStep {
  label: string;
  status: 'done' | 'active' | 'pending';
  output: string | null;
}

export interface TaskLog {
  time: string;
  level: 'success' | 'error' | 'info' | 'warn';
  text: string;
}

export interface TaskDetailData {
  taskId: string;
  title: string;
  status: 'active' | 'blocked' | 'complete';
  steps: TaskStep[];
  logs: TaskLog[];
  startedAt: string;
  findings?: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  success: '#3fb950',
  error: '#f85149',
  info: '#58a6ff',
  warn: '#f0883e',
};

const STATUS_ICONS: Record<string, string> = {
  done: '✓',
  active: '●',
  pending: '○',
};

export function renderTaskDetail(data: TaskDetailData): string {
  const stepsHtml = data.steps
    .map((s) => {
      const icon = STATUS_ICONS[s.status] || '○';
      const outputBlock = s.output
        ? `<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px;margin-top:4px;font-family:monospace;font-size:11px;color:#8b949e;">${escapeHtml(s.output)}</div>`
        : '';
      return `<div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex-shrink:0;font-size:14px;">${icon}</div><div><div style="font-size:14px;color:#c9d1d9;">${escapeHtml(s.label)}</div>${outputBlock}</div></div>`;
    })
    .join('');

  const logsHtml = data.logs
    .map((l) => {
      const color = LEVEL_COLORS[l.level] || '#8b949e';
      return `<div><span style="color:#484f58;">${escapeHtml(l.time)}</span> <span style="color:${color};">●</span> ${escapeHtml(l.text)}</div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 600; }
    .status { font-size: 12px; color: #f0883e; text-transform: uppercase; margin-bottom: 4px; }
    .logs { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; line-height: 1.6; max-height: 200px; overflow-y: auto; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body data-updated-at="${escapeHtml(data.startedAt)}">
  <div class="header">
    <div class="status">${escapeHtml(String(data.status).toUpperCase())}</div>
    <div class="title">${escapeHtml(data.title)}</div>
  </div>
  <div id="steps-slot" style="margin-bottom:16px;">${stepsHtml}</div>
  <div id="logs-slot" class="logs">${logsHtml}</div>
  <div class="actions">
    <button class="btn">Pause</button>
    <button class="btn" style="color:#f85149;">Abort</button>
  </div>
  <script>
    const taskId = ${JSON.stringify(data.taskId)};
    const STATUS_ICONS = { done: '\u2713', active: '\u25CF', pending: '\u25CB' };
    const LEVEL_COLORS = {
      success: '#3fb950',
      error: '#f85149',
      info: '#58a6ff',
      warn: '#f0883e',
    };
    const evtSource = new EventSource('/api/task/' + encodeURIComponent(taskId) + '/stream');

    function escText(s) {
      const d = document.createElement('div');
      d.textContent = String(s == null ? '' : s);
      return d.innerHTML;
    }

    function renderSteps(steps) {
      if (!Array.isArray(steps)) return '';
      return steps.map(function(s) {
        const icon = STATUS_ICONS[s.status] || '\u25CB';
        const outputBlock = s.output
          ? '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px;margin-top:4px;font-family:monospace;font-size:11px;color:#8b949e;">' + escText(s.output) + '</div>'
          : '';
        return '<div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex-shrink:0;font-size:14px;">' + icon + '</div><div><div style="font-size:14px;color:#c9d1d9;">' + escText(s.label) + '</div>' + outputBlock + '</div></div>';
      }).join('');
    }

    function renderLogs(logs) {
      if (!Array.isArray(logs)) return '';
      return logs.map(function(l) {
        const color = LEVEL_COLORS[l.level] || '#8b949e';
        return '<div><span style="color:#484f58;">' + escText(l.time) + '</span> <span style="color:' + color + ';">\u25CF</span> ' + escText(l.text) + '</div>';
      }).join('');
    }

    function applyState(state) {
      const statusEl = document.querySelector('.status');
      if (statusEl && state.status) {
        statusEl.textContent = String(state.status).toUpperCase();
      }
      const titleEl = document.querySelector('.title');
      if (titleEl && state.title && titleEl.textContent !== state.title) {
        titleEl.textContent = state.title;
      }
      const stepsSlot = document.getElementById('steps-slot');
      if (stepsSlot && state.steps_json) {
        try { stepsSlot.innerHTML = renderSteps(JSON.parse(state.steps_json)); } catch (e) { /* keep prior DOM */ }
      }
      const logsSlot = document.getElementById('logs-slot');
      if (logsSlot && state.log_json) {
        try {
          logsSlot.innerHTML = renderLogs(JSON.parse(state.log_json));
          logsSlot.scrollTop = logsSlot.scrollHeight;
        } catch (e) { /* keep prior DOM */ }
      }
    }

    evtSource.onmessage = function(event) {
      let state;
      try { state = JSON.parse(event.data); } catch (e) { return; }
      if (!state) return;
      if (state.updated_at === document.body.dataset.updatedAt) return;
      document.body.dataset.updatedAt = state.updated_at;
      applyState(state);
    };

    evtSource.addEventListener('complete', function() {
      evtSource.close();
      const statusEl = document.querySelector('.status');
      if (statusEl) {
        statusEl.textContent = 'COMPLETE';
        statusEl.style.color = '#3fb950';
      }
    });

    evtSource.onerror = function() {
      evtSource.close();
    };
  </script>
</body>
</html>`;
}
