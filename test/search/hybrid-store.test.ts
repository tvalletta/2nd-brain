import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openFTSIndex } from '../../src/search/fts-index.js';
import { createHybridStore, type HybridStore } from '../../src/search/hybrid-store.js';
import { openEmbeddingStore, createDeterministicProvider } from '../../src/embeddings/index.js';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';

describe('hybrid store', () => {
  let dir: string;
  let db: Database.Database;
  let store: HybridStore;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-hybrid-'));
    config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      embeddings: { provider: 'deterministic' },
    });
    db = new Database(join(dir, 'hybrid.sqlite'));
    db.pragma('journal_mode = WAL');
    const fts = openFTSIndex(db, { vaultRoot: dir });
    const embeddings = openEmbeddingStore({ db, provider: createDeterministicProvider() });
    store = createHybridStore({ config, db, fts, embeddings });
  });

  afterEach(async () => {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('combines keyword and semantic pools when both indices have matches', async () => {
    await store.upsertDoc('keyword-only.md', 'Keyword Only Title', 'banana harness reproducer', [
      // No embeddings — so this doc matches FTS but NOT semantic
    ]);
    await store.upsertDoc(
      'both.md',
      'Banana Harness',
      'banana harness reproducer with extra context',
      [
        {
          doc_id: 'both.md',
          chunk_index: 0,
          chunk_hash: 'h1',
          text: 'banana harness reproducer with extra context',
          metadata: { type: 'concept', title: 'Banana Harness' },
        },
      ],
    );

    const result = await store.search('banana harness');
    expect(result.searchMode).toBe('hybrid');
    const ids = result.hits.map((h) => h.docId);
    expect(ids).toContain('both.md');
    expect(ids).toContain('keyword-only.md');
  });

  it('returns keyword-only mode when isProviderAvailable returns false', async () => {
    // Stub the provider probe via a test-only build of HybridStore.
    db.close();
    db = new Database(join(dir, 'hybrid2.sqlite'));
    db.pragma('journal_mode = WAL');
    const fts = openFTSIndex(db, { vaultRoot: dir });
    const embeddings = openEmbeddingStore({ db, provider: createDeterministicProvider() });
    const downConfig = KarpathyConfigSchema.parse({
      vaultPath: dir,
      embeddings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1' },
    });
    const downStore = createHybridStore({
      config: downConfig,
      db,
      fts,
      embeddings,
      isProviderAvailable: async () => false,
    });
    try {
      await downStore.upsertDoc('a.md', 'Banana Title', 'banana harness body', []);
      const result = await downStore.search('banana harness');
      expect(result.searchMode).toBe('keyword-only');
      expect(result.degradationNote).toMatch(/Ollama/i);
      expect(result.hits.map((h) => h.docId)).toContain('a.md');
    } finally {
      downStore.close();
    }
  });

  it('zero results returns empty hits without throwing', async () => {
    const result = await store.search('totally-unrelated-zzzz');
    expect(result.hits).toEqual([]);
    expect(result.searchMode).toBe('hybrid');
  });

  it('this-week scope filters out stale matches', async () => {
    const oldIso = new Date(Date.now() - 30 * 86400_000).toISOString();
    await store.upsertDoc('old.md', 'Banana', 'banana stale', [
      {
        doc_id: 'old.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana stale',
        metadata: { type: 'concept', updated_at: oldIso },
      },
    ]);
    // Direct DB poke to backdate updated_at on the embedding row, since our
    // store stamps it with `now` on upsert.
    db.prepare(`UPDATE embeddings SET updated_at = ? WHERE doc_id = ?`).run(oldIso, 'old.md');

    const recentIso = new Date().toISOString();
    await store.upsertDoc('fresh.md', 'Banana', 'banana fresh', [
      {
        doc_id: 'fresh.md',
        chunk_index: 0,
        chunk_hash: 'h2',
        text: 'banana fresh',
        metadata: { type: 'concept', updated_at: recentIso },
      },
    ]);

    const result = await store.search('banana', { scope: 'this-week' });
    const ids = result.hits.map((h) => h.docId);
    expect(ids).toContain('fresh.md');
    expect(ids).not.toContain('old.md');
  });

  it('project scope filters by metadata.project_slug', async () => {
    await store.upsertDoc('p1.md', 'Banana', 'banana p1', [
      {
        doc_id: 'p1.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana p1',
        metadata: { type: 'project', project_slug: 'alpha' },
      },
    ]);
    await store.upsertDoc('p2.md', 'Banana', 'banana p2', [
      {
        doc_id: 'p2.md',
        chunk_index: 0,
        chunk_hash: 'h2',
        text: 'banana p2',
        metadata: { type: 'project', project_slug: 'beta' },
      },
    ]);
    const result = await store.search('banana', {
      scope: 'project',
      projectSlug: 'alpha',
    });
    expect(result.hits.map((h) => h.docId)).toEqual(['p1.md']);
  });

  it('note_type filter narrows the result set', async () => {
    await store.upsertDoc('c.md', 'Banana', 'banana c', [
      {
        doc_id: 'c.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana c',
        metadata: { type: 'concept' },
      },
    ]);
    await store.upsertDoc('s.md', 'Banana', 'banana s', [
      {
        doc_id: 's.md',
        chunk_index: 0,
        chunk_hash: 'h2',
        text: 'banana s',
        metadata: { type: 'session_summary' },
      },
    ]);
    const result = await store.search('banana', { noteType: 'concept' });
    expect(result.hits.map((h) => h.docId)).toEqual(['c.md']);
  });

  it('deduplicates multiple chunks from one doc into a single hit', async () => {
    await store.upsertDoc('multi.md', 'Banana', 'banana harness body content', [
      {
        doc_id: 'multi.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana harness chunk one',
        metadata: { type: 'concept' },
      },
      {
        doc_id: 'multi.md',
        chunk_index: 1,
        chunk_hash: 'h2',
        text: 'banana harness chunk two',
        metadata: { type: 'concept' },
      },
    ]);
    const result = await store.search('banana harness');
    const matches = result.hits.filter((h) => h.docId === 'multi.md');
    expect(matches).toHaveLength(1);
  });

  it('upsertDoc with no chunks deletes embeddings while keeping FTS', async () => {
    await store.upsertDoc('a.md', 'Title', 'banana body', [
      {
        doc_id: 'a.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana body',
        metadata: { type: 'concept' },
      },
    ]);
    let result = await store.search('banana');
    expect(result.hits[0].scores.semanticSim).toBeDefined();

    await store.upsertDoc('a.md', 'Title', 'banana body', []);
    result = await store.search('banana');
    expect(result.hits.map((h) => h.docId)).toContain('a.md');
    expect(result.hits[0].scores.semanticSim).toBeUndefined();
  });

  it('keyword-only hits get a non-zero recency from fts_meta.file_mtime', async () => {
    // No embedding row → the only path to a recency score is fts_meta.
    await store.upsertDoc('kw.md', 'Banana', 'banana keyword-only body', []);
    const result = await store.search('banana keyword-only');
    const hit = result.hits.find((h) => h.docId === 'kw.md');
    expect(hit).toBeDefined();
    // file_mtime stamped during upsertDoc → ISO string set → recency > 0.
    expect(hit!.scores.recency).toBeGreaterThan(0);
    expect(hit!.updated_at).not.toBe('');
    // Sanity: scores.semanticSim is undefined because there's no embedding row.
    expect(hit!.scores.semanticSim).toBeUndefined();
  });

  it('deleteDoc drops the doc from both indexes', async () => {
    await store.upsertDoc('x.md', 'Banana', 'banana x', [
      {
        doc_id: 'x.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'banana x',
        metadata: { type: 'concept' },
      },
    ]);
    await store.deleteDoc('x.md');
    const result = await store.search('banana x');
    expect(result.hits.map((h) => h.docId)).not.toContain('x.md');
  });
});
