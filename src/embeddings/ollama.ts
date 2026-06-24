// Ollama embedding provider — always-on local model.
//
// Ships with the hybrid-search module. Talks to a locally-running Ollama daemon
// (default: http://localhost:11434), single-prompt-per-call against /api/embeddings,
// and L2-normalizes the vector to keep cosine similarity consistent with the
// deterministic and Bedrock Titan providers.
//
// `isOllamaAvailable()` is a 5s-default probe used by HybridStore to decide
// whether to fan out a semantic pool or fall back to keyword-only mode. The
// probe never throws — connection refused, timeout, and non-2xx responses all
// resolve to `false`.

import type { EmbeddingProvider } from './provider.js';

export interface OllamaProviderOptions {
  /** Ollama HTTP base URL — typically `http://localhost:11434`. */
  baseUrl: string;
  /** Model name registered with `ollama pull` (e.g. `nomic-embed-text`). */
  model: string;
  /** Vector dimensionality for `nomic-embed-text` is 768. */
  dimensions?: number;
  /** Per-call HTTP timeout. Defaults to 5000ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_DIMENSIONS = 768;

interface OllamaEmbedResponse {
  embedding: number[];
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function postEmbedding(
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<Float32Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama embedding request failed: ${res.status} ${res.statusText} ${text}`);
    }
    const parsed = (await res.json()) as OllamaEmbedResponse;
    if (!Array.isArray(parsed.embedding)) {
      throw new Error(`Ollama response missing embedding array: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    return normalize(Float32Array.from(parsed.embedding));
  } finally {
    clearTimeout(timer);
  }
}

export function createOllamaProvider(opts: OllamaProviderOptions): EmbeddingProvider {
  const baseUrl = opts.baseUrl;
  const model = opts.model;
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: `ollama-${model}-${dimensions}`,
    dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (const text of texts) {
        out.push(await postEmbedding(baseUrl, model, text, timeoutMs));
      }
      return out;
    },
  };
}

/**
 * Probe whether the Ollama daemon is reachable. Resolves to `true` only on a
 * 2xx response from `/api/tags` (the cheapest endpoint that confirms the server
 * is up). Connection errors, timeouts, and non-2xx responses all resolve to
 * `false`. Never throws — callers use the boolean to switch into keyword-only
 * fallback mode.
 */
export async function isOllamaAvailable(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
