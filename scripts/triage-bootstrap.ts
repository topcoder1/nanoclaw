/**
 * Bootstrap triage skip-list and examples from historical email data.
 *
 * Fetches archived emails from SuperPilot, classifies each with the triage
 * classifier, and seeds `triage_skip_list` + `triage_examples` based on
 * classifier/user agreement.
 *
 * Data source: SuperPilot's `GET /api/nanoclaw/triaged-emails` endpoint.
 * TODO(v2): Gmail MCP fallback when SuperPilot is unavailable.
 *
 * Classification: the plan mentions the Anthropic Batch API for cost
 * efficiency, but for a one-off overnight seeding run we use serial calls
 * through the existing `classifyWithLlm` (same code path as production)
 * with a small inter-call delay. This keeps the script simple, reuses the
 * tested tier-escalation + prompt-caching pipeline, and the cost delta on
 * ~5k emails is acceptable for a one-shot job. Revisit Batch API if we
 * need to re-run frequently.
 *
 * Usage:
 *   npm run triage:bootstrap -- --dry-run --limit 50 --account topcoder1@gmail.com
 *   npm run triage:bootstrap -- --limit 5000 --account topcoder1@gmail.com
 */
// classifier.ts constructs the Anthropic provider at module load time and
// captures ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY into the provider then.
// We dynamically import classifier (and its transitive DB-touching
// dependencies) inside run() so the env normalization below runs first.
import { SUPERPILOT_API_URL, NANOCLAW_SERVICE_TOKEN } from '../src/config.js';
import { TRIAGE_DEFAULTS } from '../src/triage/config.js';
import { readEnvValue } from '../src/env.js';
import { logger } from '../src/logger.js';

interface CliArgs {
  dryRun: boolean;
  limit: number;
  account: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    limit: 5000,
    account: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--limit') {
      const v = argv[++i];
      if (!v) throw new Error('--limit requires a value');
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer (got: ${v})`);
      }
      args.limit = n;
    } else if (a === '--account') {
      const v = argv[++i];
      if (!v) throw new Error('--account requires a value');
      args.account = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  const msg = [
    'Usage: npm run triage:bootstrap -- [options]',
    '',
    'Options:',
    '  --dry-run              Print decisions without writing to DB',
    '  --limit <n>            Max emails to process (default 5000)',
    '  --account <email>      Filter by account email',
    '  --help, -h             Show this help',
    '',
    'Env required: ANTHROPIC_API_KEY, NANOCLAW_SERVICE_TOKEN, SUPERPILOT_API_URL',
  ].join('\n');
  process.stdout.write(msg + '\n');
}

// Shape returned by SuperPilot's GET /nanoclaw/triaged-emails (see
// backend/app/api/nanoclaw_bridge.py::TriagedEmail). Snake_case, no body
// field, no archive-status filter. We treat non-actionable email_type
// values (notification/transactional/newsletter/marketing/spam) as a
// proxy for "user likely archived / shouldn't have been in attention" —
// the only archive-behavior signal the endpoint actually provides.
interface TriagedEmailRow {
  thread_id: string;
  account: string;
  subject: string;
  sender: string;
  sender_email: string;
  received_at: string;
  email_type: string | null;
  priority: string | null;
  needs_reply: boolean;
  suggested_action: string | null;
  action_items: string[];
  snippet: string | null;
}

// Archive proxy: SuperPilot's email_type values that the user would most
// likely archive without action. `transactions` / `transactional` covers
// shipping confirmations, payment receipts, account notifications — all
// "FYI, file it" rather than "needs your attention." Calibrated from the
// first dry-run where NOT including transactions drove disagreement to
// ~64% because the classifier correctly archived receipts.
const ARCHIVE_PROXY_TYPES = new Set([
  'notification',
  'notifications',
  'transactional',
  'transactions',
  'newsletter',
  'newsletters',
  'marketing',
  'promotional',
  'promotions',
  'spam',
]);

function isArchiveProxy(e: TriagedEmailRow): boolean {
  return !!e.email_type && ARCHIVE_PROXY_TYPES.has(e.email_type.toLowerCase());
}

async function fetchTriagedEmails(
  args: CliArgs,
): Promise<TriagedEmailRow[]> {
  if (!NANOCLAW_SERVICE_TOKEN) {
    throw new Error(
      'NANOCLAW_SERVICE_TOKEN is empty — cannot authenticate to SuperPilot',
    );
  }
  const base = SUPERPILOT_API_URL.replace(/\/$/, '');
  const url = new URL(`${base}/nanoclaw/triaged-emails`);
  // SuperPilot's endpoint doesn't take a limit or status filter — it
  // returns all classifications since the provided timestamp. We enforce
  // the limit client-side below. `status=archived` used to be sent here
  // but was silently ignored; archive-proxy filtering is also done
  // client-side via email_type.
  if (args.account) url.searchParams.set('account', args.account);
  // since: 90 days back — enough history without overwhelming the endpoint.
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  url.searchParams.set('since', since);

  const token = NANOCLAW_SERVICE_TOKEN.split(',')[0].split('@')[0].trim();
  // SuperPilot service-token auth uses the x-service-token header, not
  // OAuth2 Bearer — see backend/app/middleware/auth.py. The SSE endpoint
  // works because email-sse.ts uses the correct header; the bootstrap
  // script was sending Bearer and getting 401.
  const res = await fetch(url.toString(), {
    headers: {
      'x-service-token': token,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SuperPilot returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as
    | { emails?: TriagedEmailRow[] }
    | TriagedEmailRow[];
  const rows = Array.isArray(json) ? json : (json.emails ?? []);
  // Client-side limit (the server returns everything since the cursor).
  return rows.slice(0, args.limit);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Stats {
  total: number;
  classified: number;
  agreements: number;
  disagreements: number;
  malformed: number;
  skipRecorded: number;
  skipPromoted: number;
  examplesRecorded: number;
  errors: number;
}

async function run(args: CliArgs): Promise<void> {
  // Bridge .env -> process.env for the one key the Anthropic SDK reads
  // directly at connection time. readEnvValue prefers an existing
  // process.env value, so explicit shell exports still take precedence.
  const anthropicKey = readEnvValue('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set (checked process.env and .env)',
    );
  }
  process.env.ANTHROPIC_API_KEY = anthropicKey;
  // Some shells export ANTHROPIC_BASE_URL without the /v1 suffix (a common
  // Claude-for-Desktop / Claude Code setting). @ai-sdk/anthropic uses the
  // value as-is and appends /messages, so a bare host gives 404. Normalize
  // here so the script behaves the same whether invoked from a naked shell
  // or launchd (which doesn't set it at all).
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl && !/\/v\d+\/?$/.test(baseUrl)) {
    process.env.ANTHROPIC_BASE_URL = baseUrl.replace(/\/$/, '') + '/v1';
  }

  // Dynamic imports AFTER env normalization above — classifier.ts builds
  // the Anthropic provider at module-load time from the env at that
  // moment, so we must not import it until the env is settled.
  const { initDatabase } = await import('../src/db.js');
  const { classifyWithLlm } = await import('../src/triage/classifier.js');
  const { recordSkip } = await import('../src/triage/prefilter.js');
  const { recordExample } = await import('../src/triage/examples.js');

  // Classifier reaches into the DB (triage_examples for few-shot history,
  // triage_skip_list for pre-filter). Open the same store the running
  // service uses — this script is read-mostly in dry-run, and writes
  // (recordSkip/recordExample) on the real run go to the live DB too.
  initDatabase();

  process.stdout.write(
    `Fetching up to ${args.limit} archived emails` +
      (args.account ? ` for ${args.account}` : '') +
      ` (dry-run=${args.dryRun})...\n`,
  );

  const emails = await fetchTriagedEmails(args);
  process.stdout.write(`Fetched ${emails.length} emails.\n`);

  const stats: Stats = {
    total: emails.length,
    classified: 0,
    agreements: 0,
    disagreements: 0,
    malformed: 0,
    skipRecorded: 0,
    skipPromoted: 0,
    examplesRecorded: 0,
    errors: 0,
  };
  // Distribution breakdowns, dry-run only. Makes the summary useful
  // without having to dump all 500 lines.
  const queueDist: Record<string, number> = {};
  const tierDist: Record<string, number> = {};

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    try {
      const result = await classifyWithLlm({
        // SuperPilot's /triaged-emails doesn't return the body — feed the
        // snippet (~500 chars) as body so the classifier has content to
        // reason about. Matches what the live SSE path does too.
        emailBody: e.snippet ?? '',
        sender: e.sender || e.sender_email || 'unknown',
        subject: e.subject ?? '',
        superpilotLabel: e.email_type ?? null,
        threadId: e.thread_id,
        account: e.account,
      });
      stats.classified++;
      const agentQueue = result.decision.queue;
      queueDist[agentQueue] = (queueDist[agentQueue] ?? 0) + 1;
      tierDist[String(result.tier)] = (tierDist[String(result.tier)] ?? 0) + 1;

      // Ground truth is a proxy, not a real archive flag. SuperPilot
      // doesn't expose archive state — we use email_type to infer what
      // the user probably archives (notification/newsletter/etc).
      const userArchiveProxy = isArchiveProxy(e);
      const userQueue: 'archive_candidate' | 'attention' = userArchiveProxy
        ? 'archive_candidate'
        : 'attention';
      // Classifier's `action` queue is semantically "user should see this
      // and do something" — counts as attention-side for agreement. And
      // `digest` on the archive side (the classifier sometimes routes
      // there directly instead of archive_candidate).
      const agreed = userArchiveProxy
        ? agentQueue === 'archive_candidate' ||
          agentQueue === 'ignore' ||
          agentQueue === 'digest'
        : agentQueue === 'attention' || agentQueue === 'action';

      if (agreed) {
        stats.agreements++;
        if (args.dryRun) {
          process.stdout.write(
            `[${i + 1}/${emails.length}] AGREE  ${(e.sender_email || e.sender).slice(0, 40)} type=${e.email_type ?? '—'} → ${agentQueue} (tier=${result.tier} conf=${result.decision.confidence.toFixed(2)})\n`,
          );
        } else if (userArchiveProxy) {
          // Only reinforce skip-list on archive-proxy agreements. We never
          // promote a sender to skip based on attention-proxy agreements —
          // that would nuke signal for senders the user cares about.
          const sender = e.sender_email || e.sender;
          const r = recordSkip(sender, TRIAGE_DEFAULTS.skiplistPromotionHits);
          stats.skipRecorded++;
          if (r.promoted) stats.skipPromoted++;
          recordExample({
            kind: 'positive',
            trackedItemId: e.thread_id,
            emailSummary: `${e.subject} — from ${sender}`.slice(0, 500),
            agentQueue,
            userQueue,
            reasons: result.decision.reasons,
          });
          stats.examplesRecorded++;
        }
      } else {
        stats.disagreements++;
        if (args.dryRun) {
          process.stdout.write(
            `[${i + 1}/${emails.length}] DISAGREE ${(e.sender_email || e.sender).slice(0, 40)} type=${e.email_type ?? '—'} agent=${agentQueue} user=${userQueue} (tier=${result.tier} conf=${result.decision.confidence.toFixed(2)})\n`,
          );
        } else {
          recordExample({
            kind: 'negative',
            trackedItemId: e.thread_id,
            emailSummary: `${e.subject} — from ${e.sender_email || e.sender}`.slice(0, 500),
            agentQueue,
            userQueue,
            reasons: result.decision.reasons,
          });
          stats.examplesRecorded++;
        }
      }
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      if (/malformed/i.test(msg)) stats.malformed++;
      logger.warn(
        { threadId: e.thread_id, err: msg, stack },
        'triage-bootstrap: classify failed',
      );
    }

    // 200ms between calls; prompt caching handles the bulk of cost.
    await sleep(200);
  }

  process.stdout.write('\n--- Summary ---\n');
  process.stdout.write(`queue distribution: ${JSON.stringify(queueDist)}\n`);
  process.stdout.write(`tier distribution:  ${JSON.stringify(tierDist)}\n`);
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }
  await run(args);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
