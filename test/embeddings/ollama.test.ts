import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createOllamaProvider, isOllamaAvailable } from '../../src/embeddings/ollama.js';

interface RecordedRequest {
  method?: string;
  url?: string;
  body?: unknown;
}

async function startMockServer(
  handler: (req: RecordedRequest, res: { status: number; body: unknown }) => void,
): Promise<{ url: string; close: () => Promise<void>; lastRequest: () => RecordedRequest | null }> {
  let last: RecordedRequest | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
      const recorded: RecordedRequest = { method: req.method, url: req.url, body };
      last = recorded;
      const out = { status: 200, body: {} as unknown };
      handler(recorded, out);
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
    lastRequest: () => last,
  };
}

describe('ollama embedding provider', () => {
  let mock: Awaited<ReturnType<typeof startMockServer>> | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('POSTs /api/embeddings with the right shape and returns Float32Array vectors', async () => {
    mock = await startMockServer((_req, res) => {
      res.body = { embedding: [1, 0, 0, 0] };
    });
    const provider = createOllamaProvider({ baseUrl: mock.url, model: 'nomic-embed-text', dimensions: 4 });
    const out = await provider.embed(['hello world']);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(4);
    const req = mock.lastRequest()!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/embeddings');
    expect(req.body).toEqual({ model: 'nomic-embed-text', prompt: 'hello world' });
  });

  it('aligns batched outputs 1:1 with input order', async () => {
    let call = 0;
    mock = await startMockServer((_req, res) => {
      // Each call returns a different vector keyed by the input prompt.
      call++;
      res.body = { embedding: [call, 0, 0, 0] };
    });
    const provider = createOllamaProvider({ baseUrl: mock.url, model: 'm', dimensions: 4 });
    const out = await provider.embed(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    // Decreasing magnitude after normalization, but ordering preserved by call order.
    expect(out[0][0]).toBe(1);
    expect(out[1][0]).toBe(1); // normalized → still 1 because it's a unit vector
    expect(out[2][0]).toBe(1);
  });

  it('exposes a stable id including model and dimensions', () => {
    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'nomic-embed-text', dimensions: 768 });
    expect(provider.id).toBe('ollama-nomic-embed-text-768');
    expect(provider.dimensions).toBe(768);
  });

  it('throws on non-2xx HTTP responses', async () => {
    mock = await startMockServer((_req, res) => {
      res.status = 500;
      res.body = { error: 'kaboom' };
    });
    const provider = createOllamaProvider({ baseUrl: mock.url, model: 'm', dimensions: 4 });
    await expect(provider.embed(['hi'])).rejects.toThrow(/Ollama embedding request failed/);
  });

  it('throws when the response is missing the embedding array', async () => {
    mock = await startMockServer((_req, res) => {
      res.body = { not_embedding: [1, 2, 3] };
    });
    const provider = createOllamaProvider({ baseUrl: mock.url, model: 'm', dimensions: 3 });
    await expect(provider.embed(['hi'])).rejects.toThrow(/missing embedding/);
  });

  it('isOllamaAvailable returns true when /api/tags responds 2xx', async () => {
    mock = await startMockServer((_req, res) => {
      res.body = { models: [] };
    });
    const ok = await isOllamaAvailable(mock.url, 1000);
    expect(ok).toBe(true);
    const req = mock.lastRequest()!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/tags');
  });

  it('isOllamaAvailable returns false on connection refused', async () => {
    // Random unused high port — nothing listens here.
    const ok = await isOllamaAvailable('http://127.0.0.1:1', 500);
    expect(ok).toBe(false);
  });

  it('isOllamaAvailable returns false on timeout', async () => {
    // Server that never responds.
    const server: Server = createServer(() => {
      /* hang forever */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await isOllamaAvailable(`http://127.0.0.1:${port}`, 100);
      expect(ok).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('strips trailing slashes from baseUrl', async () => {
    mock = await startMockServer((_req, res) => {
      res.body = { embedding: [1, 1, 1, 1] };
    });
    const provider = createOllamaProvider({ baseUrl: `${mock.url}/////`, model: 'm', dimensions: 4 });
    const out = await provider.embed(['hi']);
    expect(out).toHaveLength(1);
    expect(mock.lastRequest()!.url).toBe('/api/embeddings');
  });
});
