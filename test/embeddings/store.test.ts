import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  openEmbeddingStore,
  createDeterministicProvider,
  chunkText,
  hashChunk,
  cosineSimilarity,
} from '../../src/embeddings/index.js';

describe('embedding store', () => {
  let dir: string;
  let store: ReturnType<typeof openEmbeddingStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-emb-'));
    store = openEmbeddingStore({
      dbPath: join(dir, 'embeddings.sqlite'),
      provider: createDeterministicProvider(),
    });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('upsert + count + getByDoc', async () => {
    await store.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'fsrs spaced repetition', metadata: { tag: 'ml' } },
      { doc_id: 'a.md', chunk_index: 1, chunk_hash: 'h2', text: 'second chunk' },
    ]);
    expect(store.count()).toBe(2);
    const rows = store.getByDoc('a.md');
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata.tag).toBe('ml');
    expect(rows[0].vector.length).toBe(256);
  });

  it('upsert is idempotent on (doc, chunk_index)', async () => {
    await store.upsert([{ doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'one' }]);
    await store.upsert([{ doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'one' }]);
    expect(store.count()).toBe(1);
  });

  it('replaceDoc deletes missing chunks', async () => {
    await store.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'one' },
      { doc_id: 'a.md', chunk_index: 1, chunk_hash: 'h2', text: 'two' },
    ]);
    await store.replaceDoc('a.md', [
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1-new', text: 'one revised' },
    ]);
    const rows = store.getByDoc('a.md');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('one revised');
    expect(rows[0].chunk_hash).toBe('h1-new');
  });

  it('search returns most similar chunks', async () => {
    await store.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'fsrs spaced repetition algorithm' },
      { doc_id: 'b.md', chunk_index: 0, chunk_hash: 'h2', text: 'unrelated cooking recipe ingredients' },
    ]);
    const hits = await store.search('fsrs algorithm', { topK: 2 });
    expect(hits[0].doc_id).toBe('a.md');
    expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
  });

  it('search applies filter predicate', async () => {
    await store.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'fsrs algorithm', metadata: { type: 'concept' } },
      { doc_id: 'b.md', chunk_index: 0, chunk_hash: 'h2', text: 'fsrs algorithm', metadata: { type: 'session' } },
    ]);
    const hits = await store.search('fsrs', { filter: (r) => r.metadata.type === 'concept' });
    expect(hits.every((h) => h.doc_id === 'a.md')).toBe(true);
  });

  it('cache: reuses vectors across upserts when chunk_hash repeats', async () => {
    // Wrap the deterministic provider with a counter so we can assert
    // the embed() backend was only called once per unique chunk_hash.
    const inner = createDeterministicProvider();
    let embedCalls = 0;
    const counted = {
      id: inner.id,
      dimensions: inner.dimensions,
      async embed(texts: string[]) {
        embedCalls += texts.length;
        return inner.embed(texts);
      },
    };
    const localStore = openEmbeddingStore({
      dbPath: join(dir, 'cache-test.sqlite'),
      provider: counted,
    });

    await localStore.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'fsrs spaced repetition' },
      { doc_id: 'a.md', chunk_index: 1, chunk_hash: 'h2', text: 'second chunk' },
    ]);
    expect(embedCalls).toBe(2);
    expect(localStore.getCacheStats()).toEqual({ hits: 0, misses: 2 });

    // Re-upsert with same hashes (e.g. another doc references the same chunk).
    await localStore.upsert([
      { doc_id: 'b.md', chunk_index: 0, chunk_hash: 'h1', text: 'fsrs spaced repetition' },
    ]);
    expect(embedCalls).toBe(2); // no new embed call
    expect(localStore.getCacheStats()).toEqual({ hits: 1, misses: 2 });

    // A new hash forces a fresh embed.
    await localStore.upsert([
      { doc_id: 'c.md', chunk_index: 0, chunk_hash: 'h3', text: 'novel chunk' },
    ]);
    expect(embedCalls).toBe(3);
    expect(localStore.getCacheStats()).toEqual({ hits: 1, misses: 3 });

    localStore.close();
  });

  it('cache: replaceDoc reuses cached vectors for identical hashes', async () => {
    const inner = createDeterministicProvider();
    let embedCalls = 0;
    const counted = {
      id: inner.id,
      dimensions: inner.dimensions,
      async embed(texts: string[]) {
        embedCalls += texts.length;
        return inner.embed(texts);
      },
    };
    const localStore = openEmbeddingStore({
      dbPath: join(dir, 'cache-replace.sqlite'),
      provider: counted,
    });

    await localStore.upsert([
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'one' },
    ]);
    expect(embedCalls).toBe(1);

    // replaceDoc with identical chunk_hash should not re-embed.
    await localStore.replaceDoc('a.md', [
      { doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'one' },
    ]);
    expect(embedCalls).toBe(1);
    expect(localStore.getCacheStats().hits).toBeGreaterThanOrEqual(1);

    localStore.close();
  });

  it('cosineSimilarity is bounded', async () => {
    const provider = createDeterministicProvider();
    const [a, b] = await provider.embed(['hello world', 'hello world']);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    const [c] = await provider.embed(['totally unrelated banana']);
    expect(cosineSimilarity(a, c)).toBeLessThan(1);
    expect(cosineSimilarity(a, c)).toBeGreaterThanOrEqual(-1);
  });
});

describe('vec_embeddings (sqlite-vec) integration', () => {
  let vecDir: string;
  let vecDb: Database.Database;

  beforeEach(async () => {
    vecDir = await mkdtemp(join(tmpdir(), 'karpathy-emb-vec-'));
    vecDb = new Database(join(vecDir, 'embeddings.sqlite'));
  });

  afterEach(async () => {
    vecDb.close();
    await rm(vecDir, { recursive: true, force: true });
  });

  it('creates the vec_embeddings virtual table alongside embeddings', () => {
    const vecStore = openEmbeddingStore({ db: vecDb, provider: createDeterministicProvider() });
    const tables = vecDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embeddings'`)
      .all();
    expect(tables).toHaveLength(1);
    vecStore.close();
  });

  it('dual-writes into vec_embeddings on upsert, keyed by the embeddings row rowid', async () => {
    const vecStore = openEmbeddingStore({ db: vecDb, provider: createDeterministicProvider() });
    await vecStore.upsert([{ doc_id: 'a.md', chunk_index: 0, chunk_hash: 'h1', text: 'hello world' }]);
    const embRow = vecDb.prepare(`SELECT rowid FROM embeddings WHERE doc_id = 'a.md'`).get() as {
      rowid: number;
    };
    const vecRow = vecDb.prepare(`SELECT rowid FROM vec_embeddings WHERE rowid = ?`).get(embRow.rowid);
    expect(vecRow).toBeDefined();
    vecStore.close();
  });

  it('removes the matching vec_embeddings row on deleteDoc', async () => {
    const vecStore = openEmbeddingStore({ db: vecDb, provider: createDeterministicProvider() });
    await vecStore.upsert([{ doc_id: 'b.md', chunk_index: 0, chunk_hash: 'h2', text: 'goodbye world' }]);
    const embRow = vecDb.prepare(`SELECT rowid FROM embeddings WHERE doc_id = 'b.md'`).get() as {
      rowid: number;
    };
    vecStore.deleteDoc('b.md');
    const vecRow = vecDb.prepare(`SELECT rowid FROM vec_embeddings WHERE rowid = ?`).get(embRow.rowid);
    expect(vecRow).toBeUndefined();
    vecStore.close();
  });

  it('search() finds the closer of two docs via the vec0 path', async () => {
    const vecStore = openEmbeddingStore({ db: vecDb, provider: createDeterministicProvider() });
    await vecStore.upsert([
      { doc_id: 'close.md', chunk_index: 0, chunk_hash: 'h3', text: 'apple banana cherry' },
      { doc_id: 'far.md', chunk_index: 0, chunk_hash: 'h4', text: 'completely unrelated topic zzz' },
    ]);
    const results = await vecStore.search('apple banana cherry', { topK: 2 });
    expect(results[0].doc_id).toBe('close.md');
    vecStore.close();
  });
});

describe('chunkText', () => {
  it('splits paragraphs into bounded chunks', () => {
    const text = 'para one is short.\n\npara two is also short.\n\n' + 'long '.repeat(400);
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual([...chunks.keys()]);
  });

  it('hashes deterministically', () => {
    expect(hashChunk('hi')).toBe(hashChunk('hi'));
    expect(hashChunk('hi')).not.toBe(hashChunk('bye'));
  });

  it('handles empty input', () => {
    expect(chunkText('')).toEqual([]);
  });
});
