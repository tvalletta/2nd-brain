// A2: Embedding provider interface.
//
// Two implementations ship today:
// - `createDeterministicProvider()` — hash-based 256-dim vectors. Used by tests
//   and as a degraded-mode fallback when no real provider is configured.
// - `createBedrockTitanProvider()` — Amazon Titan Text Embeddings v2 via Bedrock
//   (1024 dims). Production default.
//
// Adding a local model later (e.g. fastembed-js / bge-small) is purely a new
// implementation of this interface — no call-site changes required.

export interface EmbeddingProvider {
  /** Stable identifier — used as the embedding store namespace. Different models cannot share rows. */
  readonly id: string;
  /** Dimensionality of the returned vectors. */
  readonly dimensions: number;
  /** Embed a batch of texts. Length of result === length of inputs. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Deterministic provider (tests & fallback)
// ---------------------------------------------------------------------------

const DETERMINISTIC_DIMS = 256;

function hashToken(token: string, seed: number): number {
  // FNV-1a 32-bit, mixed with seed.
  let h = 2166136261 ^ seed;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createDeterministicProvider(): EmbeddingProvider {
  return {
    id: 'deterministic-v1',
    dimensions: DETERMINISTIC_DIMS,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vec = new Float32Array(DETERMINISTIC_DIMS);
        const tokens = text
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        for (const t of tokens) {
          for (let s = 0; s < 3; s++) {
            const idx = hashToken(t, s) % DETERMINISTIC_DIMS;
            vec[idx] += 1;
          }
        }
        // L2-normalize
        let norm = 0;
        for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < vec.length; i++) vec[i] /= norm;
        return vec;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Bedrock Titan provider
// ---------------------------------------------------------------------------

export interface BedrockTitanOptions {
  region?: string;
  modelId?: string;
  /** Dimensions to request from Titan v2 (256, 512, or 1024). */
  dimensions?: 256 | 512 | 1024;
}

export function createBedrockTitanProvider(opts: BedrockTitanOptions = {}): EmbeddingProvider {
  const region = opts.region ?? 'us-west-2';
  const modelId = opts.modelId ?? 'amazon.titan-embed-text-v2:0';
  const dims = opts.dimensions ?? 1024;

  // Lazy-loaded so test environments don't pay the import cost.
  let clientPromise: Promise<unknown> | null = null;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = import('@aws-sdk/client-bedrock-runtime').then(
        (mod) => new mod.BedrockRuntimeClient({ region }),
      );
    }
    return clientPromise;
  }

  return {
    id: `titan-v2-${dims}`,
    dimensions: dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (await getClient()) as any;
      const mod = await import('@aws-sdk/client-bedrock-runtime');
      const out: Float32Array[] = [];
      for (const text of texts) {
        const body = JSON.stringify({ inputText: text, dimensions: dims, normalize: true });
        const cmd = new mod.InvokeModelCommand({
          modelId,
          body,
          accept: 'application/json',
          contentType: 'application/json',
        });
        const res = await client.send(cmd);
        const decoded = new TextDecoder().decode(res.body as Uint8Array);
        const parsed = JSON.parse(decoded) as { embedding: number[] };
        out.push(Float32Array.from(parsed.embedding));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Math helpers used by retrieval & clustering
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
