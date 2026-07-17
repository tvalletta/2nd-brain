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
  query(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' };
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

  function runFtsQuery(sanitized: string, limit: number): FTSHit[] {
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

  function querySnippet(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' } {
    const trimmed = text.trim();
    if (!trimmed) return { hits: [], matchMode: 'and' };
    // Stopword-filtered AND (not the raw sanitizeFtsQuery) — see
    // sanitizeFtsQueryAnd's doc comment for why: ANDing in near-universal
    // English words alongside real content terms costs enormously more
    // without changing which docs match.
    const andQuery = sanitizeFtsQueryAnd(trimmed);
    if (!andQuery) return { hits: [], matchMode: 'and' };

    const andHits = runFtsQuery(andQuery, limit);
    if (andHits.length > 0) return { hits: andHits, matchMode: 'and' };

    // AND found nothing — retry with OR so partial term overlap still
    // surfaces candidates, letting BM25 ranking order them by quality
    // rather than requiring every term to match (spec: grep-recall-
    // improvements-design.md §3).
    const orQuery = sanitizeFtsQueryOr(trimmed);
    if (!orQuery) return { hits: [], matchMode: 'and' };
    const orHits = runFtsQuery(orQuery, limit);
    if (orHits.length > 0) return { hits: orHits, matchMode: 'or' };
    return { hits: [], matchMode: 'and' };
  }

  return {
    upsert: upsertImpl,
    delete: deleteImpl,

    query(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' } {
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

// Split on anything that isn't a Unicode letter/digit/underscore so accented
// terms, CJK, em-dashes, etc. survive; then strip stray double quotes (which
// would otherwise let a token break out of FTS5's quoted-phrase syntax).
function tokenizeFtsQuery(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);
}

/**
 * Defensive sanitization for free-text user queries before handing them to
 * FTS5. Strips control chars, double quotes, and any non-alphanumeric
 * punctuation that would otherwise be parsed as FTS5 operators (`AND`, `OR`,
 * `NOT`, `NEAR`, `^`, `*`, `:`). Tokens are joined with spaces (implicit AND).
 *
 * If the query has fewer than 1 useful token after sanitization, returns
 * empty string and the caller short-circuits to no results.
 *
 * This does NOT filter stopwords — see `sanitizeFtsQueryAnd` for the
 * stopword-filtered variant used internally by `querySnippet`'s AND-first
 * path. This function is kept as-is (exact tokenize+quote, no filtering)
 * because it's part of the public `search` API surface and other callers
 * may rely on its literal, unfiltered behavior.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = tokenizeFtsQuery(query);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

// A short, standard English stopword list. Filtering these out of both the
// AND-first and OR-fallback query paths avoids enormous FTS5 posting-list
// costs for common words on long natural-language queries.
//
// Originally added only to the OR-fallback path (sanitizeFtsQueryOr) to fix
// fuzzy-003 (a 34-word query that fell through to OR and unioned every
// token's posting list, ~58-61s -> ~226-437ms). Real re-verification against
// the live vault found two more pathological queries, fuzzy-001 (~14-15s)
// and fuzzy-002 (~24s), UNCHANGED by that fix — because both AND-first
// queries actually succeed (return nonzero hits) and never reach the OR
// path at all. The cost lived in `sanitizeFtsQuery`'s *unfiltered* AND
// query: ANDing in 5-8 near-universal English words (e.g. "that", "we",
// "how", "of", "up") alongside the real content terms. Measured directly
// against the live index (23,731 docs):
//   fuzzy-001 AND, unfiltered: ~10.5-13.9s, 47 rows
//   fuzzy-001 AND, stopwords filtered:  ~186ms, 47 rows (byte-identical doc set)
//   fuzzy-002 AND, unfiltered: ~8.7-24.2s, 17 rows
//   fuzzy-002 AND, stopwords filtered:  ~163ms, 17 rows (byte-identical doc set)
// i.e. filtering stopwords out of the AND query changes nothing about which
// docs match (they're near-universal, so they add zero selectivity) but
// removes most of FTS5's merge cost. This ruled out a vault-specific
// high-frequency term (e.g. "AI", present in 73% of docs here) as the
// driver of the AND-path cost — a vault-specific corpus-frequency
// mechanism was considered but isn't justified by the data: this same
// generic stopword list, applied consistently to both paths, fully
// resolves the measured regression.
const FTS_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or',
  'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

// If filtering stopwords would leave nothing (e.g. a query that happens to
// be entirely stopwords), fall back to the unfiltered list rather than
// returning an empty query — that would incorrectly trigger querySnippet's
// "no query" short-circuit for a query that does have real (if all-common)
// words.
function filterFtsStopwords(tokens: string[]): string[] {
  const filtered = tokens.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase()));
  return filtered.length > 0 ? filtered : tokens;
}

/**
 * Same tokenization/sanitization as `sanitizeFtsQuery`, but joins tokens
 * with `OR` instead of implicit AND — used as a recall fallback when the
 * AND query finds nothing (spec: grep-recall-improvements-design.md §3).
 *
 * Filters out common English stopwords to avoid unioning pathologically-large
 * FTS5 posting lists for long natural-language queries.
 */
export function sanitizeFtsQueryOr(query: string): string {
  const tokens = tokenizeFtsQuery(query);
  if (tokens.length === 0) return '';
  return filterFtsStopwords(tokens)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

/**
 * Same tokenization/sanitization as `sanitizeFtsQuery`, but filters out
 * common English stopwords before joining with implicit AND (space) — used
 * by `querySnippet`'s AND-first path instead of `sanitizeFtsQuery`.
 *
 * Without this, ANDing in near-universal words (e.g. "that", "we", "of")
 * alongside real content terms adds no selectivity (see `FTS_STOPWORDS`
 * comment above for measured before/after) but makes FTS5's AND merge
 * pathologically expensive on long natural-language queries — even when
 * the AND query still succeeds and never reaches the OR fallback.
 */
export function sanitizeFtsQueryAnd(query: string): string {
  const tokens = tokenizeFtsQuery(query);
  if (tokens.length === 0) return '';
  return filterFtsStopwords(tokens)
    .map((t) => `"${t}"`)
    .join(' ');
}
