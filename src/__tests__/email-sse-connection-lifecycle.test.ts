/**
 * Connection-lifecycle tests for the email SSE client.
 *
 * Regression coverage for the 2026-06-30 production incident: the client
 * scheduled multiple reconnect timers per connection (non-200 branch +
 * request 'error' handler both fired) and never destroyed the previous
 * request before reconnecting. Against a server returning 429s that
 * doubled the connection count every backoff cycle — the superpilot
 * backend accumulated ~16k ESTABLISHED sockets at ~35 new conns/sec.
 *
 * These tests run a real local HTTP server and assert the observable
 * invariants: at most one socket per logical connection, at most one
 * reconnect per close/error, Retry-After honored, Last-Event-ID sent.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

const mockConfig = vi.hoisted(() => ({
  DATA_DIR: '/tmp',
  EMAIL_INTELLIGENCE_ENABLED: true,
  SSE_CONNECTIONS: [] as { token: string; label: string }[],
  SUPERPILOT_API_URL: 'http://127.0.0.1:0/api',
}));
vi.mock('../config.js', () => mockConfig);

interface SeenRequest {
  headers: http.IncomingHttpHeaders;
  at: number;
}

interface SseTestServer {
  url: string;
  requests: SeenRequest[];
  openStreams: () => number;
  maxConcurrentStreams: () => number;
  close: () => Promise<void>;
}

/** Local HTTP server standing in for the superpilot SSE endpoint. */
async function startSseServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    info: { index: number },
  ) => void,
): Promise<SseTestServer> {
  let open = 0;
  let maxOpen = 0;
  const requests: SeenRequest[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const index = requests.length;
    requests.push({ headers: req.headers, at: Date.now() });
    open++;
    maxOpen = Math.max(maxOpen, open);
    res.on('close', () => {
      open--;
    });
    handler(req, res, { index });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api`,
    requests,
    openStreams: () => open,
    maxConcurrentStreams: () => maxOpen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(10);
  }
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

type SseModule = typeof import('../email-sse.js');

/** Fresh module instance per test so `running`/`connections` state resets. */
async function loadSse(
  server: SseTestServer,
  tokens: { token: string; label: string }[],
  timing: Parameters<SseModule['_setSseTimingForTest']>[0],
): Promise<SseModule> {
  vi.resetModules();
  mockConfig.SUPERPILOT_API_URL = server.url;
  mockConfig.SSE_CONNECTIONS.length = 0;
  mockConfig.SSE_CONNECTIONS.push(...tokens);
  const mod = await import('../email-sse.js');
  mod._setSseTimingForTest(timing);
  return mod;
}

const ONE_TOKEN = [{ token: 'tok-1', label: 'primary' }];

describe('email-sse connection lifecycle', () => {
  let server: SseTestServer | null = null;
  let sse: SseModule | null = null;

  afterEach(async () => {
    sse?.stopEmailSSE();
    sse = null;
    await server?.close();
    server = null;
  });

  it('429 rejections: at most one reconnect per attempt, no request storm', async () => {
    // Server holds the 429 response open (body never ends) — the client
    // must destroy it. In the buggy client, the non-200 branch scheduled a
    // reconnect AND the destroy fired the request 'error' handler which
    // scheduled a second one → attempts doubled every backoff cycle.
    server = await startSseServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '0' });
      res.write('rate limited');
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 40,
      reconnectMaxMs: 160,
      stableResetMs: 10_000,
      idleTimeoutMs: 5_000,
    });

    sse.startEmailSSE();
    await sleep(900);
    sse.stopEmailSSE();

    // Exponential backoff from 40ms capped at 160ms allows attempts at
    // ~0, 40, 120, 280, 440(cap), 600, 760 → ≤ 8 attempts in 900ms.
    // The buggy doubling client fires 15+ in the same window.
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    expect(server.requests.length).toBeLessThanOrEqual(8);
    // The rejected stream must be fully closed before the next attempt.
    expect(server.maxConcurrentStreams()).toBe(1);
    await waitFor(() => server!.openStreams() === 0, 500, 'sockets closed');
  });

  it('clean server close: single reconnect that resumes via Last-Event-ID', async () => {
    // Mirrors the prod server's ~900s bounded stream lifetime: 200, one
    // event with an id, then a clean end. The client must reconnect with
    // the Last-Event-ID header and never hold two sockets at once.
    server = await startSseServer((_req, res, { index }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      res.write(`id: evt-${index}\nevent: noop\ndata: {}\n\n`);
      setTimeout(() => res.end(), 40);
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 30,
      reconnectMaxMs: 120,
      stableResetMs: 1, // every stream counts as stable → backoff resets
      idleTimeoutMs: 5_000,
    });

    sse.startEmailSSE();
    await waitFor(() => server!.requests.length >= 3, 3_000, '3 attempts');
    sse.stopEmailSSE();

    expect(server.requests[0].headers['last-event-id']).toBeUndefined();
    expect(server.requests[1].headers['last-event-id']).toBe('evt-0');
    expect(server.requests[2].headers['last-event-id']).toBe('evt-1');
    expect(server.maxConcurrentStreams()).toBe(1);
  });

  it('429 with Retry-After: backs off at least that long', async () => {
    server = await startSseServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '1' });
      res.end('rate limited');
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 30,
      reconnectMaxMs: 120,
      stableResetMs: 10_000,
      idleTimeoutMs: 5_000,
    });

    sse.startEmailSSE();
    await waitFor(() => server!.requests.length >= 2, 2_500, '2nd attempt');
    sse.stopEmailSSE();

    const gapMs = server.requests[1].at - server.requests[0].at;
    expect(gapMs).toBeGreaterThanOrEqual(900);
  });

  it('abrupt mid-stream destroy: single reconnect with growing backoff', async () => {
    server = await startSseServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      setTimeout(() => res.destroy(), 30);
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 50,
      reconnectMaxMs: 400,
      stableResetMs: 10_000, // 30ms streams are unstable → backoff must grow
      idleTimeoutMs: 5_000,
    });

    sse.startEmailSSE();
    await sleep(1_000);
    sse.stopEmailSSE();

    // Attempts at ~0, 80, 210, 440, 870 → ≤ 6 in 1s; a client that
    // double-schedules or resets backoff on the 200 fires many more.
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    expect(server.requests.length).toBeLessThanOrEqual(6);
    expect(server.maxConcurrentStreams()).toBe(1);
    const at = server.requests.map((r) => r.at);
    const lastGap = at[at.length - 1] - at[at.length - 2];
    expect(lastGap).toBeGreaterThanOrEqual(150);
  });

  it('stopEmailSSE closes the socket and halts reconnects', async () => {
    const heartbeats = new Set<ReturnType<typeof setInterval>>();
    server = await startSseServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20);
      heartbeats.add(timer);
      res.on('close', () => {
        clearInterval(timer);
        heartbeats.delete(timer);
      });
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 30,
      reconnectMaxMs: 120,
      stableResetMs: 10_000,
      idleTimeoutMs: 5_000,
    });

    sse.startEmailSSE();
    await waitFor(() => server!.openStreams() === 1, 1_000, 'stream open');
    sse.stopEmailSSE();
    await waitFor(() => server!.openStreams() === 0, 1_000, 'stream closed');
    await sleep(300);
    expect(server.requests.length).toBe(1);
  });

  it('silent stream (no heartbeats) is detected as dead and reconnected', async () => {
    server = await startSseServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      // then silence — server never sends another byte and never closes
    });
    sse = await loadSse(server, ONE_TOKEN, {
      reconnectMinMs: 30,
      reconnectMaxMs: 120,
      stableResetMs: 10_000,
      idleTimeoutMs: 150,
    });

    sse.startEmailSSE();
    await waitFor(() => server!.requests.length >= 2, 2_000, 'reconnect');
    sse.stopEmailSSE();

    expect(server.maxConcurrentStreams()).toBe(1);
  });

  it('connections back off independently — a 429 on one never disturbs the other', async () => {
    const heartbeats = new Set<ReturnType<typeof setInterval>>();
    server = await startSseServer((req, res) => {
      if (req.headers['x-service-token'] === 'tok-capped') {
        res.writeHead(429, { 'retry-after': '0' });
        res.end('rate limited');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20);
      heartbeats.add(timer);
      res.on('close', () => {
        clearInterval(timer);
        heartbeats.delete(timer);
      });
    });
    sse = await loadSse(
      server,
      [
        { token: 'tok-healthy', label: 'healthy' },
        { token: 'tok-capped', label: 'capped' },
      ],
      {
        reconnectMinMs: 40,
        reconnectMaxMs: 160,
        stableResetMs: 10_000,
        idleTimeoutMs: 5_000,
      },
    );

    sse.startEmailSSE();
    await sleep(500);
    sse.stopEmailSSE();

    const byToken = (token: string) =>
      server!.requests.filter((r) => r.headers['x-service-token'] === token);
    expect(byToken('tok-healthy').length).toBe(1);
    expect(byToken('tok-capped').length).toBeGreaterThanOrEqual(2);
    // one socket per logical connection, at most two total
    expect(server.maxConcurrentStreams()).toBeLessThanOrEqual(2);
  });
});
