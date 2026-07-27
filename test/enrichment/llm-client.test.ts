import { describe, it, expect, afterEach } from 'vitest';
import { extractJSON } from '../../src/enrichment/llm-client.js';

describe('extractJSON', () => {
  it('parses a fenced ```json object block (existing behavior, unaffected)', () => {
    const raw = 'Here is the result:\n```json\n{"a":1}\n```\nDone.';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('parses a fenced ```json array block (existing behavior, unaffected)', () => {
    const raw = '```json\n[{"a":1},{"b":2}]\n```';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('falls back to a bare object when no fence is present', () => {
    const raw = 'some prose {"a":1} more prose';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('does NOT overshoot past trailing prose containing a stray closing brace (the I10 root cause)', () => {
    const raw = 'prose {"a":1} more prose mentioning a config block } stray brace';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('falls back to a bare ARRAY when no fence is present (previously unsupported — the fallback only handled objects)', () => {
    const raw = 'prose [{"a":1},{"b":2}] trailing text with a stray } brace too';
    expect(extractJSON(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('respects string boundaries when counting braces (a value containing a brace-like character does not break scanning)', () => {
    const raw = 'prose {"reason":"see the {config} block"} trailing prose with another }';
    expect(extractJSON(raw)).toEqual({ reason: 'see the {config} block' });
  });

  it('skips a non-JSON bracket-like construct (e.g. a markdown link) in prose before the real JSON payload', () => {
    const raw = 'See [details](https://example.com) below.\n{"a":1}';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });
});

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createBedrockBearerClient, createLiteLLMClient, fetchWithClassification } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

async function startStatusServer(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('fetchWithClassification', () => {
  let mock: { url: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it.each([401, 403, 429, 500, 502, 503, 504])('throws TransientLLMError on HTTP %i', async (status) => {
    mock = await startStatusServer(status, { error: 'boom' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it.each([400, 404, 418])('throws a plain Error (not TransientLLMError) on HTTP %i', async (status) => {
    mock = await startStatusServer(status, { error: 'nope' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.not.toBeInstanceOf(TransientLLMError);
  });

  it('throws TransientLLMError on connection refused', async () => {
    // Port 1 — nothing listens here (same convention as ollama.test.ts).
    await expect(fetchWithClassification('http://127.0.0.1:1', { method: 'POST' }, 'Test')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('sets httpStatus on the thrown TransientLLMError', async () => {
    mock = await startStatusServer(503, { error: 'boom' });
    await expect(fetchWithClassification(mock.url, { method: 'POST' }, 'Test')).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('returns the response unchanged on a 2xx status', async () => {
    mock = await startStatusServer(200, { ok: true });
    const res = await fetchWithClassification(mock.url, { method: 'POST' }, 'Test');
    expect(res.ok).toBe(true);
  });
});

describe('createBedrockBearerClient / createLiteLLMClient — classification wiring', () => {
  let mock: { url: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('LiteLLM client propagates TransientLLMError on a 500', async () => {
    mock = await startStatusServer(500, { error: 'boom' });
    const client = createLiteLLMClient({ baseUrl: mock.url, apiKey: 'k', model: 'm', maxTokens: 100 });
    await expect(client.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('Bedrock bearer client propagates a plain Error on a 404 (real AWS host, unreachable — expect network TransientLLMError instead since we cannot mock the hardcoded host)', async () => {
    // createBedrockBearerClient hardcodes the bedrock-runtime.<region>.amazonaws.com host, so it
    // cannot be pointed at a local mock server. A bogus region reliably produces a DNS failure,
    // which fetchWithClassification classifies as a network-level TransientLLMError — this proves
    // the client is wired through fetchWithClassification without needing a real AWS endpoint.
    const client = createBedrockBearerClient({ region: 'not-a-real-region-xyz', model: 'm', maxTokens: 100, bearerToken: 't' });
    await expect(client.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
  });
});
