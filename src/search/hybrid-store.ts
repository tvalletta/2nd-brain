// HybridStore — single entry-point for vault search.
//
// Composes:
//   - FTSIndex (FTS5/BM25 keyword pool over the entire vault)
//   - EmbeddingStore (cosine similarity pool over ingest-pipeline content)
//   - Reciprocal Rank Fusion to merge them
//   - Recency fusion (`final = α · rrf + β · exp(-Δt/30)`) using the existing
//     per-content-type β from `config.intelligence.recencyWeight`.
//
// Degradation: if Ollama (or whichever provider is configured) is unreachable
// when the search() call starts, we skip the semantic pool entirely and return
// `searchMode: 'keyword-only'` with a degradation_note. FTS5 still produces
// results so the call is never an error.

import type Database from 'better-sqlite3';
import type { KarpathyConfig } from '../config/schema.js';
import type {
  EmbeddingStore,
  UpsertInput,
} from '../embeddings/store.js';
import { isOllamaAvailable } from '../embeddings/ollama.js';
import { pickBeta, type ContentType } from '../intelligence/retrieval.js';
import type { FTSIndex, SyncStats } from './fts-index.js';
import { rrf } from './rrf.js';

export interface HybridHit {
  docId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  scores: {
    /** 0-indexed BM25 rank in the keyword pool, if matched. */
    keywordRank?: number;
    /** Cosine similarity in the semantic pool, if matched. */
    semanticSim?: number;
    /** RRF score before recency. */
    rrf: number;
    /** `exp(-Δt / 30)` for the chunk's updated_at. */
    recency: number;
    /** Final blended ranking score `α · rrf + β · recency`. */
    final: number;
  };
  /** FTS5 snippet if keyword matched, else the chunk text. */
  excerpt: string;
}

export interface HybridSearchOptions {
  topK?: number;
  /** Pool size per stage before RRF + recency fusion. Default `max(50, topK*5)`. */
  poolK?: number;
  filter?: (hit: HybridHit) => boolean;
  scope?: 'vault' | 'this-week' | 'project';
  projectSlug?: string;
  noteType?: string;
  /** Override the per-content-type β fusion weight. */
  betaOverride?: number;
}

export interface HybridSearchResult {
  hits: HybridHit[];
  searchMode: 'hybrid' | 'keyword-only';
  degradationNote?: string;
}

export interface HybridStore {
  search(query: string, options?: HybridSearchOptions): Promise<HybridSearchResult>;
  /** Update both indexes for a single doc (called from the ingest pipeline). */
  upsertDoc(
    docId: string,
    title: string,
    body: string,
    chunks: UpsertInput[],
  ): Promise<void>;
  /** Remove a doc from both indexes. */
  deleteDoc(docId: string): Promise<void>;
  /** Run the FTS5 mtime-based sync over the supplied vault directories. */
  syncFTS(vaultDirs: string[]): Promise<SyncStats>;
  /** Drop the underlying SQLite handle. Closes both stores. */
  close(): void;
  /** Direct access (used by the unified MCP tool's metadata fetch). */
  readonly fts: FTSIndex;
  readonly embeddings: EmbeddingStore;
}

export interface HybridStoreOptions {
  config: KarpathyConfig;
  db: Database.Database;
  fts: FTSIndex;
  embeddings: EmbeddingStore;
  /** Probe override for tests — defaults to `isOllamaAvailable(config.embeddings.baseUrl)`. */
  isProviderAvailable?: () => Promise<boolean>;
}

export function createHybridStore(opts: HybridStoreOptions): HybridStore {
  const { config, fts, embeddings } = opts;
  const isProviderAvailable = opts.isProviderAvailable ?? defaultProviderProbe(config);

  return {
    fts,
    embeddings,

    async search(query, options = {}) {
      const topK = options.topK ?? 10;
      const poolK = options.poolK ?? Math.max(50, topK * 5);

      const ftsHits = fts.query(query, poolK);
      // Lightweight semantic-hit shape — we never need the BLOB vector after
      // the embedding store has scored it, so don't carry it through.
      type SemanticHit = {
        doc_id: string;
        chunk_index: number;
        chunk_hash: string;
        text: string;
        metadata: Record<string, unknown>;
        updated_at: string;
        similarity: number;
      };
      let semanticHits: SemanticHit[] = [];
      let searchMode: 'hybrid' | 'keyword-only' = 'hybrid';
      let degradationNote: string | undefined;

      // Embedding pool — gated on provider availability.
      const providerUp =
        config.embeddings.provider === 'ollama' ? await isProviderAvailable() : true;

      if (providerUp) {
        try {
          const raw = await embeddings.search(query, { topK: poolK });
          semanticHits = raw.map((h) => ({
            doc_id: h.doc_id,
            chunk_index: h.chunk_index,
            chunk_hash: h.chunk_hash,
            text: h.text,
            metadata: h.metadata,
            updated_at: h.updated_at,
            similarity: h.similarity,
          }));
        } catch (err) {
          searchMode = 'keyword-only';
          degradationNote = `Semantic search unavailable: ${(err as Error).message}. Returning keyword results only.`;
        }
      } else {
        searchMode = 'keyword-only';
        degradationNote =
          config.embeddings.provider === 'ollama'
            ? 'Ollama not running — keyword results only. Run `ollama serve` to enable semantic search.'
            : 'Embedding provider unavailable — keyword results only.';
      }

      // ---- Stage 2: Reciprocal Rank Fusion ---------------------------------
      const keywordRanks = new Map<string, number>();
      ftsHits.forEach((h, i) => {
        if (!keywordRanks.has(h.docId)) keywordRanks.set(h.docId, i);
      });
      const semanticRanks = new Map<string, number>();
      // Best chunk per doc wins — sorted by similarity already, so keep the first occurrence.
      semanticHits.forEach((h, i) => {
        if (!semanticRanks.has(h.doc_id)) semanticRanks.set(h.doc_id, i);
      });

      const lists: Array<Array<{ docId: string; rank: number }>> = [];
      lists.push([...keywordRanks].map(([docId, rank]) => ({ docId, rank })));
      if (semanticHits.length > 0) {
        lists.push([...semanticRanks].map(([docId, rank]) => ({ docId, rank })));
      }
      const fused = rrf(lists);

      // ---- Stage 3: Hydrate per-doc metadata + recency fusion --------------
      const ftsByDoc = new Map(ftsHits.map((h) => [h.docId, h]));
      const semanticBestByDoc = new Map<string, SemanticHit>();
      for (const h of semanticHits) {
        const prior = semanticBestByDoc.get(h.doc_id);
        if (!prior || h.similarity > prior.similarity) {
          semanticBestByDoc.set(h.doc_id, h);
        }
      }

      // Batched mtime lookup for keyword-only hits — one SQLite roundtrip
      // instead of one per fused result.
      const docsNeedingMtime = fused
        .filter((f) => !semanticBestByDoc.has(f.docId))
        .map((f) => f.docId);
      const mtimeByDoc = fts.getMtimesISO(docsNeedingMtime);

      const nowMs = Date.now();
      const oneWeekAgo = nowMs - 7 * 86400_000;

      const hits: HybridHit[] = [];
      for (const { docId, score } of fused) {
        const ftsHit = ftsByDoc.get(docId);
        const sem = semanticBestByDoc.get(docId);

        // Skip if the doc has neither — shouldn't happen but defensive.
        if (!ftsHit && !sem) continue;

        const chunkIndex = sem?.chunk_index ?? 0;
        const text = sem?.text ?? '';
        const metadata: Record<string, unknown> = sem?.metadata ?? {};
        // Recency falls back to fts_meta.file_mtime when there is no
        // embedding row — otherwise keyword-only hits would all score
        // recency=0 and lose the freshness boost the spec calls for.
        const updatedAt =
          sem?.updated_at ||
          (typeof metadata.updated_at === 'string' ? metadata.updated_at : '') ||
          mtimeByDoc.get(docId) ||
          '';

        const ct = inferContentType(metadata);
        const beta = pickBeta(config, ct, options.betaOverride);
        const alpha = 1 - beta;
        const recency = recencyScore(updatedAt, nowMs);
        const finalScore = alpha * score + beta * recency;

        const hit: HybridHit = {
          docId,
          chunkIndex,
          text,
          metadata,
          updated_at: updatedAt,
          scores: {
            keywordRank: ftsHit ? keywordRanks.get(docId) : undefined,
            semanticSim: sem?.similarity,
            rrf: score,
            recency,
            final: finalScore,
          },
          excerpt: ftsHit?.snippet || (text ? text.slice(0, 320) : ''),
        };

        // Filters --------------------------------------------------------
        if (options.scope === 'this-week') {
          const t = updatedAt ? new Date(updatedAt).getTime() : 0;
          if (!t || t < oneWeekAgo) continue;
        }
        if (options.scope === 'project') {
          if (!options.projectSlug) continue;
          if (metadata.project_slug !== options.projectSlug) continue;
        }
        if (options.noteType) {
          if (metadata.type !== options.noteType) continue;
        }
        if (options.filter && !options.filter(hit)) continue;

        hits.push(hit);
      }

      hits.sort((a, b) => b.scores.final - a.scores.final);
      const sliced = hits.slice(0, topK);

      const result: HybridSearchResult = { hits: sliced, searchMode };
      if (degradationNote) result.degradationNote = degradationNote;
      return result;
    },

    async upsertDoc(docId, title, body, chunks) {
      fts.upsert(docId, title, body);
      if (chunks.length === 0) {
        embeddings.deleteDoc(docId);
      } else {
        await embeddings.replaceDoc(docId, chunks);
      }
    },

    async deleteDoc(docId) {
      fts.delete(docId);
      embeddings.deleteDoc(docId);
    },

    async syncFTS(vaultDirs) {
      return fts.sync(vaultDirs);
    },

    close() {
      embeddings.close();
    },
  };
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

function recencyScore(updatedAtIso: string | undefined, nowMs: number): number {
  if (!updatedAtIso) return 0;
  const t = new Date(updatedAtIso).getTime();
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (nowMs - t) / 86400_000);
  return Math.exp(-days / 30);
}

function defaultProviderProbe(config: KarpathyConfig): () => Promise<boolean> {
  return async () => {
    if (config.embeddings.provider !== 'ollama') return true;
    return isOllamaAvailable(config.embeddings.baseUrl, config.embeddings.timeoutMs);
  };
}
