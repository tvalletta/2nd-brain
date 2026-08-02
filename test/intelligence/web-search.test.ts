import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  createNoopSearch,
  createDuckDuckGoSearch,
  parseMcpResults,
  createWebSearchFromConfig,
  findDescendantPids,
  reapProcessDescendants,
} from '../../src/intelligence/web-search.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('web-search adapters', () => {
  describe('noop', () => {
    it('returns empty results', async () => {
      const s = createNoopSearch();
      expect(await s.search('anything', 5)).toEqual([]);
    });
  });

  describe('parseMcpResults', () => {
    it('parses JSON-shaped tool output', () => {
      const out = parseMcpResults(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                { url: 'https://a.com', title: 'A', snippet: 'about A' },
                { url: 'https://b.com', title: 'B', description: 'about B' },
              ]),
            },
          ],
        },
        5,
      );
      expect(out).toHaveLength(2);
      expect(out[0].url).toBe('https://a.com');
      expect(out[1].snippet).toBe('about B');
    });

    it('parses Brave-style { web: { results: [...] } }', () => {
      const out = parseMcpResults(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                web: {
                  results: [
                    { url: 'https://b.com', title: 'B', description: 'snippet' },
                  ],
                },
              }),
            },
          ],
        },
        5,
      );
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe('B');
    });

    it('falls back to line-based parsing when JSON missing', () => {
      const out = parseMcpResults(
        {
          content: [
            {
              type: 'text',
              text: 'Title One — https://x.com\nFirst snippet line.\n\nhttps://y.com\nSecond snippet.',
            },
          ],
        },
        5,
      );
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out[0].url).toMatch(/x\.com|y\.com/);
    });

    it('returns empty list on isError or empty content', () => {
      expect(parseMcpResults({ isError: true, content: [] }, 5)).toEqual([]);
      expect(parseMcpResults({ content: [] }, 5)).toEqual([]);
    });

    it('respects topK', () => {
      const out = parseMcpResults(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                Array.from({ length: 10 }, (_, i) => ({ url: `https://${i}.com`, title: `${i}`, snippet: 's' })),
              ),
            },
          ],
        },
        3,
      );
      expect(out).toHaveLength(3);
    });
  });

  describe('DuckDuckGo', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('parses Instant Answer abstract + related topics', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            Heading: 'FSRS',
            AbstractText: 'A spaced repetition algorithm.',
            AbstractURL: 'https://en.wikipedia.org/wiki/FSRS',
            RelatedTopics: [
              { FirstURL: 'https://example.com/1', Text: 'FSRS - Topic one info' },
              { Topics: [{ FirstURL: 'https://example.com/2', Text: 'Nested - more info' }] },
            ],
          }),
          { status: 200 },
        ),
      ) as typeof globalThis.fetch;

      const s = createDuckDuckGoSearch();
      const out = await s.search('FSRS', 5);
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out[0].url).toContain('wikipedia.org');
      expect(out[0].snippet).toContain('spaced repetition');
    });

    it('returns [] on non-2xx', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof globalThis.fetch;
      const s = createDuckDuckGoSearch();
      expect(await s.search('q', 5)).toEqual([]);
    });

    it('returns [] on network error', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network down');
      }) as typeof globalThis.fetch;
      const s = createDuckDuckGoSearch();
      expect(await s.search('q', 5)).toEqual([]);
    });
  });

  describe('createWebSearchFromConfig', () => {
    it('returns noop when no provider set', async () => {
      const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp' });
      const s = createWebSearchFromConfig(config);
      expect(await s.search('q', 5)).toEqual([]);
    });

    it('returns DDG when configured', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ AbstractText: 't', AbstractURL: 'https://x.com', Heading: 'H' }), {
          status: 200,
        }),
      ) as typeof globalThis.fetch;
      try {
        const config = KarpathyConfigSchema.parse({
          vaultPath: '/tmp',
          intelligence: { research: { search: { provider: 'duckduckgo' } } },
        });
        const s = createWebSearchFromConfig(config);
        const out = await s.search('q', 1);
        expect(out).toHaveLength(1);
        expect(out[0].url).toBe('https://x.com');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('falls back to noop when MCP provider has no command', async () => {
      const config = KarpathyConfigSchema.parse({
        vaultPath: '/tmp',
        intelligence: { research: { search: { provider: 'mcp' } } },
      });
      const s = createWebSearchFromConfig(config);
      expect(await s.search('q', 5)).toEqual([]);
    });
  });
});

// Fix L: the MCP SDK's StdioClientTransport.close() only SIGKILLs the
// directly-spawned command PID (e.g. `npx`), leaking any grandchild it forks
// (e.g. Puppeteer's Chromium). These tests exercise the real process-tree
// walk/reap against an actual spawned process tree (a shell backgrounding a
// child), standing in for `npx` forking a search-server grandchild.
describe('process-tree reaping (Fix L)', () => {
  it('findDescendantPids discovers a live grandchild process', async () => {
    const shell = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    try {
      const grandchildPid = await waitForDescendant(shell.pid!);
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      killTree(shell.pid!);
    }
  });

  it('reapProcessDescendants terminates a live grandchild process', async () => {
    const shell = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    const parentPid = shell.pid!;
    try {
      const grandchildPid = await waitForDescendant(parentPid);
      expect(isAlive(grandchildPid)).toBe(true);

      await reapProcessDescendants(parentPid, 100);

      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      killTree(parentPid);
    }
  });

  it('is a no-op that resolves cleanly when the pid has no descendants', async () => {
    const shell = spawn('sh', ['-c', 'true'], { stdio: 'ignore' });
    await new Promise((resolve) => shell.on('exit', resolve));
    await expect(reapProcessDescendants(shell.pid!, 50)).resolves.toBeUndefined();
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDescendant(parentPid: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descendants = await findDescendantPids(parentPid);
    if (descendants.length > 0) return descendants[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`No descendant of pid ${parentPid} appeared within ${timeoutMs}ms`);
}

function killTree(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
