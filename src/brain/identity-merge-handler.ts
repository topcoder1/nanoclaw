import type Database from 'better-sqlite3';
import { eventBus } from '../event-bus.js';
import type {
  EntityMergeRejectRequestedEvent,
  EntityMergeRequestedEvent,
  EntityMergeSuggestedEvent,
  EntityUnmergeRequestedEvent,
} from '../events.js';
import { logger } from '../logger.js';
import { getBrainDb } from './db.js';
import { mergeEntities, unmergeEntities } from './identity-merge.js';

export interface MergeHandlerOpts {
  db?: Database.Database;
  /**
   * Send an ack/error reply back to the source chat. Wired by chat-ingest
   * to the appropriate channel router. Tests capture into an array.
   */
  sendReply?: (text: string) => Promise<void>;
}

interface ResolvedCandidate {
  entity_id: string;
  reason: 'alias' | 'canonical_name' | 'id_prefix';
}

/**
 * Resolve a handle to person entity_ids.
 *   1. Exact alias match (case-insensitive on field_value, any field_name).
 *   2. Canonical name match (canonical->>'name' lowercased == handle lowered).
 * Returns ALL distinct matches so callers detect ambiguity.
 */
function resolveHandle(
  db: Database.Database,
  handle: string,
): ResolvedCandidate[] {
  const lowered = handle.trim().toLowerCase();
  if (!lowered) return [];

  const aliasHits = db
    .prepare(
      `SELECT DISTINCT entity_id FROM entity_aliases
        WHERE LOWER(field_value) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;

  const nameHits = db
    .prepare(
      `SELECT entity_id FROM entities
        WHERE entity_type = 'person'
          AND LOWER(json_extract(canonical, '$.name')) = ?`,
    )
    .all(lowered) as Array<{ entity_id: string }>;

  // 3. Entity-id prefix match (used by chat-suggestion replies, where the
  //    operator copy-pastes a short ULID prefix). Bounded to <=5 hits to
  //    prevent runaway results when an operator types a very short prefix.
  const prefixHits = db
    .prepare(
      `SELECT entity_id FROM entities
        WHERE entity_id LIKE ? || '%'
        LIMIT 5`,
    )
    .all(handle.trim()) as Array<{ entity_id: string }>;

  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const r of aliasHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'alias' });
      seen.add(r.entity_id);
    }
  }
  for (const r of nameHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'canonical_name' });
      seen.add(r.entity_id);
    }
  }
  for (const r of prefixHits) {
    if (!seen.has(r.entity_id)) {
      out.push({ entity_id: r.entity_id, reason: 'id_prefix' });
      seen.add(r.entity_id);
    }
  }
  return out;
}

export async function handleEntityMergeRequested(
  evt: EntityMergeRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const candA = resolveHandle(db, evt.handle_a);
  const candB = resolveHandle(db, evt.handle_b);

  if (candA.length === 0) {
    await reply(`claw merge: handle '${evt.handle_a}' not found`);
    return;
  }
  if (candB.length === 0) {
    await reply(`claw merge: handle '${evt.handle_b}' not found`);
    return;
  }
  if (candA.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_a}' is ambiguous (${candA.length} matches) — quote a more specific name or pass an entity_id`,
    );
    return;
  }
  if (candB.length > 1) {
    await reply(
      `claw merge: handle '${evt.handle_b}' is ambiguous (${candB.length} matches)`,
    );
    return;
  }

  const a = candA[0].entity_id;
  const b = candB[0].entity_id;
  if (a === b) {
    await reply(
      `claw merge: '${evt.handle_a}' and '${evt.handle_b}' already resolve to the same entity`,
    );
    return;
  }

  // Convention: keep the alphabetically-earlier entity_id (deterministic).
  const [keptId, mergedId] = a < b ? [a, b] : [b, a];

  // Pre-check: if either entity has previously participated in a merge
  // (as kept or merged side), surface a clear error rather than silently
  // creating a chain that mergeEntities only catches in one direction.
  const priorChain = db
    .prepare(
      `SELECT merge_id, kept_entity_id, merged_entity_id FROM entity_merge_log
        WHERE merged_entity_id = ? OR merged_entity_id = ?
           OR kept_entity_id   = ? OR kept_entity_id   = ?
        LIMIT 1`,
    )
    .get(keptId, mergedId, keptId, mergedId) as
    | { merge_id: string; kept_entity_id: string; merged_entity_id: string }
    | undefined;
  if (priorChain) {
    await reply(
      `claw merge: failed — one of these entities is already part of merge ${priorChain.merge_id.slice(0, 6)}… (kept=${priorChain.kept_entity_id.slice(0, 6)}…, merged=${priorChain.merged_entity_id.slice(0, 6)}…); resolve chain first`,
    );
    return;
  }

  try {
    const result = await mergeEntities(keptId, mergedId, {
      evidence: {
        trigger: 'manual',
        requested_by: evt.requested_by_handle,
        platform: evt.platform,
        chat_id: evt.chat_id,
      },
      confidence: 1.0,
      mergedBy: `human:${evt.requested_by_handle}`,
      db,
    });
    await reply(
      `claw merge: ✓ merged ${evt.handle_b} (${mergedId.slice(0, 6)}…) into ${evt.handle_a} (${keptId.slice(0, 6)}…) — log ${result.merge_id.slice(0, 6)}…`,
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), evt },
      'identity-merge-handler: merge failed',
    );
    await reply(
      `claw merge: failed — ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

interface MergeLogRow {
  merge_id: string;
  kept_entity_id: string;
  merged_entity_id: string;
}

/**
 * Handle `claw unmerge <merge_id_or_prefix> [--force]`. Resolves the prefix
 * to a unique entity_merge_log row, calls unmergeEntities, sends an ack.
 *
 *  - exact merge_id match wins outright
 *  - otherwise we match by `merge_id LIKE prefix||'%'`
 *  - if zero matches → user-friendly error
 *  - if 2+ matches → ambiguous (lists short ids), refuse
 *  - if guardrail blocks (post-merge ku_entities), tell operator about --force
 */
export async function handleEntityUnmergeRequested(
  evt: EntityUnmergeRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const prefix = evt.merge_id_or_prefix.trim();
  if (!prefix) {
    await reply(`claw unmerge: missing merge_id`);
    return;
  }

  // Try exact first, then prefix match.
  let row = db
    .prepare(
      `SELECT merge_id, kept_entity_id, merged_entity_id FROM entity_merge_log WHERE merge_id = ?`,
    )
    .get(prefix) as MergeLogRow | undefined;
  if (!row) {
    const matches = db
      .prepare(
        `SELECT merge_id, kept_entity_id, merged_entity_id FROM entity_merge_log
          WHERE merge_id LIKE ? || '%' LIMIT 5`,
      )
      .all(prefix) as MergeLogRow[];
    if (matches.length === 0) {
      await reply(`claw unmerge: no merge_log row matches '${prefix}'`);
      return;
    }
    if (matches.length > 1) {
      const ids = matches.map((m) => m.merge_id.slice(0, 8) + '…').join(', ');
      await reply(
        `claw unmerge: prefix '${prefix}' is ambiguous (${matches.length} matches: ${ids}) — pass a longer prefix`,
      );
      return;
    }
    row = matches[0];
  }

  try {
    // Read merged_by BEFORE unmerging — unmergeEntities deletes the row.
    const preLog = db
      .prepare(`SELECT merged_by FROM entity_merge_log WHERE merge_id = ?`)
      .get(row.merge_id) as { merged_by: string } | undefined;
    const wasAutoHigh = preLog?.merged_by?.startsWith('auto:') === true;

    const result = await unmergeEntities(row.merge_id, {
      db,
      force: evt.force ?? false,
    });

    if (wasAutoHigh) {
      const [a, b] = result.kept_entity_id < result.merged_entity_id
        ? [result.kept_entity_id, result.merged_entity_id]
        : [result.merged_entity_id, result.kept_entity_id];
      db.prepare(
        `INSERT OR IGNORE INTO entity_merge_suppressions
           (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
         VALUES (?, ?, NULL, 'unmerged_by_operator', ?)`,
      ).run(a, b, Date.now());
    }

    await reply(
      `claw unmerge: ✓ rolled back merge ${result.merge_id.slice(0, 6)}… — kept ${result.kept_entity_id.slice(0, 6)}…, restored ${result.merged_entity_id.slice(0, 6)}…`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: msg, merge_id: row.merge_id },
      'identity-merge-handler: unmerge failed',
    );
    if (msg.includes('added after the merge')) {
      await reply(
        `claw unmerge: refused — ${msg}. Append \` --force\` to override.`,
      );
    } else {
      await reply(`claw unmerge: failed — ${msg}`);
    }
  }
}

/**
 * Format a medium-confidence duplicate suggestion as a chat message and
 * send it via setIdentityMergeReply. The operator can accept by typing
 * `claw merge <a> <b>` or suppress with `claw merge-reject <a> <b>`.
 */
export async function handleEntityMergeSuggested(
  evt: EntityMergeSuggestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const reply = opts.sendReply ?? (async () => {});
  const a6 = evt.entity_id_a.slice(0, 6);
  const b6 = evt.entity_id_b.slice(0, 6);
  const nameA = (evt.evidence.canonical_a?.name as string | undefined) ?? '(unnamed)';
  const nameB = (evt.evidence.canonical_b?.name as string | undefined) ?? '(unnamed)';
  // Build a one-line "evidence tail" per side: pick the first non-name
  // canonical field for context. Falls back to empty.
  const tail = (canon: Record<string, unknown>): string => {
    for (const [k, v] of Object.entries(canon)) {
      if (k === 'name') continue;
      return ` — ${k}:${String(v)}`;
    }
    return '';
  };
  const text =
    `🔗 Possible duplicate (medium confidence)\n\n` +
    `A: ${nameA} (${a6}…)${tail(evt.evidence.canonical_a ?? {})}\n` +
    `B: ${nameB} (${b6}…)${tail(evt.evidence.canonical_b ?? {})}\n\n` +
    `Reply:\n` +
    `  claw merge ${a6} ${b6}        — confirm merge\n` +
    `  claw merge-reject ${a6} ${b6} — never suggest again`;
  await reply(text);
}

/**
 * Handle `claw merge-reject <a> <b>`. Writes a permanent suppression row
 * for the pair and flips any pending suggestion to `rejected`. Whether or
 * not a suggestion existed, the suppression is written so the operator
 * can pre-empt a future match.
 */
export async function handleEntityMergeRejectRequested(
  evt: EntityMergeRejectRequestedEvent,
  opts: MergeHandlerOpts = {},
): Promise<void> {
  const db = opts.db ?? getBrainDb();
  const reply = opts.sendReply ?? (async () => {});

  const candA = resolveHandle(db, evt.handle_a);
  const candB = resolveHandle(db, evt.handle_b);
  if (candA.length === 0) {
    await reply(`claw merge-reject: handle '${evt.handle_a}' not found`);
    return;
  }
  if (candB.length === 0) {
    await reply(`claw merge-reject: handle '${evt.handle_b}' not found`);
    return;
  }
  if (candA.length > 1) {
    await reply(
      `claw merge-reject: handle '${evt.handle_a}' is ambiguous (${candA.length} matches)`,
    );
    return;
  }
  if (candB.length > 1) {
    await reply(
      `claw merge-reject: handle '${evt.handle_b}' is ambiguous (${candB.length} matches)`,
    );
    return;
  }

  const aId = candA[0].entity_id;
  const bId = candB[0].entity_id;
  if (aId === bId) {
    await reply(`claw merge-reject: '${evt.handle_a}' and '${evt.handle_b}' resolve to the same entity`);
    return;
  }
  const [a, b] = aId < bId ? [aId, bId] : [bId, aId];

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO entity_merge_suppressions
         (entity_id_a, entity_id_b, suppressed_until, reason, created_at)
       VALUES (?, ?, NULL, 'operator_rejected', ?)`,
    ).run(a, b, Date.now());

    db.prepare(
      `UPDATE entity_merge_suggestions
          SET status = 'rejected', status_at = ?
        WHERE entity_id_a = ? AND entity_id_b = ? AND status = 'pending'`,
    ).run(Date.now(), a, b);
  })();

  await reply(
    `claw merge-reject: suppressed ${a.slice(0, 6)}… ↔ ${b.slice(0, 6)}… — will not suggest again`,
  );
}

let unsubMerge: (() => void) | null = null;
let unsubUnmerge: (() => void) | null = null;
let unsubSuggested: (() => void) | null = null;
let unsubReject: (() => void) | null = null;

/**
 * Channel-aware reply sender wired by index.ts after channels connect.
 * Stored as a module-level ref so the bus subscription (which has already
 * been registered by startIdentityMergeHandler) reads the latest function
 * at fire time. This keeps the wiring loose: chat-ingest doesn't need to
 * know about channel routing.
 */
type ChannelReply = (
  chat_id: string,
  platform: 'discord' | 'signal',
  text: string,
) => Promise<void>;

let channelReply: ChannelReply | null = null;

/**
 * Register a channel-aware reply sender. Called from index.ts after
 * channels connect. Idempotent — replaces any prior registration.
 */
export function setIdentityMergeReply(fn: ChannelReply | null): void {
  channelReply = fn;
}

export interface IdentityMergeStartOpts {
  /** Override the per-text reply (tests inject this; production uses setIdentityMergeReply). */
  sendReply?: (text: string) => Promise<void>;
}

export function startIdentityMergeHandler(
  opts: IdentityMergeStartOpts = {},
): void {
  if (unsubMerge || unsubUnmerge || unsubSuggested || unsubReject) return;
  unsubMerge = eventBus.on('entity.merge.requested', async (evt) => {
    try {
      // Per-event reply: prefer the explicit opts.sendReply (tests), else
      // build one from the channel-aware setter, else no-op.
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          ? (text: string) => channelReply!(evt.chat_id, evt.platform, text)
          : undefined);
      await handleEntityMergeRequested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: top-level error',
      );
    }
  });
  unsubUnmerge = eventBus.on('entity.unmerge.requested', async (evt) => {
    try {
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          ? (text: string) => channelReply!(evt.chat_id, evt.platform, text)
          : undefined);
      await handleEntityUnmergeRequested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: top-level error (unmerge)',
      );
    }
  });
  unsubSuggested = eventBus.on('entity.merge.suggested', async (evt) => {
    try {
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          // Suggestions go to the main group's channel — they're not tied
          // to any specific chat_id. The channelReply signature requires
          // chat_id + platform; we use the literals 'main' / 'signal' as
          // a sentinel that the channel layer interprets as "default to
          // the main group". Index.ts wires this when registering.
          ? (text: string) => channelReply!('main', 'signal', text)
          : undefined);
      await handleEntityMergeSuggested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: suggestion handler error',
      );
    }
  });
  unsubReject = eventBus.on('entity.merge.reject.requested', async (evt) => {
    try {
      const reply: ((text: string) => Promise<void>) | undefined =
        opts.sendReply ??
        (channelReply
          ? (text: string) => channelReply!(evt.chat_id, evt.platform, text)
          : undefined);
      await handleEntityMergeRejectRequested(evt, { sendReply: reply });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), evt },
        'identity-merge-handler: reject handler error',
      );
    }
  });
  logger.info('Identity merge handler started');
}

export function stopIdentityMergeHandler(): void {
  if (unsubMerge) {
    unsubMerge();
    unsubMerge = null;
  }
  if (unsubUnmerge) {
    unsubUnmerge();
    unsubUnmerge = null;
  }
  if (unsubSuggested) {
    unsubSuggested();
    unsubSuggested = null;
  }
  if (unsubReject) {
    unsubReject();
    unsubReject = null;
  }
}
