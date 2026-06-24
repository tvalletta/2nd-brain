// FTS5-backed keyword index over the entire vault.
//
// Lives in the same SQLite database as the embedding store
// (`.karpathy/state/embeddings.sqlite`). Two tables:
//   - `notes_fts`  contentless FTS5 virtual table (no stored body — index only)
//   - `fts_meta`   companion table with file_mtime + indexed_at, used by the
//                  scheduled `sync()` to detect adds/changes/deletes via stat.
//
// Coverage: every markdown file under the configured vault directories,
// regardless of whether the embedding pipeline has touched it. Per the spec,
// FTS5 is cheap (no API calls) so we run it across all 22k+ files; semantic
// embeddings remain ingest-pipeline-only.
//
// `sync(vaultDirs)` is the primary update path. It walks each dir, collects
// `{ path, mtime }`, diffs against `fts_meta`, and incrementally upserts
// changed/new files + deletes vanished ones. Single-file events from the
// chokidar watcher use `upsert` / `delete` directly.

import { stat, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { parseNote } from '../vault/frontmatter.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('fts-index');

export interface FTSHit {
  docId: string;
  /** Raw FTS5 BM25 rank — negative; lower (more negative) = better. */
  bm25Rank: number;
  /** FTS5 snippet() of the match window. */
  snippet: string;
}

export interface SyncStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface FTSIndex {
  /**
   * Upsert a single doc. Updates both `notes_fts` and `fts_meta` so the
   * scheduled sync sees this doc as already-indexed (mtime in the future
   * relative to disk → "unchanged"). `fileMtimeMs` defaults to `Date.now()`
   * which is correct for ingest-pipeline writes.
   */
  upsert(docId: string, title: string, body: string, fileMtimeMs?: number): void;
  delete(docId: string): void;
  query(text: string, limit: number): FTSHit[];
  /** Scan vault dirs and reconcile fts_meta + notes_fts with the filesystem. */
  sync(vaultDirs: string[]): Promise<SyncStats>;
  /** Total docs currently indexed. */
  count(): number;
  /**
   * Return the indexed mtimes for many docIds in a single SQLite roundtrip.
   * Missing rows are absent from the returned map. Used by HybridStore to
   * compute a recency score for keyword-only hits that have no companion
   * embedding row, without an N+1 query per result.
   */
  getMtimesISO(docIds: string[]): Map<string, string>;
  /** Used by tests + maintenance to drop everything. */
  clear(): void;
}

export interface FTSIndexOptions {
  /**
   * Absolute vault root — every doc id stored is relative to this. Both
   * `upsert(docId, ...)` callers AND the `sync()` walker resolve against this.
   */
  vaultRoot: string;
}

/**
 * Open an FTSIndex over an existing SQLite handle. The handle is shared with
 * the EmbeddingStore so both indices stay in one file with one connection.
 */
export function openFTSIndex(db: Database.Database, opts: FTSIndexOptions): FTSIndex {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      doc_id UNINDEXED,
      title,
      body
    );
    CREATE TABLE IF NOT EXISTS fts_meta (
      doc_id      TEXT PRIMARY KEY,
      file_mtime  INTEGER NOT NULL,
      indexed_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fts_meta_doc ON fts_meta(doc_id);
  `);

  // To "update" an FTS5 row we DELETE the existing rowid (if any) and INSERT
  // fresh. doc_id is the stable identity — rowid is internal to FTS5.
  const lookupRowidStmt = db.prepare(
    `SELECT rowid FROM notes_fts WHERE doc_id = ? LIMIT 1`,
  );
  const deleteFtsByRowidStmt = db.prepare(
    `DELETE FROM notes_fts WHERE rowid = ?`,
  );
  const insertFtsStmt = db.prepare(
    `INSERT INTO notes_fts (doc_id, title, body) VALUES (?, ?, ?)`,
  );
  const upsertMetaStmt = db.prepare(
    `INSERT INTO fts_meta (doc_id, file_mtime, indexed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET
       file_mtime = excluded.file_mtime,
       indexed_at = excluded.indexed_at`,
  );
  const deleteMetaStmt = db.prepare(`DELETE FROM fts_meta WHERE doc_id = ?`);
  const selectAllMetaStmt = db.prepare(`SELECT doc_id, file_mtime FROM fts_meta`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM fts_meta`);

  function deleteByDocId(docId: string): void {
    const row = lookupRowidStmt.get(docId) as { rowid: number } | undefined;
    if (!row) return;
    deleteFtsByRowidStmt.run(row.rowid);
  }

  function upsertImpl(
    docId: string,
    title: string,
    body: string,
    fileMtimeMs: number = Date.now(),
  ): void {
    deleteByDocId(docId);
    insertFtsStmt.run(docId, title, body);
    upsertMetaStmt.run(docId, Math.floor(fileMtimeMs), new Date().toISOString());
  }

  function deleteImpl(docId: string): void {
    deleteByDocId(docId);
    deleteMetaStmt.run(docId);
  }

  // ---- Sync walker -------------------------------------------------------

  async function* walkMarkdown(absRoot: string): AsyncGenerator<{ rel: string; mtime: number }> {
    let entries;
    try {
      entries = await readdir(absRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(absRoot, entry.name);
      if (entry.isDirectory()) {
        yield* walkMarkdown(full);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        try {
          const s = await stat(full);
          yield { rel: relative(opts.vaultRoot, full), mtime: Math.floor(s.mtimeMs) };
        } catch {
          /* skip unreadable */
        }
      }
    }
  }

  function querySnippet(text: string, limit: number): FTSHit[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const sanitized = sanitizeFtsQuery(trimmed);
    if (!sanitized) return [];
    try {
      // BM25 column weighting: doc_id (UNINDEXED) ignored, title 3x, body 1x.
      // Without a weight bias, raw term frequency in body trivially outranks
      // a single title hit — which contradicts the documented ranking.
      const rows = db
        .prepare(
          `SELECT doc_id, bm25(notes_fts, 0.0, 3.0, 1.0) AS bm25_rank,
                  snippet(notes_fts, 2, '«', '»', '…', 16) AS snippet
           FROM notes_fts
           WHERE notes_fts MATCH ?
           ORDER BY bm25_rank
           LIMIT ?`,
        )
        .all(sanitized, limit) as Array<{ doc_id: string; bm25_rank: number; snippet: string }>;
      return rows.map((r) => ({ docId: r.doc_id, bm25Rank: r.bm25_rank, snippet: r.snippet ?? '' }));
    } catch (err) {
      log.warn('FTS query failed', { error: (err as Error).message, query: sanitized });
      return [];
    }
  }

  return {
    upsert: upsertImpl,
    delete: deleteImpl,

    query(text: string, limit: number): FTSHit[] {
      return querySnippet(text, limit);
    },

    async sync(vaultDirs: string[]): Promise<SyncStats> {
      const onDisk = new Map<string, number>();
      for (const dir of vaultDirs) {
        const absDir = resolve(opts.vaultRoot, dir);
        for await (const entry of walkMarkdown(absDir)) {
          onDisk.set(entry.rel, entry.mtime);
        }
      }

      const indexed = new Map<string, number>();
      for (const row of selectAllMetaStmt.all() as Array<{ doc_id: string; file_mtime: number }>) {
        indexed.set(row.doc_id, row.file_mtime);
      }

      // Pre-read all changed files outside the txn (better-sqlite3 transactions
      // must run synchronously). We then apply every mutation in one transaction.
      type Upsert = { kind: 'upsert'; rel: string; mtime: number; title: string; body: string };
      type Delete = { kind: 'delete'; rel: string };
      const mutations: Array<Upsert | Delete> = [];
      let unchanged = 0;

      for (const [rel, mtime] of onDisk) {
        const prior = indexed.get(rel);
        if (prior === mtime) {
          unchanged++;
          continue;
        }
        try {
          const raw = await readFile(resolve(opts.vaultRoot, rel), 'utf-8');
          const { data, body } = parseNote(raw);
          const title =
            typeof data.title === 'string' && data.title.length > 0 ? data.title : rel;
          mutations.push({ kind: 'upsert', rel, mtime, title, body });
        } catch {
          /* unreadable file — leave the prior index entry intact */
        }
      }
      for (const docId of indexed.keys()) {
        if (!onDisk.has(docId)) mutations.push({ kind: 'delete', rel: docId });
      }

      let added = 0;
      let updated = 0;
      let removed = 0;

      const writeTx = db.transaction((muts: Array<Upsert | Delete>) => {
        for (const m of muts) {
          if (m.kind === 'delete') {
            deleteImpl(m.rel);
            removed++;
          } else {
            const isNew = !indexed.has(m.rel);
            // Pass the on-disk mtime so the meta stamp matches what the next
            // sync sees on disk — `unchanged` skips kick in immediately on
            // the next run.
            upsertImpl(m.rel, m.title, m.body, m.mtime);
            if (isNew) added++;
            else updated++;
          }
        }
      });
      writeTx(mutations);

      return { added, updated, removed, unchanged };
    },

    count(): number {
      const row = countStmt.get() as { n: number };
      return row.n;
    },

    getMtimesISO(docIds: string[]): Map<string, string> {
      const out = new Map<string, string>();
      if (docIds.length === 0) return out;
      // Build a parameterized IN(...) clause. SQLite caps params per statement
      // at SQLITE_LIMIT_VARIABLE_NUMBER (default 32 766) — far above any topK.
      const placeholders = docIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT doc_id, file_mtime FROM fts_meta WHERE doc_id IN (${placeholders})`,
        )
        .all(...docIds) as Array<{ doc_id: string; file_mtime: number }>;
      for (const r of rows) out.set(r.doc_id, new Date(r.file_mtime).toISOString());
      return out;
    },

    clear(): void {
      db.exec(`DELETE FROM notes_fts; DELETE FROM fts_meta;`);
    },
  };
}

/**
 * Defensive sanitization for free-text user queries before handing them to
 * FTS5. Strips control chars, double quotes, and any non-alphanumeric
 * punctuation that would otherwise be parsed as FTS5 operators (`AND`, `OR`,
 * `NOT`, `NEAR`, `^`, `*`, `:`). Tokens are joined with spaces (implicit AND).
 *
 * If the query has fewer than 1 useful token after sanitization, returns
 * empty string and the caller short-circuits to no results.
 */
export function sanitizeFtsQuery(query: string): string {
  // Split on anything that isn't a Unicode letter/digit/underscore so accented
  // terms, CJK, em-dashes, etc. survive; then quote each token to prevent FTS5
  // operator injection (AND/OR/NOT/NEAR/^/*/:).
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}
