// B4: Two-stage retrieval with recency fusion.
//
// Stage 1: bi-encoder top-K via the embedding store (cosine similarity).
// Stage 2: a cheap rerank that breaks ties using term overlap with the query
//          (keyword-style precision boost — no remote cross-encoder needed at
//          our scale; we can swap in Bedrock rerank later behind the same
//          `Reranker` interface).
// Stage 3: recency fusion: `final = α · sim + β · exp(-Δt / 30)`.
//
// β is configurable per content type via config.intelligence.recencyWeight.

import type { EmbeddingStore, SearchHit } from '../embeddings/store.js';
import type { KarpathyConfig } from '../config/schema.js';

export type ContentType = 'session' | 'transcript' | 'concept' | 'topic' | 'project' | 'default';

export interface RetrievalOptions {
  topK?: number;
  /** Pool size for stage 1 before rerank+fusion. */
  poolK?: number;
  /** Optional metadata predicate. */
  filter?: (hit: SearchHit) => boolean;
  /** Override the default content-type → β mapping. */
  betaOverride?: number;
}

export interface RankedHit extends SearchHit {
  rerankScore: number;
  recencyScore: number;
  finalScore: number;
}

export interface Reranker {
  rerank(query: string, hits: SearchHit[]): Promise<{ hit: SearchHit; score: number }[]>;
}

/** Default reranker — Jaccard term overlap. Cheap and surprisingly effective for short queries. */
export function createTermOverlapReranker(): Reranker {
  return {
    async rerank(query, hits) {
      const qTokens = new Set(tokenize(query));
      return hits.map((hit) => {
        const dTokens = new Set(tokenize(hit.text));
        const inter = [...qTokens].filter((t) => dTokens.has(t)).length;
        const denom = qTokens.size + dTokens.size - inter || 1;
        const overlap = inter / denom;
        // Combine the bi-encoder similarity with the overlap signal so we
        // never demote a strong embedding match below a poor lexical one.
        const score = 0.7 * hit.similarity + 0.3 * overlap;
        return { hit, score };
      });
    },
  };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function recencyScore(updatedAtIso: string | undefined, nowMs: number): number {
  if (!updatedAtIso) return 0;
  const t = new Date(updatedAtIso).getTime();
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (nowMs - t) / 86400_000);
  return Math.exp(-days / 30);
}

function inferContentType(metadata: Record<string, unknown>): ContentType {
  const t = typeof metadata.type === 'string' ? metadata.type : '';
  if (t === 'session_summary') return 'session';
  if (t === 'source_summary') return 'transcript';
  if (t === 'concept') return 'concept';
  if (t === 'topic') return 'topic';
  if (t === 'project' || t === 'project_spec') return 'project';
  return 'default';
}

export function pickBeta(
  config: KarpathyConfig,
  contentType: ContentType,
  override?: number,
): number {
  if (typeof override === 'number') return override;
  const w = config.intelligence.recencyWeight;
  return w[contentType] ?? w.default;
}

export interface RetrievalDeps {
  store: EmbeddingStore;
  config: KarpathyConfig;
  reranker?: Reranker;
}

export async function retrieve(
  deps: RetrievalDeps,
  query: string,
  options: RetrievalOptions = {},
): Promise<RankedHit[]> {
  const topK = options.topK ?? 10;
  const poolK = options.poolK ?? Math.max(50, topK * 5);
  const reranker = deps.reranker ?? createTermOverlapReranker();
  const nowMs = Date.now();

  // Stage 1: bi-encoder pool.
  // Cast metadata predicate from EmbeddingRow → SearchHit shape (compatible).
  const pool = await deps.store.search(query, {
    topK: poolK,
    filter: options.filter
      ? (row) =>
          options.filter!({
            ...row,
            similarity: 0,
          })
      : undefined,
  });
  if (pool.length === 0) return [];

  // Stage 2: rerank.
  const reranked = await reranker.rerank(query, pool);

  // Stage 3: recency fusion.
  const fused: RankedHit[] = reranked.map(({ hit, score }) => {
    const ct = inferContentType(hit.metadata);
    const beta = pickBeta(deps.config, ct, options.betaOverride);
    const alpha = 1 - beta;
    const recency = recencyScore(hit.updated_at, nowMs);
    return {
      ...hit,
      rerankScore: score,
      recencyScore: recency,
      finalScore: alpha * score + beta * recency,
    };
  });

  fused.sort((a, b) => b.finalScore - a.finalScore);
  return fused.slice(0, topK);
}
