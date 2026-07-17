// A2: Content-addressable embedding store.
//
// Backed by better-sqlite3 (already a dep). Keyed by `(provider_id, doc_id, chunk_hash)`.
// Stores raw Float32 vectors as BLOBs, and dual-writes them into a `vec_embeddings`
// vec0 virtual table (via the `sqlite-vec` extension) for KNN-accelerated search —
// see `search()` below.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  type EmbeddingProvider,
  bufferToVector,
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
  /** KNN cosine search via the `vec_embeddings` vec0 virtual table. `filter` is an optional predicate over metadata. */
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
  /**
   * Delete every row owned by `providerId`. Used by `karpathy maintenance
   * --prune-provider <id>` after switching the active provider so old vectors
   * don't accumulate.
   */
  pruneProvider(providerId: string): number;
  /** List distinct provider ids currently stored. */
  listProviders(): { provider_id: string; rows: number }[];
  close(): void;
}

export interface EmbeddingStoreOptions {
  /** Path to the SQLite file. Required when `db` is not supplied. */
  dbPath?: string;
  provider: EmbeddingProvider;
  /**
   * Optional pre-opened better-sqlite3 handle. When provided, the store does
   * NOT close the handle in `close()` — the caller (e.g. HybridStore) owns
   * the connection lifecycle. Used so the FTS index and the embedding store
   * can share `.karpathy/state/embeddings.sqlite` without two connections.
   */
  db?: Database.Database;
}

export function openEmbeddingStore(opts: EmbeddingStoreOptions): EmbeddingStore {
  const ownsDb = !opts.db;
  let db: Database.Database;
  if (opts.db) {
    db = opts.db;
  } else {
    if (!opts.dbPath) {
      throw new Error('openEmbeddingStore requires either `db` or `dbPath`');
    }
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    db = new Database(opts.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  sqliteVec.load(db);

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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      vector float[${opts.provider.dimensions}] distance_metric=cosine
    );
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

  // vec0 virtual tables support neither `ON CONFLICT ... DO UPDATE` (fails at
  // prepare time: "UPSERT not implemented for virtual table") nor
  // `INSERT OR REPLACE` (fails at run time: "UNIQUE constraint failed" — the
  // module doesn't implement REPLACE conflict resolution either). The
  // supported idiom is an explicit delete-then-insert, wrapped below in
  // `vecUpsert`. Also, vec0 enforces that its rowid bind value have SQLite
  // storage class INTEGER; better-sqlite3 binds plain JS numbers as REAL
  // (`sqlite3_bind_double`) unless given a BigInt, which vec0 then rejects
  // with "Only integers are allowed for primary key values" — so rowids are
  // always wrapped in `BigInt(...)` before being bound here.
  const vecInsertStmt = db.prepare(`INSERT INTO vec_embeddings (rowid, vector) VALUES (?, ?)`);
  const vecDeleteByRowidStmt = db.prepare(`DELETE FROM vec_embeddings WHERE rowid = ?`);
  const embeddingRowidStmt = db.prepare(
    `SELECT rowid FROM embeddings WHERE provider_id = ? AND doc_id = ? AND chunk_index = ?`,
  );

  function vecDeleteRowid(rowid: number): void {
    vecDeleteByRowidStmt.run(BigInt(rowid));
  }

  function vecUpsert(rowid: number, vector: Buffer): void {
    vecDeleteRowid(rowid);
    vecInsertStmt.run(BigInt(rowid), vector);
  }

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

  /** Looks up the definitive rowid for a just-upserted embeddings row (not
   * `.lastInsertRowid` from the upsert statement, whose semantics on the
   * ON CONFLICT DO UPDATE branch aren't reliably "the updated row" across
   * better-sqlite3/SQLite versions — an explicit lookup is unambiguous). */
  function currentRowid(providerId: string, docId: string, chunkIndex: number): number {
    const row = embeddingRowidStmt.get(providerId, docId, chunkIndex) as { rowid: number };
    return row.rowid;
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
          const rowid = currentRowid(opts.provider.id, it.doc_id, it.chunk_index);
          vecUpsert(rowid, vectorToBuffer(vectors[idx]));
        });
      });
      tx(inputs);
    },

    getByDoc(docId: string): EmbeddingRow[] {
      const rows = selectByDocStmt.all(opts.provider.id, docId) as Parameters<typeof rowToTyped>[0][];
      return rows.map(rowToTyped);
    },

    async replaceDoc(docId: string, inputs: UpsertInput[]) {
      // Kick off the existing-rows read in parallel with the embedding call —
      // both are independent and the SQLite read can finish while Bedrock /
      // Ollama is still on the wire. `Promise.resolve(...)` over a sync
      // statement just keeps the await/parallelism shape uniform.
      const existingPromise = Promise.resolve(this.getByDoc(docId));
      const vectors = inputs.length > 0 ? await embedWithCache(inputs) : [];
      const existing = await existingPromise;
      const now = new Date().toISOString();
      const wantedIndices = new Set(inputs.map((i) => i.chunk_index));

      const tx = db.transaction(() => {
        for (const row of existing) {
          if (!wantedIndices.has(row.chunk_index)) {
            const staleRowid = currentRowid(opts.provider.id, docId, row.chunk_index);
            deleteChunkStmt.run(opts.provider.id, docId, row.chunk_index);
            vecDeleteRowid(staleRowid);
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
          const rowid = currentRowid(opts.provider.id, it.doc_id, it.chunk_index);
          vecUpsert(rowid, vectorToBuffer(vectors[idx]));
        });
      });
      tx();
    },

    deleteDoc(docId: string) {
      const rows = db.prepare(`SELECT rowid FROM embeddings WHERE provider_id = ? AND doc_id = ?`).all(opts.provider.id, docId) as { rowid: number }[];
      const tx = db.transaction(() => {
        deleteDocStmt.run(opts.provider.id, docId);
        for (const row of rows) vecDeleteRowid(row.rowid);
      });
      tx();
    },

    async search(queryText, options = {}) {
      const topK = options.topK ?? 10;
      const [qVec] = await opts.provider.embed([queryText]);
      const qBuf = vectorToBuffer(qVec);

      // sqlite-vec's KNN doesn't support an arbitrary JS predicate mid-query,
      // so when a `filter` is given, over-fetch a wider candidate window
      // (10x topK, capped) and filter in JS after hydrating full rows — this
      // preserves the exact same filter semantics as the old brute-force
      // path, just with a much cheaper candidate-generation step.
      const knnLimit = options.filter ? Math.min(topK * 10, 2000) : topK;

      const knnRows = db
        .prepare(
          `SELECT rowid, distance FROM vec_embeddings WHERE vector MATCH ? AND k = ? ORDER BY distance`,
        )
        .all(qBuf, knnLimit) as Array<{ rowid: number; distance: number }>;

      if (knnRows.length === 0) return [];

      const rowids = knnRows.map((r) => r.rowid);
      const placeholders = rowids.map(() => '?').join(',');
      const hydrated = db
        .prepare(
          `SELECT rowid, doc_id, chunk_index, chunk_hash, text, vector, metadata, updated_at
           FROM embeddings WHERE rowid IN (${placeholders})`,
        )
        .all(...rowids) as Array<Parameters<typeof rowToTyped>[0] & { rowid: number }>;
      const byRowid = new Map(hydrated.map((r) => [r.rowid, rowToTyped(r)]));

      // cosine distance in sqlite-vec is `1 - cosine_similarity` — convert
      // back to similarity so callers (and existing tests/callers expecting
      // `SearchHit.similarity`) see the same semantics as before.
      const scored: SearchHit[] = [];
      for (const { rowid, distance } of knnRows) {
        const row = byRowid.get(rowid);
        if (!row) continue;
        if (options.filter && !options.filter(row)) continue;
        scored.push({
          doc_id: row.doc_id,
          chunk_index: row.chunk_index,
          chunk_hash: row.chunk_hash,
          text: row.text,
          metadata: row.metadata,
          updated_at: row.updated_at,
          similarity: 1 - distance,
        });
        if (scored.length >= topK) break;
      }
      return scored;
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

    pruneProvider(providerId: string) {
      const result = db
        .prepare(`DELETE FROM embeddings WHERE provider_id = ?`)
        .run(providerId);
      return Number(result.changes ?? 0);
    },

    listProviders() {
      const rows = db
        .prepare(`SELECT provider_id, COUNT(*) AS rows FROM embeddings GROUP BY provider_id`)
        .all() as { provider_id: string; rows: number }[];
      return rows;
    },

    close() {
      if (ownsDb) db.close();
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
