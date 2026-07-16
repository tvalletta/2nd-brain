import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openFTSIndex } from '../../src/search/fts-index.js';
import { rebuildFtsWithStemmer, swapFtsTable } from '../../src/maintenance/rebuild-fts-tokenizer.js';

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
