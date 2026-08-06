import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { MCPContext } from '../../src/mcp/context.js';
import { startHttpMcpServer, type HttpMcpServerHandle } from '../../src/mcp/http-transport.js';

// Same construction pattern as test/mcp/create-server.test.ts's makeFakeCtx:
// a real MCPContext built from real, functioning components (vault adapter,
// session log, hot cache) without going through loadConfig()'s
// homedir-based global config file — keeps this test hermetic.
function makeRealCtx(tempDir: string): MCPContext {
  const vault = createFsAdapter(tempDir);
  const config = KarpathyConfigSchema.parse({ vaultPath: tempDir, projectRoot: tempDir });
  return {
    config,
    vault,
    sessionLog: createSessionLogManager(vault, config.layout),
    hotCache: createHotCacheManager(join(tempDir, config.hotCachePath)),
    usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
    enqueueJob: async () => {},
    runDeterministicJobs: async () => 0,
  };
}

describe('startHttpMcpServer', () => {
  let tempDir: string;
  let ctx: MCPContext;
  let handles: HttpMcpServerHandle[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-http-transport-'));
    ctx = makeRealCtx(tempDir);
    handles = [];
  });

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await rm(tempDir, { recursive: true, force: true });
  });

  async function start(
    opts: Partial<Parameters<typeof startHttpMcpServer>[0]> = {},
  ): Promise<HttpMcpServerHandle> {
    const h = await startHttpMcpServer({
      ctx,
      host: '127.0.0.1',
      port: 0,
      sessionIdleTimeoutMs: 60000,
      ...opts,
    });
    handles.push(h);
    return h;
  }

  it('serves two concurrent MCP clients from one server and cleans up sessions', async () => {
    const h = await start();
    expect(h.url).toBe(`http://127.0.0.1:${h.port}/mcp`);

    const mk = async () => {
      const c = new Client({ name: 't', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
      return c;
    };
    const [a, b] = await Promise.all([mk(), mk()]);

    const ta = await a.listTools();
    const tb = await b.listTools();
    expect(ta.tools.length).toBeGreaterThan(0);
    expect(tb.tools.length).toBe(ta.tools.length);
    expect(h.sessionCount()).toBe(2);

    await a.close();
    await b.close();
    await h.close();
    handles = handles.filter((x) => x !== h);
  });

  it('GET /health returns status ok, numeric pid, and session count', async () => {
    const h = await start();
    const r = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(typeof j.pid).toBe('number');
    expect(j.sessions).toBe(0);
    expect(typeof j.uptimeSec).toBe('number');
  });

  it('sweepIdle closes sessions whose lastActivityAt is older than the idle timeout', async () => {
    let currentTime = 1_000_000;
    const h = await start({ sessionIdleTimeoutMs: 5000, now: () => currentTime });

    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    expect(h.sessionCount()).toBe(1);

    // Not yet idle.
    currentTime += 1000;
    expect(h.sweepIdle()).toBe(0);
    expect(h.sessionCount()).toBe(1);

    // Past the idle timeout.
    currentTime += 10000;
    expect(h.sweepIdle()).toBe(1);
    expect(h.sessionCount()).toBe(0);

    await c.close().catch(() => {});
  });

  it('rejects /mcp requests without a valid bearer token when authToken is set', async () => {
    const h = await start({ authToken: 'secret-token' });

    const noAuth = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(wrongAuth.status).toBe(401);

    // /health remains unauthenticated.
    const health = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(health.status).toBe(200);
  });

  it('returns 404 for an unknown mcp-session-id', async () => {
    const h = await start();
    const r = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'GET',
      headers: { 'mcp-session-id': 'not-a-real-session' },
    });
    expect(r.status).toBe(404);
  });

  it('rejects an oversized POST body with 413 and stays usable for later requests', async () => {
    const h = await start();

    // Well above any sane cap (spec picks 4 MB) — content-length alone
    // should trip the guard before any buffering happens.
    const oversized = 'x'.repeat(6 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { big: oversized } }),
    });
    expect(res.status).toBe(413);
    await res.text().catch(() => {});

    // The server must stay up: a normal client can still connect afterward.
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    const tools = await c.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(h.sessionCount()).toBe(1);
    await c.close().catch(() => {});
  });

  it('DELETE /mcp closes the session server-side', async () => {
    const h = await start();
    const transport = new StreamableHTTPClientTransport(new URL(h.url));
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    expect(h.sessionCount()).toBe(1);

    const sessionId = transport.sessionId;
    expect(typeof sessionId).toBe('string');

    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId! },
    });
    expect(res.status).toBe(200);
    expect(h.sessionCount()).toBe(0);

    await client.close().catch(() => {});
  });

  it('close() is idempotent — calling it twice resolves without throwing', async () => {
    const h = await start();
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
  });
});
