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

import type { SearchResult, WebSearch } from './research-execute.js';
import type { KarpathyConfig } from '../config/schema.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('web-search');

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

  let persistentClient: Client | null = null;

  async function spawnClient(): Promise<Client> {
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
    return client;
  }

  async function getClient(): Promise<Client> {
    if (lifecycle === 'persistent') {
      if (!persistentClient) persistentClient = await spawnClient();
      return persistentClient;
    }
    return spawnClient();
  }

  return {
    async search(query: string, topK: number): Promise<SearchResult[]> {
      let client: Client | null = null;
      try {
        client = await getClient();
        const args: Record<string, unknown> = {
          [queryArg]: query,
          [countArg]: topK,
          ...(opts.extraArgs ?? {}),
        };
        const res = await client.callTool({ name: opts.toolName, arguments: args });
        if (res.isError) {
          log.warn('MCP search tool reported error', { tool: opts.toolName });
          return [];
        }
        return parseMcpResults(res, topK);
      } catch (err) {
        log.warn('MCP search failed', { error: err instanceof Error ? err.message : String(err) });
        return [];
      } finally {
        if (lifecycle === 'per-call' && client) {
          try {
            await client.close();
          } catch {
            // ignore
          }
        }
      }
    },
    async close() {
      if (persistentClient) {
        try {
          await persistentClient.close();
        } catch {
          // ignore
        }
        persistentClient = null;
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
