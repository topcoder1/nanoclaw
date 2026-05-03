# Brain Miniapp v1 — Design for Sign-off

**Status:** Draft for user review. No code until signed off.
**Date:** 2026-04-23
**Host:** NanoClaw miniapp (`src/mini-app/server.ts`)
**Phase:** v1 — read-only browsing + one-click feedback (mark important, approve/reject review). v2 later.

---

## 1. Architecture reality check (what's actually there)

I explored the codebase before writing this. The miniapp is NOT what I originally assumed:

- **Server-rendered HTML**, not React. Express route → template literal string → `res.type('html').send(...)`. See `src/mini-app/server.ts:191-287` for the pattern.
- **No bundler, no build step, no node_modules beyond Express.** The entire miniapp ships as TypeScript that renders HTML strings at request time.
- **Inline `<style>` and `<script>` blocks** per page. System font, `#f4f6f8` bg, `#0366d6` links.
- **Auth:** none visible — miniapp trusts the tunnel URL. No Telegram `initData` HMAC validation. (This is a security gap worth noting but out of scope for brain v1.)
- **Live updates:** the existing home page polls `/api/queue/status` every 15s and reloads if fingerprint changed (`server.ts:221-248`). Brain tabs will use the same pattern.

**Implication:** Brain miniapp v1 is **much cheaper to build than I initially estimated** — no React bolt-on, no API design, no auth layer. Just add Express routes to `createMiniAppServer` and render HTML from `brain.db` queries.

---

## 2. Goals (v1)

1. **Transparent ingestion** — see what the brain is doing in real time, navigable beyond the `/brainstream` command tail.
2. **Exploratory search** — query the brain with filters (date, source, entity) that don't fit in Telegram text.
3. **Entity directory** — browse people, companies, projects — click through to their KUs.
4. **KU detail** — full text, source link, confidence, bitemporal info, mentioned entities.
5. **Review queue** — work through `needs_review=1` KUs with one-click approve/reject.
6. **One-click feedback** — mark KU as "important" (boosts `access_count` in retrieval) directly from detail page.

**Out of scope for v1** (→ v2+):

- Manual entity merge UI
- Trigger dashboard with historical charts
- Decay config sliders
- Extraction rule editor
- Settings page

---

## 3. Pages / routes

All served by `createMiniAppServer` in `src/mini-app/server.ts`. New routes live in a new `src/mini-app/brain-routes.ts` and mount as a sub-router at `/brain`.

```
GET  /brain                    → home: search box + quick stats + tabs
GET  /brain/search?q=&...       → results list
GET  /brain/entities            → entity directory (filter by type)
GET  /brain/entities/:id        → entity detail: aliases + timeline of linked KUs
GET  /brain/ku/:id              → KU detail: full text + entities + source link + feedback buttons
GET  /brain/review              → `needs_review=1` queue
GET  /brain/timeline            → last 100 events (expanded /brainstream)

POST /api/brain/ku/:id/important → toggles "important" flag (boosts access_count)
POST /api/brain/ku/:id/approve   → sets needs_review=0 + confidence=1
POST /api/brain/ku/:id/reject    → sets superseded_at=now
POST /api/brain/search           → rich search (same params as GET; POST for future complex filters)

GET  /api/brain/status           → fingerprint JSON for polling refresh (like /api/queue/status)
```

---

## 4. Page details

### 4.1 `/brain` — home

Top nav (persistent across brain pages):

```
[ 🧠 Brain ]  Search · Entities · Review (3) · Timeline · Home
```

Below the nav:

- **Big search box** (submits to `/brain/search`).
- **Quick stats card**: KUs, entities, raw_events (last 24h), cost MTD.
- **Recent activity** (last 5 events, links to timeline for more).
- **Needs review indicator** badge: "3 KUs awaiting review" → link.

Visual: same `#f4f6f8` + white card aesthetic as existing home. Add a subtle brain icon in the H1.

### 4.2 `/brain/search`

Query params:

- `q` — search text (required, mandatory for query)
- `source` — filter by source_type (`email`, `gong`, `hubspot`, `tracked_item`, ...) — multi-value
- `entity` — filter by entity_id
- `account` — `personal` | `work` (default `work`)
- `from` / `to` — date range (ISO)
- `limit` — default 20, cap 50

Server: calls `recall(q, { account, limit, ... })` from `src/brain/retrieve.ts` — reuses P1's full retrieval pipeline including RRF + rerank + recency + access. Filters applied to the candidate set post-retrieval OR as Qdrant payload filters (depending on filter type).

Result row (matches existing list styling):

```
┌──────────────────────────────────────────────────────────────────┐
│ Subject or first 80 chars of text                        2d ago   │
│ source: email · Acme Corp · confidence 0.87                       │
│ "... snippet matching the query ..."                              │
└──────────────────────────────────────────────────────────────────┘
```

Click → `/brain/ku/:id`.

Empty query (first visit) → show "Enter a query to search the brain" + recent searches (future; v1 just shows the prompt).

### 4.3 `/brain/entities`

Filter tabs at top: `All · People · Companies · Projects · Products · Topics`.

Below: paginated list sorted by `COUNT(ku_entities)` DESC (most-mentioned first).

Row:

```
┌──────────────────────────────────────────────────────────────────┐
│ Alice Smith                                       person · 47 KUs │
│ acme.com · alice@acme.com · (phone: +1...)                        │
└──────────────────────────────────────────────────────────────────┘
```

Click → `/brain/entities/:id`.

### 4.4 `/brain/entities/:id`

Header: entity name + type badge.
Aliases section: all `entity_aliases` rows for this id with `valid_from`/`valid_until` (shows employer changes, email changes, etc.).
Relationships: any `entity_relationships` rows (works_at, reports_to, etc.).
Timeline: reverse-chron list of KUs linked to this entity via `ku_entities`. Each row links to `/brain/ku/:id`.

This is where Zep/Graphiti-style "what did I know about X on date Y" comes alive — v1 shows timeline-order; v2 can add a date-anchor jumper.

### 4.5 `/brain/ku/:id`

Full KU detail page:

```
Header:   Subject or title (bold)
Meta:     source_type · account · scope · valid_from · recorded_at · confidence
Content:  text (preserving newlines, escaped HTML)
Entities: pills of linked entities (clickable → entity page)
Source:   deep link to original email thread / Gong call / HubSpot deal (opens in new tab)
Extraction chain: if extracted_by is an LLM chain, show the chain of source KU ids (links)
Access:   access_count, last_accessed_at
Feedback: [ ⭐ Mark important ]  [ 🟢 Approve (if needs_review=1) ]  [ 🔴 Reject ]
```

Feedback buttons are inline JS posting to `POST /api/brain/ku/:id/...`.

### 4.6 `/brain/review`

List of KUs where `needs_review=1 AND superseded_at IS NULL`. Sorted by confidence ASC (lowest-confidence first — highest uncertainty).

Each row has inline buttons: approve / reject / view. No page navigation required for the common approve-flow.

Empty state: "Nothing to review — the brain is tidy."

### 4.7 `/brain/timeline`

Expanded version of `/brainstream` with pagination (50 per page) and filters (source, date range, entity).

Timeline entry (matches `/brainstream` formatting but richer):

```
┌──────────────────────────────────────────────────────────────────┐
│ 19:42  📧 email  thread_xyz  alice@acme.com                       │
│ → 2 KUs, 1 new entity (Acme Corp)                                 │
│ [KU: ...snippet 1] [KU: ...snippet 2]                             │
│ → embedding ok, qdrant ok                                         │
└──────────────────────────────────────────────────────────────────┘
```

KU snippets are clickable → `/brain/ku/:id`.

---

## 5. Feedback loop — how "important" affects ranking

`POST /api/brain/ku/:id/important` sets or toggles a new payload field on the Qdrant point AND a SQLite column on `knowledge_units`: `important INTEGER NOT NULL DEFAULT 0`.

Retrieval scoring gets a small tweak in `src/brain/retrieve.ts`:

```
final = 0.7·rank + 0.15·recency + 0.1·access + 0.05·important_boost
```

Where `important_boost = important ? 1.0 : 0.0`.

**Schema migration:** one new column `knowledge_units.important INTEGER NOT NULL DEFAULT 0` + index `CREATE INDEX IF NOT EXISTS idx_ku_important ON knowledge_units(important) WHERE important = 1`. Add to `src/brain/schema.sql`.

**Approve** updates: `needs_review=0, confidence=1.0`.
**Reject** updates: `superseded_at=<now>`. KU disappears from retrieval but stays in DB (bitemporal honesty — we don't delete).

---

## 6. Styling conventions

Match existing `src/mini-app/server.ts` exactly. CSS block shared across brain pages via a helper:

```ts
// src/mini-app/templates/brain-layout.ts
export function brainShell(title: string, body: string, opts?): string {
  return `<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${sharedCss}</style>
  </head><body>
  <nav>...brain tab links...</nav>
  ${body}
  </body></html>`;
}
```

Shared CSS pulls from existing home page plus adds:

- `.pill` for entity/source badges
- `.confidence-bar` 0-1 visual indicator
- `.feedback-btn` styling for ⭐ / 🟢 / 🔴 buttons
- No new colors; reuse `#0366d6` blue + neutral grays

---

## 7. Data access

Directly query `brain.db` via `getBrainDb()` (from `src/brain/db.ts`). All reads are indexed (schema has the indexes already).

For `/brain/search`, reuse `recall()` from `src/brain/retrieve.ts`. This gives us RRF + rerank + recency + access for free.

Access-count bump from clicking into a KU — add a side-effect in the `/brain/ku/:id` route: `UPDATE knowledge_units SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`. Same behavior as `recall()` bumps today. **Important**: write via the existing `AsyncWriteQueue` so it respects the serializer.

---

## 8. Live updates

Follow the existing `/api/queue/status` pattern. Each brain page that shows lists polls `/api/brain/status?page=search|entities|review|timeline` every 15s. Fingerprint = sorted ids of currently-visible items. If changed, reload.

Review page additionally polls on window focus — this is where you'd leave the tab open while working.

---

## 9. Auth

**v1 inherits existing miniapp auth** — which is "trust the tunnel URL." This isn't ideal but:

- Existing miniapp is already this way (attention queue, archive queue, email bodies are all already served without auth)
- Brain exposes no more sensitive data than email bodies already do
- Proper Telegram initData HMAC validation is a **separate cross-cutting concern** that should land for the whole miniapp, not just the brain tab

Flag this explicitly in the spec: once HMAC auth lands for the existing routes, brain inherits it automatically because it's on the same Express app.

---

## 10. Testing

Vitest, same style as `src/__tests__/mini-app-server.test.ts` / `src/__tests__/mini-app-routes.test.ts`:

- `src/__tests__/mini-app-brain-routes.test.ts` — supertest against `createMiniAppServer` with seeded `brain.db`:
  - GET `/brain` → 200, HTML contains nav + search box
  - GET `/brain/search?q=alice` → 200, contains at least one result
  - GET `/brain/entities` → 200, lists seeded entities
  - GET `/brain/entities/:id` → 200, shows aliases + timeline
  - GET `/brain/ku/:id` → 200, shows all metadata fields + feedback buttons
  - GET `/brain/ku/:id` → side effect: access_count bumped
  - GET `/brain/review` → 200, only shows `needs_review=1`
  - POST `/api/brain/ku/:id/important` → updates DB, returns 200
  - POST `/api/brain/ku/:id/approve` → sets `needs_review=0, confidence=1`
  - POST `/api/brain/ku/:id/reject` → sets `superseded_at`
  - GET `/brain/search?q=` (empty) → 200 with "enter query" prompt

- `src/__tests__/mini-app-brain-scoring.test.ts` — unit test that the retrieval formula includes `important_boost`:
  - Two KUs identical except one has `important=1` → important one ranks higher.

---

## 11. Implementation plan — 1 executor session, ~1500 LOC

8 atomic commits in this order:

1. `feat(brain): add important column + index to knowledge_units schema` — schema.sql + db migration + simple read/write helpers in a new `src/brain/important.ts` (uses AsyncWriteQueue)
2. `feat(brain): add important_boost to retrieval scoring` — updates `retrieve.ts` final score formula + test
3. `feat(brain-miniapp): new brain-routes module skeleton mounted at /brain` — empty route handlers + nav shell + shared CSS helper
4. `feat(brain-miniapp): /brain home page with stats + search box + quick recent`
5. `feat(brain-miniapp): /brain/search route via recall()` + client-side search submit UX
6. `feat(brain-miniapp): /brain/entities + /brain/entities/:id` (directory + detail)
7. `feat(brain-miniapp): /brain/ku/:id detail page + feedback POST endpoints`
8. `feat(brain-miniapp): /brain/review + /brain/timeline + live-update polling`

Each commit is self-contained with unit tests and leaves the tree green.

---

## 12. Migration impact

- New schema column `important` on `knowledge_units`. Idempotent ALTER via the existing db init pattern.
- New Qdrant payload field `important: boolean` — backfilled lazily: whenever `POST .../important` fires, the Qdrant point gets its payload updated. Pre-existing points have no `important` field, treated as `false`.
- No destructive changes. No data loss. No re-embedding required.

---

## 13. What comes after v1

**v2 (after 1-2 weeks of v1 usage):**

- Trigger dashboard with current/threshold/trajectory for v2 §13 re-eval triggers
- Manual entity merge UI (`entity_merge_log` with `merged_by='human:user_id'`)
- Cost/trend charts over 7/30/90d

**v3 (after measurement phase):**

- Decay half-life slider per query-intent category
- Extraction rule editor for `extractCheap` patterns
- Settings page for budget caps + alert thresholds

---

## 14. Open questions

1. **New brain-routes file vs. extending `server.ts`?** My strong recommendation: new `src/mini-app/brain-routes.ts` mounted as a sub-router. `server.ts` is already 1130 lines. OK?
2. **Client-side JS — stay inline per page, or factor out?** Inline matches current style and keeps the miniapp zero-build. Recommend inline for v1.
3. **Authentication** — v1 inherits "no auth" from existing miniapp. Acceptable for v1, or do you want initData HMAC as a prerequisite? (If yes, that's a separate scope item.)
4. **Review queue reject semantics** — "reject" = `superseded_at=now` (KU vanishes from retrieval but preserved for audit). Acceptable, or do you want hard-delete?
5. **Important-boost weight in final score (5%)** — start small, tune after measurement. OK default?
6. **Telegram deep-link from bot alerts to miniapp** — future work. Not in v1 scope. OK to defer?

---

## 15. Ship decision

If you green-light v1:

- I spawn an executor with this spec
- 8 commits, targeting ~1500 LOC
- Full review pass (Opus) before merge
- Merge + restart + verify with real brain.db (392 migrated KUs give us a populated playground)
- ETA: 3–5 hours of executor work

**Go / no-go / change what?**
