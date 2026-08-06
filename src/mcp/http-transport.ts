import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { MCPContext } from './context.js';
import { createMcpServer } from './create-server.js';

export interface HttpMcpServerOptions {
  ctx: MCPContext;
  host: string;
  port: number;
  sessionIdleTimeoutMs: number;
  authToken?: string;
  now?: () => number;
}

export interface HttpMcpServerHandle {
  port: number;
  url: string;
  sessionCount(): number;
  sweepIdle(): number;
  close(): Promise<void>;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
}

const SERVER_VERSION = '0.1.0';

/** Hard cap on a single `/mcp` request body (§27-style bounded-memory posture). */
const MAX_MCP_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

/** Thrown by `readJsonBody` when a request body exceeds `MAX_MCP_REQUEST_BODY_BYTES`. */
class PayloadTooLargeError extends Error {}

/**
 * Reads and JSON-parses the full body of a `node:http` request. The SDK's
 * `StreamableHTTPServerTransport.handleRequest` accepts a pre-parsed body
 * (see streamableHttp.d.ts's usage example) — `node:http` has no built-in
 * body parser, so this does the minimal equivalent.
 *
 * Bounded to `maxBytes`: a `content-length` header over the cap rejects
 * immediately (draining and discarding the socket via `req.resume()` so a
 * misbehaving client doesn't stall the connection); absent/understated
 * `content-length` is caught by capping the accumulated buffer as chunks
 * arrive — once exceeded, further chunks are discarded (not buffered) but
 * still drained so the request can reach `end` and the connection stays
 * healthy for the next request on a keep-alive socket.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume(); // drain + discard so the connection isn't left dangling
      reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // already over cap — keep draining, discard the rest
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0; // free what's buffered so far right away
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * Starts an `node:http` server that serves MCP over the SDK's Streamable
 * HTTP transport, one MCP session per client, all sharing one `ctx`. Also
 * serves `GET /health` for liveness/monitoring.
 *
 * Multi-session pattern per the SDK v1.29 stateful example (top of
 * `streamableHttp.d.ts`): a fresh `StreamableHTTPServerTransport` +
 * `Server` (via `createMcpServer(ctx)`) is created on each `initialize`
 * request that arrives without a known `mcp-session-id`; the transport is
 * registered in the session map once the SDK assigns it a session id
 * (`onsessioninitialized`), and removed on `transport.onclose`. Every
 * subsequent request for that session is routed to the same transport by
 * `mcp-session-id` header.
 */
export async function startHttpMcpServer(
  opts: HttpMcpServerOptions,
): Promise<HttpMcpServerHandle> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const sessions = new Map<string, SessionEntry>();

  function isAuthorized(req: IncomingMessage): boolean {
    if (!opts.authToken) return true;
    const header = req.headers['authorization'];
    return header === `Bearer ${opts.authToken}`;
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req)) {
      sendJsonRpcError(res, 401, 'Unauthorized');
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        sendJsonRpcError(res, 404, 'Session not found');
        return;
      }
      entry.lastActivityAt = now();
      const body =
        req.method === 'POST' ? await readJsonBody(req, MAX_MCP_REQUEST_BODY_BYTES) : undefined;
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    // No session id: only a fresh `initialize` request is valid here.
    if (req.method !== 'POST') {
      sendJsonRpcError(res, 400, 'No valid session and request is not an initialize request');
      return;
    }

    const body = await readJsonBody(req, MAX_MCP_REQUEST_BODY_BYTES);
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(res, 400, 'No valid session and request is not an initialize request');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, lastActivityAt: now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createMcpServer(opts.ctx);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, {
      status: 'ok',
      pid: process.pid,
      version: SERVER_VERSION,
      uptimeSec: (now() - startedAt) / 1000,
      sessions: sessions.size,
    });
  }

  const httpServer = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (path === '/health' && req.method === 'GET') {
      handleHealth(req, res);
      return;
    }

    if (path === '/mcp') {
      handleMcpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          const status = err instanceof PayloadTooLargeError ? 413 : 500;
          const message = err instanceof Error ? err.message : 'Internal error';
          sendJsonRpcError(res, status, message);
        } else {
          res.end();
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  const address = httpServer.address();
  const port =
    address && typeof address === 'object' ? address.port : opts.port;
  const url = `http://${opts.host}:${port}/mcp`;
  let closed = false;

  return {
    port,
    url,
    sessionCount(): number {
      return sessions.size;
    },
    sweepIdle(): number {
      const cutoff = now() - opts.sessionIdleTimeoutMs;
      let closedCount = 0;
      for (const [sid, entry] of sessions) {
        if (entry.lastActivityAt < cutoff) {
          sessions.delete(sid);
          closedCount += 1;
          entry.transport.close().catch(() => {});
        }
      }
      return closedCount;
    },
    async close(): Promise<void> {
      // Idempotent: Task 7's shutdown path may call close() more than once
      // (e.g. an explicit shutdown racing a signal handler); a second
      // httpServer.close() would otherwise reject with
      // ERR_SERVER_NOT_RUNNING.
      if (closed) return;
      closed = true;
      const entries = Array.from(sessions.values());
      sessions.clear();
      await Promise.all(entries.map((entry) => entry.transport.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
