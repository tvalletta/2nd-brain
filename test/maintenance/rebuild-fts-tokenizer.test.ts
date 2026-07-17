import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { mkdir, writeFile, rm } from 'node:fs/promises';
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

// Finding 2 (whole-branch cross-plan review): the FTS-rebuild CLI
// (`src/bin/karpathy.ts`'s `--rebuild-fts-tokenizer` handler) opens the
// shared `.karpathy/state/embeddings.sqlite` file with a plain
// `new Database(dbPath)`. That file now also holds a real `vec_embeddings`
// vec0 virtual table (semantic-latency-fallback's `src/embeddings/store.ts`
// dual-writes into it) — a plan that landed AFTER grep-recall-improvements
// built this rebuild mechanism against a database shape that, at the time,
// had no vec0 table at all. The sqlite-vec module is registered
// per-connection (`sqliteVec.load(db)`, see store.ts), not per-file, so any
// fresh connection to this file that ends up touching `vec_embeddings`
// without having loaded the extension first throws "no such module: vec0".
// These tests use file-backed databases and separate `Database` connections
// (rather than sharing one in-memory handle across the whole test, as the
// rest of this file does) specifically to reproduce the real CLI's
// connection lifecycle: one process/connection creates the vec0 table
// (mirroring the embedding store's ingest path), a DIFFERENT connection
// later opens that same file to run the rebuild (mirroring the CLI).
describe('rebuild-fts-tokenizer + shared vec0 table (issue: "no such module: vec0")', () => {
  let dir: string;
  let dbPath: string;
  let vaultDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fts-rebuild-vec0-'));
    dbPath = join(dir, 'embeddings.sqlite');
    vaultDir = mkdtempSync(join(tmpdir(), 'fts-rebuild-vec0-vault-'));
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    writeFileSync(join(vaultDir, 'wiki', 'a.md'), '---\ntitle: A\n---\nWe made several decisions this week about meeting cadence.');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  /** Seeds `dbPath` with the real production shape: notes_fts (via
   * openFTSIndex) plus a real vec_embeddings vec0 table with one row (via
   * the real embedding store, not a hand-rolled CREATE VIRTUAL TABLE), then
   * closes the connection so a later connection can reopen the same file
   * fresh. */
  async function seedProductionShapeDb(): Promise<void> {
    const db = new Database(dbPath);
    openFTSIndex(db, { vaultRoot: vaultDir });
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
    db.close();
  }

  it('grounds the diagnosis: a fresh connection that never loads sqlite-vec throws "no such module: vec0" the moment vec_embeddings is referenced', async () => {
    await seedProductionShapeDb();
    const freshDb = new Database(dbPath); // no sqliteVec.load(freshDb) — the pre-fix CLI behavior
    expect(() => freshDb.prepare(`SELECT COUNT(*) AS n FROM vec_embeddings`).get()).toThrow(/no such module: vec0/);
    freshDb.close();
  });

  it('rebuild+swap does not throw and the vec0 table survives untouched, once the connection loads sqlite-vec before running (the fix)', async () => {
    await seedProductionShapeDb();

    // Mirrors the fixed CLI handler: a fresh connection to the shared file,
    // sqlite-vec loaded immediately after opening, before any DDL runs.
    const db = new Database(dbPath);
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);

    const before = db.prepare(`SELECT rowid FROM vec_embeddings ORDER BY rowid`).all() as { rowid: number }[];
    expect(before).toHaveLength(1);

    await expect(
      (async () => {
        const result = await rebuildFtsWithStemmer(db, vaultDir, ['wiki']);
        swapFtsTable(db);
        return result;
      })(),
    ).resolves.not.toThrow();

    const after = db.prepare(`SELECT rowid FROM vec_embeddings ORDER BY rowid`).all() as { rowid: number }[];
    expect(after).toEqual(before);

    // The rebuild+swap itself must still have happened correctly.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notes_fts%' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['notes_fts', 'notes_fts_old']);

    db.close();
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

describe('CLI scope bug: vaultDirs=["."] (the fix) vs the 4-folder set (the bug)', () => {
  it('scanning vaultDirs=["."] covers files outside the 4-folder set that vaultDirs=[wiki,aiSummaries,sources,review] misses', async () => {
    // Build a fixture vault with a markdown file under a folder NOT in
    // [wiki, outputs/session-summaries, outputs/source-summaries, review] —
    // e.g. raw/ai-conversations/claude/ (matching real bug report).
    const dir = await mkdtemp(join(tmpdir(), 'karpathy-rebuild-scope-'));
    await mkdir(join(dir, 'raw', 'ai-conversations', 'claude'), { recursive: true });
    await writeFile(
      join(dir, 'raw', 'ai-conversations', 'claude', 'session.md'),
      '---\ntitle: Session\n---\nClaude session content here.',
    );
    const db = new Database(join(dir, 'test.sqlite'));
    db.pragma('journal_mode = WAL');

    // Initialize the FTS table (normally done by openFTSIndex in production)
    openFTSIndex(db, { vaultRoot: dir });

    // Test the buggy scope: [wiki, outputs/session-summaries, outputs/source-summaries, review]
    // This should miss the file in raw/ai-conversations/claude/
    const buggyScopeResult = await rebuildFtsWithStemmer(db, dir, [
      'wiki',
      'outputs/session-summaries',
      'outputs/source-summaries',
      'review',
    ]);
    expect(buggyScopeResult.newCount).toBe(0);

    // Test the fixed scope: ['.'] (entire vault)
    // This should catch the file in raw/ai-conversations/claude/
    const fixedScopeResult = await rebuildFtsWithStemmer(db, dir, ['.']);
    expect(fixedScopeResult.newCount).toBe(1);

    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
