/**
 * Shared shell + CSS for every brain miniapp page.
 *
 * Keeps the markup DRY: nav bar, header, body slot, and the CSS that
 * backs pills, confidence bars, and feedback buttons live here. Each
 * route in `brain-routes.ts` renders its body in a template literal
 * and passes it to `brainShell`.
 *
 * Style rules (match existing home page in `mini-app/server.ts`):
 *   - system font, 16px/1.45
 *   - background #f4f6f8, text #111, links #0366d6
 *   - cards white with 10px rounding, 1px #eee row separators
 *   - no custom colors beyond the existing palette + neutral grays
 */

import { escapeHtml } from './escape.js';

export interface BrainShellOptions {
  /**
   * Which nav link to highlight. If omitted, no link is marked active.
   */
  activeNav?: 'home' | 'search' | 'entities' | 'review' | 'timeline';
  /**
   * Count for the "Review" badge in the nav (queue depth). Hidden when 0
   * to keep the nav quiet once the queue is drained.
   */
  reviewCount?: number;
}

/** Shared CSS. Inlined so no bundler / no asset pipeline is required. */
const SHARED_CSS = `
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:0;background:#f4f6f8;color:#111}
a{color:#0366d6;text-decoration:none}
a:hover{text-decoration:underline}
nav.brain{background:#fff;border-bottom:1px solid #e3e6ea;padding:10px 16px;display:flex;gap:16px;align-items:baseline;position:sticky;top:0;z-index:10}
nav.brain .brand{font-weight:600;font-size:15px;color:#111;margin-right:8px}
nav.brain a{color:#555;font-size:14px;padding:4px 2px;border-bottom:2px solid transparent}
nav.brain a.active{color:#0366d6;border-bottom-color:#0366d6}
nav.brain a .count{color:#888;font-size:12px}
main{padding:16px 16px 80px;max-width:900px;margin:0 auto}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:15px;margin:24px 0 8px;color:#444}
.card{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:12px}
.card ul,.card ol{list-style:none;padding:0;margin:0}
.card li{padding:10px 0;border-bottom:1px solid #eee}
.card li:last-child{border-bottom:none}
.empty{color:#888;font-style:italic;padding:10px 14px;background:#fff;border-radius:10px}
.meta{color:#666;font-size:13px}
.age{color:#888;font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:12px;background:#eef2f6;color:#445;font-size:12px;margin-right:4px}
.pill.source{background:#e7f0ff;color:#0b4aa3}
.pill.person{background:#fef1e6;color:#8a4b1a}
.pill.company{background:#e7f7ec;color:#1b5a2e}
.pill.project{background:#f1e7fb;color:#5a2c88}
.pill.product{background:#fbe7ef;color:#88275c}
.pill.topic{background:#eef2f6;color:#445}
.confidence-bar{display:inline-block;width:60px;height:6px;background:#eee;border-radius:3px;overflow:hidden;vertical-align:middle;margin:0 4px}
.confidence-bar>span{display:block;height:100%;background:#0366d6}
.feedback-btn{display:inline-block;background:#fff;border:1px solid #d0d7de;color:#111;padding:6px 12px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;margin-right:8px}
.feedback-btn:hover{background:#f6f8fa}
.feedback-btn.active{background:#fff8e1;border-color:#f2c744}
.feedback-btn.approve{color:#1b5a2e}
.feedback-btn.reject{color:#8a2323}
.feedback-btn[disabled]{opacity:0.5;cursor:not-allowed}
.row-link{color:inherit;text-decoration:none;display:block}
.row-link:hover{background:#f6f8fa}
.snippet{color:#555;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.searchbox{display:flex;gap:8px;margin:8px 0 16px}
.searchbox input[type=text]{flex:1;padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:15px}
.searchbox button{background:#0366d6;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}
.searchbox button:hover{background:#0255b3}
.badge{display:inline-block;background:#d9534f;color:#fff;border-radius:10px;font-size:11px;padding:1px 7px;margin-left:4px;font-weight:600}
`;

/**
 * Render the nav bar with the given active tab + review count.
 */
function renderNav(opts: BrainShellOptions): string {
  const active = opts.activeNav;
  const reviewCount = Math.max(0, opts.reviewCount ?? 0);
  const link = (
    id: Exclude<BrainShellOptions['activeNav'], undefined>,
    href: string,
    label: string,
    suffix = '',
  ) =>
    `<a href="${href}"${active === id ? ' class="active"' : ''}>${escapeHtml(label)}${suffix}</a>`;
  const reviewSuffix =
    reviewCount > 0 ? ` <span class="count">(${reviewCount})</span>` : '';
  return `<nav class="brain">
  <span class="brand">🧠 Brain</span>
  ${link('home', '/brain', 'Home')}
  ${link('search', '/brain/search', 'Search')}
  ${link('entities', '/brain/entities', 'Entities')}
  ${link('review', '/brain/review', 'Review', reviewSuffix)}
  ${link('timeline', '/brain/timeline', 'Timeline')}
</nav>`;
}

/**
 * Wrap a body fragment in the full brain HTML shell. Every brain route
 * calls this — keeps nav + CSS in one place.
 */
export function brainShell(
  title: string,
  body: string,
  opts: BrainShellOptions = {},
): string {
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHARED_CSS}</style>
</head><body>
${renderNav(opts)}
<main>
${body}
</main>
</body></html>`;
}

/**
 * Render a confidence bar for a value in [0, 1]. Out-of-range values are
 * clamped so malformed DB rows don't break layout.
 */
export function confidenceBar(value: number): string {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const pct = (v * 100).toFixed(0);
  return `<span class="confidence-bar" title="confidence ${v.toFixed(2)}"><span style="width:${pct}%"></span></span>`;
}

/**
 * "2d ago" style age formatter. Matches the existing home page aesthetic.
 */
export function formatAge(isoOrMs: string | number, nowMs = Date.now()): string {
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ts)) return '';
  const mins = Math.floor((nowMs - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}
