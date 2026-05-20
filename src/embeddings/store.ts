// A2: Content-addressable embedding store.
//
// Backed by better-sqlite3 (already a dep). Keyed by `(provider_id, doc_id, chunk_hash)`.
// Stores raw Float32 vectors as BLOBs; no extension required. Brute-force cosine
// scan is plenty fast for our scale (≤100k chunks, <100ms).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  type EmbeddingProvider,
  bufferToVector,
  cosineSimilarity,
  vectorToBuffer,
} from './provider.js';

export interface EmbeddingRow {
  doc_id: string;
  chunk_index: number;
  chunk_hash: string;
  text: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface UpsertInput {
  doc_id: string;
  chunk_index: number;
  chunk_hash: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  doc_id: string;
  chunk_index: number;
  chunk_hash: string;
  text: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  similarity: number;
}

/**
 * Phase 0: cache observability. `hits` = chunks reused from a prior embed of
 * the same `(provider_id, chunk_hash)`; `misses` = chunks sent to the provider.
 */
export interface CacheStats {
  hits: number;
  misses: number;
}

export interface EmbeddingStore {
  upsert(inputs: UpsertInput[]): Promise<void>;
  /** Get all rows for a given doc_id (used to prune chunks no longer present). */
  getByDoc(docId: string): EmbeddingRow[];
  /** Replace all chunks for `doc_id` with the provided list (anything missing is deleted). */
  replaceDoc(docId: string, inputs: UpsertInput[]): Promise<void>;
  deleteDoc(docId: string): void;
  /** Brute-force cosine search. `filter` is an optional predicate over metadata. */
  search(
    queryText: string,
    options?: { topK?: number; filter?: (row: EmbeddingRow) => boolean },
  ): Promise<SearchHit[]>;
  /** Iterate every row — used by clustering / digest jobs. */
  all(filter?: (row: EmbeddingRow) => boolean): EmbeddingRow[];
  count(): number;
  /** Cumulative cache hit/miss counters since the store was opened. */
  getCacheStats(): CacheStats;
  /** Reset the in-memory cache stats (used by tests). */
  resetCacheStats(): void;
  close(): void;
}

export interface EmbeddingStoreOptions {
  dbPath: string;
  provider: EmbeddingProvider;
}

export function openEmbeddingStore(opts: EmbeddingStoreOptions): EmbeddingStore {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      provider_id TEXT NOT NULL,
      doc_id      TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash  TEXT NOT NULL,
      text        TEXT NOT NULL,
      vector      BLOB NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (provider_id, doc_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_emb_doc ON embeddings(provider_id, doc_id);
    CREATE INDEX IF NOT EXISTS idx_emb_hash ON embeddings(provider_id, chunk_hash);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO embeddings (provider_id, doc_id, chunk_index, chunk_hash, text, vector, metadata, updated_at)
    VALUES (@provider_id, @doc_id, @chunk_index, @chunk_hash, @text, @vector, @metadata, @updated_at)
    ON CONFLICT(provider_id, doc_id, chunk_index) DO UPDATE SET
      chunk_hash = excluded.chunk_hash,
      text       = excluded.text,
      vector     = excluded.vector,
      metadata   = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  const selectByDocStmt = db.prepare(
    `SELECT doc_id, chunk_index, chunk_hash, text, vector, metadata, updated_at
     FROM embeddings WHERE provider_id = ? AND doc_id = ? ORDER BY chunk_index`,
  );
  const selectAllStmt = db.prepare(
    `SELECT doc_id, chunk_index, chunk_hash, text, vector, metadata, updated_at
     FROM embeddings WHERE provider_id = ?`,
  );
  const deleteDocStmt = db.prepare(`DELETE FROM embeddings WHERE provider_id = ? AND doc_id = ?`);
  const deleteChunkStmt = db.prepare(
    `DELETE FROM embeddings WHERE provider_id = ? AND doc_id = ? AND chunk_index = ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE provider_id = ?`);

  // Phase 0 cache: pull a vector by (provider_id, chunk_hash). The hash is a
  // content-addressable key, so any chunk we've already embedded under this
  // provider can be reused without another LLM/Bedrock call.
  const cacheLookupStmt = db.prepare(
    `SELECT vector FROM embeddings WHERE provider_id = ? AND chunk_hash = ? LIMIT 1`,
  );

  let cacheHits = 0;
  let cacheMisses = 0;

  /**
   * Embed `inputs` while skipping any whose `chunk_hash` already exists in the
   * store under the same provider. Returns vectors aligned 1:1 with `inputs`.
   */
  async function embedWithCache(inputs: UpsertInput[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const out: (Float32Array | null)[] = new Array(inputs.length).fill(null);
    const missIdxs: number[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const cached = cacheLookupStmt.get(opts.provider.id, inputs[i].chunk_hash) as
        | { vector: Buffer }
        | undefined;
      if (cached) {
        out[i] = bufferToVector(cached.vector);
        cacheHits++;
      } else {
        missIdxs.push(i);
        missTexts.push(inputs[i].text);
      }
    }

    if (missTexts.length > 0) {
      const fresh = await opts.provider.embed(missTexts);
      for (let j = 0; j < missIdxs.length; j++) {
        out[missIdxs[j]] = fresh[j];
      }
      cacheMisses += missTexts.length;
    }

    return out as Float32Array[];
  }

  function rowToTyped(row: {
    doc_id: string;
    chunk_index: number;
    chunk_hash: string;
    text: string;
    vector: Buffer;
    metadata: string;
    updated_at: string;
  }): EmbeddingRow {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = {};
    }
    return {
      doc_id: row.doc_id,
      chunk_index: row.chunk_index,
      chunk_hash: row.chunk_hash,
      text: row.text,
      vector: bufferToVector(row.vector),
      metadata,
      updated_at: row.updated_at,
    };
  }

  return {
    async upsert(inputs: UpsertInput[]) {
      if (inputs.length === 0) return;
      const vectors = await embedWithCache(inputs);
      const now = new Date().toISOString();
      const tx = db.transaction((items: UpsertInput[]) => {
        items.forEach((it, idx) => {
          upsertStmt.run({
            provider_id: opts.provider.id,
            doc_id: it.doc_id,
            chunk_index: it.chunk_index,
            chunk_hash: it.chunk_hash,
            text: it.text,
            vector: vectorToBuffer(vectors[idx]),
            metadata: JSON.stringify(it.metadata ?? {}),
            updated_at: now,
          });
        });
      });
      tx(inputs);
    },

    getByDoc(docId: string): EmbeddingRow[] {
      const rows = selectByDocStmt.all(opts.provider.id, docId) as Parameters<typeof rowToTyped>[0][];
      return rows.map(rowToTyped);
    },

    async replaceDoc(docId: string, inputs: UpsertInput[]) {
      // Compute embeddings first (outside the txn — async work).
      const vectors = inputs.length > 0 ? await embedWithCache(inputs) : [];
      const now = new Date().toISOString();
      const existing = this.getByDoc(docId);
      const wantedIndices = new Set(inputs.map((i) => i.chunk_index));

      const tx = db.transaction(() => {
        for (const row of existing) {
          if (!wantedIndices.has(row.chunk_index)) {
            deleteChunkStmt.run(opts.provider.id, docId, row.chunk_index);
          }
        }
        inputs.forEach((it, idx) => {
          upsertStmt.run({
            provider_id: opts.provider.id,
            doc_id: it.doc_id,
            chunk_index: it.chunk_index,
            chunk_hash: it.chunk_hash,
            text: it.text,
            vector: vectorToBuffer(vectors[idx]),
            metadata: JSON.stringify(it.metadata ?? {}),
            updated_at: now,
          });
        });
      });
      tx();
    },

    deleteDoc(docId: string) {
      deleteDocStmt.run(opts.provider.id, docId);
    },

    async search(queryText, options = {}) {
      const topK = options.topK ?? 10;
      const [qVec] = await opts.provider.embed([queryText]);
      const allRows = (selectAllStmt.all(opts.provider.id) as Parameters<typeof rowToTyped>[0][]).map(
        rowToTyped,
      );
      const filtered = options.filter ? allRows.filter(options.filter) : allRows;
      const scored = filtered.map((row) => ({
        doc_id: row.doc_id,
        chunk_index: row.chunk_index,
        chunk_hash: row.chunk_hash,
        text: row.text,
        metadata: row.metadata,
        updated_at: row.updated_at,
        similarity: cosineSimilarity(qVec, row.vector),
      }));
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, topK);
    },

    all(filter) {
      const rows = (selectAllStmt.all(opts.provider.id) as Parameters<typeof rowToTyped>[0][]).map(
        rowToTyped,
      );
      return filter ? rows.filter(filter) : rows;
    },

    count(): number {
      const row = countStmt.get(opts.provider.id) as { n: number };
      return row.n;
    },

    getCacheStats(): CacheStats {
      return { hits: cacheHits, misses: cacheMisses };
    },

    resetCacheStats() {
      cacheHits = 0;
      cacheMisses = 0;
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Chunking helper
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export interface Chunk {
  index: number;
  text: string;
  hash: string;
}

/**
 * Naive paragraph-aware chunker. Joins paragraphs greedily up to `targetChars`,
 * then emits a chunk. No overlap (we don't need it for retrieval at this scale,
 * and avoiding overlap keeps clustering cleaner).
 *
 * Has a hard cap (`maxChars`, default 12,000) so a single oversized paragraph
 * — e.g. an unbroken JSON blob, a long bullet list, or a wiki-link-dense index
 * page — gets sliced into manageable pieces.
 *
 * The cap is conservative on purpose: Bedrock Titan v2 limits inputs to
 * 8,192 tokens per call, and link-dense markdown (e.g. an auto-generated
 * `_index.md` of `[[wikilinks]]`) tokenizes at as little as ~1.5 chars/token,
 * which makes a "safe" cap of 4 chars/token × 8192 = 32k unsafe in practice.
 * 12,000 chars stays well under for any realistic tokenization.
 */
export function chunkText(text: string, targetChars = 1200, maxChars = 12_000): Chunk[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let index = 0;

  const emit = () => {
    if (buf.length === 0) return;
    const joined = buf.join('\n\n');
    chunks.push({ index, text: joined, hash: hashChunk(joined) });
    index += 1;
    buf = [];
    bufLen = 0;
  };

  function hardSplit(paragraph: string): string[] {
    const out: string[] = [];
    // Prefer splitting on sentence boundaries, then newlines, then anywhere.
    let remaining = paragraph;
    while (remaining.length > maxChars) {
      // Find a good break in the [maxChars*0.6, maxChars] window.
      const window = remaining.slice(0, maxChars);
      const minBreak = Math.floor(maxChars * 0.6);
      let breakAt = -1;
      const breakers = [/.+?[.!?]\s/g, /\n+/g, /\s+/g];
      for (const re of breakers) {
        const matches = [...window.matchAll(re)];
        const m = matches.reverse().find((mm) => (mm.index ?? 0) >= minBreak);
        if (m) {
          breakAt = (m.index ?? 0) + m[0].length;
          break;
        }
      }
      if (breakAt < 0) breakAt = maxChars;
      out.push(remaining.slice(0, breakAt).trim());
      remaining = remaining.slice(breakAt);
    }
    if (remaining.trim()) out.push(remaining.trim());
    return out;
  }

  for (const raw of paragraphs) {
    // Hard-split any single paragraph that exceeds the per-chunk ceiling.
    const pieces = raw.length > maxChars ? hardSplit(raw) : [raw];
    for (const p of pieces) {
      if (bufLen + p.length > targetChars && buf.length > 0) emit();
      buf.push(p);
      bufLen += p.length + 2;
    }
  }
  emit();

  return chunks;
}

export function hashChunk(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
