import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openFTSIndex } from '../../src/search/fts-index.js';
import { rebuildFtsWithStemmer, swapFtsTable } from '../../src/maintenance/rebuild-fts-tokenizer.js';
import { openEmbeddingStore } from '../../src/embeddings/store.js';
import { createDeterministicProvider } from '../../src/embeddings/provider.js';

describe('rebuildFtsWithStemmer', () => {
  let vaultDir: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'fts-rebuild-vault-'));
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    writeFileSync(join(vaultDir, 'wiki', 'a.md'), '---\ntitle: A\n---\nWe made several decisions this week about meeting cadence.');
    writeFileSync(join(vaultDir, 'wiki', 'b.md'), '---\ntitle: B\n---\nThe team is meeting again to discuss the decision on the system architecture.');
    db = new Database(':memory:');
    // Populate the LIVE notes_fts table (old tokenizer) via the real index, matching production shape.
    const index = openFTSIndex(db, { vaultRoot: vaultDir });
    void index; // ensures notes_fts/fts_meta tables exist; sync happens via rebuildFtsWithStemmer's own walk, not this index's sync.
  });

  afterEach(() => {
    db.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('builds a new stemmed table, reports matching counts, and verifies sample queries before any swap', async () => {
    const result = await rebuildFtsWithStemmer(db, vaultDir, ['wiki']);
    expect(result.oldCount).toBe(0); // old notes_fts was never populated in this test setup
    expect(result.newCount).toBe(2); // both files indexed into the new table
    expect(result.sampleQueriesOk).toBe(true);

    // The old notes_fts table must be untouched — still exists, unrenamed.
    // FTS5 virtual tables register shadow tables (name_data, name_idx, etc.)
    // in sqlite_master alongside the logical table, all matching
    // `notes_fts%` — filter to just the virtual-table declarations
    // themselves (sql column starts with "CREATE VIRTUAL TABLE") so this
    // only counts the two logical FTS5 tables.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notes_fts%' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['notes_fts', 'notes_fts_v2']);
  });

  it('the new table actually stems — "meeting" query matches a doc containing only "meetings"', async () => {
    writeFileSync(join(vaultDir, 'wiki', 'c.md'), '---\ntitle: C\n---\nWe held several meetings last quarter.');
    await rebuildFtsWithStemmer(db, vaultDir, ['wiki']);
    const rows = db.prepare(`SELECT doc_id FROM notes_fts_v2 WHERE notes_fts_v2 MATCH 'meeting'`).all() as { doc_id: string }[];
    // Porter-stemmed: "meeting" and "meetings" collapse to the same stem, so
    // this must match c.md (which only contains "meetings", plural) too.
    expect(rows.some((r) => r.doc_id.endsWith('c.md'))).toBe(true);
  });

  it('leaves the embeddings table (sharing this same database file) byte-for-byte untouched across build + swap', async () => {
    interface RawEmbeddingRow {
      provider_id: string;
      doc_id: string;
      chunk_index: number;
      chunk_hash: string;
      text: string;
      vector: Buffer;
      metadata: string;
      updated_at: string;
    }

    // Real schema, real store, real provider — createDeterministicProvider()
    // is the hash-based fallback used by tests, requiring no network/model
    // dependency. Sharing `db` mirrors production, where notes_fts and
    // embeddings live in the same .karpathy/state/embeddings.sqlite file.
    const provider = createDeterministicProvider();
    const store = openEmbeddingStore({ db, provider });
    await store.upsert([
      {
        doc_id: 'wiki/a.md',
        chunk_index: 0,
        chunk_hash: 'hash-abc123',
        text: 'We made several decisions this week about meeting cadence.',
        metadata: { source: 'wiki/a.md' },
      },
    ]);

    const before = db.prepare(`SELECT * FROM embeddings ORDER BY doc_id, chunk_index`).all() as RawEmbeddingRow[];
    expect(before).toHaveLength(1);

    await rebuildFtsWithStemmer(db, vaultDir, ['wiki']);
    swapFtsTable(db);

    const after = db.prepare(`SELECT * FROM embeddings ORDER BY doc_id, chunk_index`).all() as RawEmbeddingRow[];
    expect(after).toHaveLength(1);
    expect(after[0].provider_id).toBe(before[0].provider_id);
    expect(after[0].doc_id).toBe(before[0].doc_id);
    expect(after[0].chunk_index).toBe(before[0].chunk_index);
    expect(after[0].chunk_hash).toBe(before[0].chunk_hash);
    expect(after[0].text).toBe(before[0].text);
    expect(after[0].metadata).toBe(before[0].metadata);
    expect(after[0].updated_at).toBe(before[0].updated_at);
    expect(Buffer.compare(after[0].vector, before[0].vector)).toBe(0);

    store.close();
  });
});

describe('swapFtsTable', () => {
  it('atomically renames notes_fts_v2 to notes_fts and the old one to notes_fts_old', async () => {
    const vaultDir2 = mkdtempSync(join(tmpdir(), 'fts-swap-vault-'));
    mkdirSync(join(vaultDir2, 'wiki'), { recursive: true });
    writeFileSync(join(vaultDir2, 'wiki', 'a.md'), '---\ntitle: A\n---\nHello world.');
    const db2 = new Database(':memory:');
    openFTSIndex(db2, { vaultRoot: vaultDir2 });
    await rebuildFtsWithStemmer(db2, vaultDir2, ['wiki']);

    swapFtsTable(db2);

    const tables = db2
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notes_fts%' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['notes_fts', 'notes_fts_old']);
    // The live notes_fts (now the renamed v2) must be queryable and stemmed-tokenized.
    const rows = db2.prepare(`SELECT doc_id FROM notes_fts WHERE notes_fts MATCH 'hello'`).all() as { doc_id: string }[];
    expect(rows).toHaveLength(1);

    db2.close();
    rmSync(vaultDir2, { recursive: true, force: true });
  });
});
