import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { selectBackfillTargets, buildBackfillReport, BACKFILL_PREFIXES } from '../../eval/state/backfill-arm-b.js';

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE fts_meta (doc_id TEXT PRIMARY KEY, file_mtime INTEGER NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE embeddings (
      provider_id TEXT NOT NULL, doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, doc_id, chunk_index)
    );
  `);
  return db;
}

describe('BACKFILL_PREFIXES', () => {
  it('is exactly the 3 confirmed scope prefixes, raw/ excluded', () => {
    expect(BACKFILL_PREFIXES).toEqual(['Plaud/', 'Curated/sources/', 'AI Conversations/']);
  });
});

describe('selectBackfillTargets', () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  it('returns unembedded docs under the 3 scope prefixes only', () => {
    db = makeTestDb();
    const insertMeta = db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)');
    insertMeta.run('Plaud/2026-03/a.md', 'x');
    insertMeta.run('Curated/sources/b.md', 'x');
    insertMeta.run('AI Conversations/_summaries/c.md', 'x');
    insertMeta.run('raw/2026-06-12/d.md', 'x'); // out of scope, must be excluded
    insertMeta.run('Curated/wiki/e.md', 'x'); // out of scope, must be excluded

    const targets = selectBackfillTargets(db);
    expect(targets.sort()).toEqual(['AI Conversations/_summaries/c.md', 'Curated/sources/b.md', 'Plaud/2026-03/a.md']);
  });

  it('excludes docs already embedded under the dominant provider_id', () => {
    db = makeTestDb();
    db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)').run('Plaud/2026-03/a.md', 'x');
    db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)').run('Plaud/2026-03/b.md', 'x');
    const insertEmb = db.prepare(
      "INSERT INTO embeddings VALUES ('ollama-nomic-embed-text-768', ?, 0, 'h', 't', X'00', '{}', 'x')",
    );
    insertEmb.run('Plaud/2026-03/a.md'); // already embedded, should be excluded

    const targets = selectBackfillTargets(db);
    expect(targets).toEqual(['Plaud/2026-03/b.md']);
  });

  it('picks the dominant provider_id when multiple exist (mirrors coverage.ts convention)', () => {
    db = makeTestDb();
    db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)').run('Plaud/a.md', 'x');
    // 2 rows under a minority stale provider, 1 row under the dominant real provider
    db.prepare("INSERT INTO embeddings VALUES ('old-provider', 'Plaud/a.md', 0, 'h1', 't', X'00', '{}', 'x')").run();
    db.prepare("INSERT INTO embeddings VALUES ('old-provider', 'Plaud/other.md', 0, 'h2', 't', X'00', '{}', 'x')").run();
    // dominant provider has no row for Plaud/a.md -> it should still be selected as a target
    db.prepare("INSERT INTO embeddings VALUES ('ollama-nomic-embed-text-768', 'Plaud/z.md', 0, 'h3', 't', X'00', '{}', 'x')").run();
    db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)').run('Plaud/other.md', 'x');
    db.prepare('INSERT INTO fts_meta VALUES (?, 0, ?)').run('Plaud/z.md', 'x');

    const targets = selectBackfillTargets(db);
    // dominant provider is 'old-provider' (2 rows) vs 'ollama-nomic-embed-text-768' (1 row) here,
    // so only docs embedded under 'old-provider' count as done: Plaud/a.md and Plaud/other.md are
    // done, Plaud/z.md (embedded only under the non-dominant provider) is still a target.
    expect(targets.sort()).toEqual(['Plaud/z.md']);
  });

  it('returns an empty array when there are no fts_meta rows', () => {
    db = makeTestDb();
    expect(selectBackfillTargets(db)).toEqual([]);
  });
});

describe('buildBackfillReport', () => {
  it('assembles the report with exact field names matching spec §6.2 backfill_ledger', () => {
    const report = buildBackfillReport({
      notesEmbedded: 12000,
      failedDocIds: ['Plaud/2026-03/broken.md'],
      wallClockMs: 12.4 * 60 * 1000,
      tokenCostEstimate: 8200000,
      dbSizeBeforeBytes: 41_000_000,
      dbSizeAfterBytes: 1_100_000_000,
    });
    expect(report).toEqual({
      notes_embedded: 12000,
      notes_failed: 1,
      wall_clock_min: 12.4,
      token_cost_estimate: 8200000,
      db_size_before_bytes: 41_000_000,
      db_size_after_bytes: 1_100_000_000,
      db_size_delta_gb: +((1_100_000_000 - 41_000_000) / 1_073_741_824).toFixed(2),
      failed_doc_ids: ['Plaud/2026-03/broken.md'],
    });
  });

  it('rounds wall_clock_min and db_size_delta_gb to 2 decimal places', () => {
    const report = buildBackfillReport({
      notesEmbedded: 1,
      failedDocIds: [],
      wallClockMs: 1000, // 1 second = 0.0166... min
      tokenCostEstimate: 1,
      dbSizeBeforeBytes: 0,
      dbSizeAfterBytes: 1_073_741_824, // exactly 1 GiB
    });
    expect(report.wall_clock_min).toBe(0.02);
    expect(report.db_size_delta_gb).toBe(1);
  });
});
