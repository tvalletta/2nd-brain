// Pluggable WebSearch implementations for the research executor.
//
// The interface is `WebSearch` (defined in research-execute.ts). The executor
// is agnostic to which implementation it gets — switching providers is a
// config change, not a code change.
//
// Three adapters ship today:
//   - `createMcpSearch(opts)`        — connects to any local search MCP server
//                                      via stdio and calls a configured tool.
//   - `createDuckDuckGoSearch()`     — no-key fallback using the DuckDuckGo
//                                      Instant Answer API.
//   - `createNoopSearch()`           — default; returns []; the LLM falls
//                                      back to its own knowledge.
//
// `createWebSearchFromConfig(config)` picks one based on
// `intelligence.research.search.provider`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SearchResult, WebSearch } from './research-execute.js';
import type { KarpathyConfig } from '../config/schema.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('web-search');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Noop
// ---------------------------------------------------------------------------

export function createNoopSearch(): WebSearch {
  return {
    async search() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// DuckDuckGo (free, no key)
// ---------------------------------------------------------------------------

interface DDGRelatedTopic {
  Result?: string;
  FirstURL?: string;
  Text?: string;
  Topics?: DDGRelatedTopic[];
}
interface DDGResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DDGRelatedTopic[];
}

export interface DuckDuckGoOptions {
  endpoint?: string;
}

export function createDuckDuckGoSearch(opts: DuckDuckGoOptions = {}): WebSearch {
  const endpoint = opts.endpoint ?? 'https://api.duckduckgo.com/';
  return {
    async search(query: string, topK: number): Promise<SearchResult[]> {
      try {
        const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url, {
          headers: { 'user-agent': 'karpathy-second-memory/0.1 (+research)' },
        });
        if (!res.ok) {
          log.warn('DDG returned non-2xx', { status: res.status });
          return [];
        }
        const data = (await res.json()) as DDGResponse;
        const out: SearchResult[] = [];

        if (data.AbstractText && data.AbstractURL) {
          out.push({
            url: data.AbstractURL,
            title: data.Heading ?? query,
            snippet: data.AbstractText.slice(0, 800),
          });
        }

        // Flatten related topics (at most one level deep).
        const flat = flattenTopics(data.RelatedTopics ?? []);
        for (const t of flat) {
          if (out.length >= topK) break;
          if (!t.FirstURL || !t.Text) continue;
          out.push({
            url: t.FirstURL,
            title: t.Text.split(' - ')[0]?.slice(0, 120) ?? t.Text.slice(0, 120),
            snippet: t.Text.slice(0, 800),
          });
        }

        return out.slice(0, topK);
      } catch (err) {
        log.warn('DDG request failed', { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    },
  };
}

function flattenTopics(topics: DDGRelatedTopic[]): DDGRelatedTopic[] {
  const out: DDGRelatedTopic[] = [];
  for (const t of topics) {
    if (Array.isArray(t.Topics)) {
      out.push(...t.Topics);
    } else {
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fix L: subprocess-tree reaping for the per-call MCP search client
// ---------------------------------------------------------------------------
//
// What's reachable through `@modelcontextprotocol/sdk`'s `StdioClientTransport`:
//   - a `pid` getter exposing the directly-spawned `command`'s PID (e.g. the
//     `npx` process), available once `connect()`/`start()` has resolved.
//   - `close()`, which itself does a graceful `stdin.end()` wait, then
//     `SIGTERM`, then `SIGKILL` — but ONLY against that one direct PID.
//
// What's NOT reachable: `StdioServerParameters` (the options object the
// transport accepts) has no `detached` / process-group field, so we cannot
// make the SDK spawn the child as its own process-group leader. That means
// signaling the negated PID (`-pid`, POSIX process-group kill) is unsafe
// here — the child was never made a group leader, so `-pid` would resolve to
// *our own* process group (which includes this very Node process), not an
// isolated one.
//
// Best available fallback: after the SDK's own `close()` finishes, walk the
// process tree rooted at the transport's `pid` via `pgrep -P` (supported on
// both macOS/BSD and Linux) and individually SIGTERM/SIGKILL any surviving
// descendants by their own PID — e.g. the Puppeteer-launched Chromium a
// websearch MCP server spawns via `npx`, which the SDK's pid-only close()
// never reaches. This never touches the shared process group, so it can't
// collaterally kill unrelated sibling processes.

export async function findDescendantPids(rootPid: number): Promise<number[]> {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let children: number[] = [];
    try {
      const { stdout } = await execFileAsync('pgrep', ['-P', String(current)]);
      children = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
    } catch {
      // pgrep exits non-zero (no output) when a process has no children —
      // this is the common case, not an error condition.
      children = [];
    }
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

/**
 * Best-effort reap of any process-tree descendants left behind by the SDK's
 * own pid-only `close()`. No-op (fast) when there are none — the common case
 * for MCP servers that don't fork grandchildren.
 */
export async function reapProcessDescendants(rootPid: number, graceMs = 1500): Promise<void> {
  let descendants: number[] = [];
  try {
    descendants = await findDescendantPids(rootPid);
  } catch (err) {
    log.warn('Process-tree walk failed; cannot reap descendants', {
      pid: rootPid,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (descendants.length === 0) return;

  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, graceMs));
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  log.info('Reaped web-search subprocess descendants', { rootPid, count: descendants.length });
}

// ---------------------------------------------------------------------------
// MCP-based search (the recommended path)
// ---------------------------------------------------------------------------

export interface McpSearchOptions {
  /** Executable to spawn (e.g. `npx`, `uvx`, or an absolute path). */
  command: string;
  /** CLI args (e.g. `["-y", "@modelcontextprotocol/server-brave-search"]`). */
  args: string[];
  /** Tool name on the MCP server (e.g. `"brave_web_search"`, `"web_search"`, `"search"`). */
  toolName: string;
  /** Argument key the server expects for the query string. Default `"query"`. */
  queryArg?: string;
  /** Argument key for the result count. Default `"count"`. Some servers use `"num_results"`. */
  countArg?: string;
  /** Optional extra args merged into every call (API key, region, etc.). */
  extraArgs?: Record<string, unknown>;
  /** Environment passed to the spawned MCP server. */
  env?: Record<string, string>;
  /** Lifecycle: `"per-call"` (spawn-call-shutdown each query) or `"persistent"` (keep alive across calls; you must `close()`). Default `"per-call"`. */
  lifecycle?: 'per-call' | 'persistent';
}

interface McpSearchHandle extends WebSearch {
  /** Close any persistent MCP connection. No-op for per-call lifecycle. */
  close(): Promise<void>;
}

export function createMcpSearch(opts: McpSearchOptions): McpSearchHandle {
  const queryArg = opts.queryArg ?? 'query';
  const countArg = opts.countArg ?? 'count';
  const lifecycle = opts.lifecycle ?? 'per-call';

  // Lazy-imported types/clients so we don't pay the cost when MCP isn't used.
  type Client = {
    connect(transport: unknown): Promise<void>;
    callTool(req: { name: string; arguments?: Record<string, unknown> }): Promise<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
    close(): Promise<void>;
  };

  /** A connected client plus the transport's directly-spawned PID (if the SDK exposes one), for post-close reaping. */
  interface ClientHandle {
    client: Client;
    pid: number | null;
  }

  let persistentHandle: ClientHandle | null = null;

  async function spawnClient(): Promise<ClientHandle> {
    const sdk = await import('@modelcontextprotocol/sdk/client/index.js');
    const stdio = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new stdio.StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });
    const client = new sdk.Client(
      { name: 'karpathy-research', version: '0.1.0' },
      { capabilities: {} },
    ) as unknown as Client;
    await client.connect(transport);
    const pid = (transport as unknown as { pid?: number | null }).pid ?? null;
    return { client, pid };
  }

  async function getClient(): Promise<ClientHandle> {
    if (lifecycle === 'persistent') {
      if (!persistentHandle) persistentHandle = await spawnClient();
      return persistentHandle;
    }
    return spawnClient();
  }

  async function closeHandle(handle: ClientHandle): Promise<void> {
    try {
      await handle.client.close();
    } catch {
      // ignore — the SDK's own close() already best-effort SIGTERM/SIGKILLs
      // the direct pid regardless of whether this throws.
    }
    if (handle.pid != null) {
      await reapProcessDescendants(handle.pid).catch(() => {
        // reapProcessDescendants already logs internally; never let a
        // reaping failure surface as a search failure.
      });
    }
  }

  return {
    async search(query: string, topK: number): Promise<SearchResult[]> {
      let handle: ClientHandle | null = null;
      try {
        handle = await getClient();
        const args: Record<string, unknown> = {
          [queryArg]: query,
          [countArg]: topK,
          ...(opts.extraArgs ?? {}),
        };
        const res = await handle.client.callTool({ name: opts.toolName, arguments: args });
        if (res.isError) {
          log.warn('MCP search tool reported error', { tool: opts.toolName });
          return [];
        }
        return parseMcpResults(res, topK);
      } catch (err) {
        log.warn('MCP search failed', { error: err instanceof Error ? err.message : String(err) });
        return [];
      } finally {
        if (lifecycle === 'per-call' && handle) {
          await closeHandle(handle);
        }
      }
    },
    async close() {
      if (persistentHandle) {
        const handle = persistentHandle;
        persistentHandle = null;
        await closeHandle(handle);
      }
    },
  };
}

/**
 * Parse search results out of an MCP tool response. The protocol returns
 * `{ content: [{ type: "text", text: "..." }] }` — by convention search MCP
 * servers either embed JSON in the text or emit pre-formatted text. We try
 * JSON first (common case) and fall back to a permissive line-parser.
 */
export function parseMcpResults(
  response: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  topK: number,
): SearchResult[] {
  const blocks = (response.content ?? []).filter((c) => c.type === 'text' && c.text);
  if (blocks.length === 0) return [];

  // Strategy 1: JSON in the first text block.
  for (const block of blocks) {
    const text = block.text ?? '';
    const parsed = tryParseJsonResults(text);
    if (parsed.length > 0) return parsed.slice(0, topK);
  }

  // Strategy 2: line-based parsing — `Title - URL\nSnippet` or similar.
  const out: SearchResult[] = [];
  for (const block of blocks) {
    const text = block.text ?? '';
    out.push(...parseLineResults(text));
    if (out.length >= topK) break;
  }
  return out.slice(0, topK);
}

interface JsonResultShape {
  url?: string;
  link?: string;
  href?: string;
  title?: string;
  name?: string;
  snippet?: string;
  description?: string;
  content?: string;
  text?: string;
}

function tryParseJsonResults(text: string): SearchResult[] {
  // Find the first {...} or [...] JSON-looking blob.
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  const codeFence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (codeFence) candidates.push(codeFence[1]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const arr = Array.isArray(parsed)
        ? (parsed as JsonResultShape[])
        : Array.isArray((parsed as { results?: JsonResultShape[] }).results)
          ? (parsed as { results: JsonResultShape[] }).results
          : Array.isArray((parsed as { web?: { results?: JsonResultShape[] } }).web?.results)
            ? (parsed as { web: { results: JsonResultShape[] } }).web.results
            : null;
      if (!arr) continue;
      const out: SearchResult[] = [];
      for (const item of arr) {
        const url = item.url ?? item.link ?? item.href;
        const title = item.title ?? item.name ?? '';
        const snippet = item.snippet ?? item.description ?? item.content ?? item.text ?? '';
        if (!url) continue;
        out.push({ url, title: String(title).slice(0, 200), snippet: String(snippet).slice(0, 800) });
      }
      if (out.length > 0) return out;
    } catch {
      // try next candidate
    }
  }
  return [];
}

function parseLineResults(text: string): SearchResult[] {
  const out: SearchResult[] = [];
  const lines = text.split('\n');
  let pending: { title?: string; url?: string; snippet?: string } = {};
  const flush = () => {
    if (pending.url) {
      out.push({
        url: pending.url,
        title: pending.title ?? pending.url,
        snippet: (pending.snippet ?? '').slice(0, 800),
      });
    }
    pending = {};
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (urlMatch && !pending.url) {
      pending.url = urlMatch[0];
      const titleCandidate = line.replace(urlMatch[0], '').replace(/[-—|:]/g, '').trim();
      if (titleCandidate) pending.title = titleCandidate.slice(0, 200);
    } else {
      pending.snippet = pending.snippet ? `${pending.snippet} ${line}` : line;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebSearchFromConfig(config: KarpathyConfig): WebSearch {
  const search = config.intelligence.research.search;
  if (search.provider === 'mcp' && search.mcp?.command) {
    return createMcpSearch({
      command: search.mcp.command,
      args: search.mcp.args ?? [],
      toolName: search.mcp.toolName ?? 'search',
      queryArg: search.mcp.queryArg,
      countArg: search.mcp.countArg,
      extraArgs: search.mcp.extraArgs,
      env: search.mcp.env,
      lifecycle: 'per-call',
    });
  }
  if (search.provider === 'duckduckgo') {
    return createDuckDuckGoSearch();
  }
  return createNoopSearch();
}
