// Build-verify-swap rebuild of the FTS5 index with a Porter-stemmed
// tokenizer. FTS5 tokenizers are fixed at table-creation time and cannot be
// changed via ALTER TABLE, so switching `notes_fts` from the default
// `unicode61` tokenizer to `porter unicode61` requires building an entirely
// new table (`notes_fts_v2`), verifying it looks sane, and only then
// atomically renaming tables into place. The existing live `notes_fts` table
// is never mutated until `swapFtsTable` is explicitly called, and the old
// table is kept around (renamed to `notes_fts_old`) as a rollback path
// rather than dropped immediately.
//
// Lives in the same SQLite database as the embedding store and the live
// `notes_fts` table (`.karpathy/state/embeddings.sqlite`) — this module must
// never touch the `embeddings` table.

import { stat, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { parseNote } from '../vault/frontmatter.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('rebuild-fts-tokenizer');

/** A handful of real eval queries (spec §4.2 "verify... a sample of known-
 * good queries") — kept as plain literals here rather than importing
 * eval/dataset/queries.json, since this is production maintenance code and
 * must not depend on the eval/ directory. Chosen because they're
 * exact-keyword style, so they should return non-empty results against ANY
 * reasonable tokenizer (AND-mode, no stemming needed to match them) —
 * failure here means the rebuild itself is broken, not a stemming nuance. */
const SAMPLE_VERIFICATION_QUERIES = ['meeting', 'decision', 'architecture'];

// Deliberately duplicated from `openFTSIndex`'s private `walkMarkdown`
// closure in fts-index.ts rather than exported/shared — this is a one-time
// migration tool, not a hot path, so keeping the two independent avoids
// coupling the live index's internals to a maintenance script.
async function* walkMarkdown(absRoot: string, vaultRoot: string): AsyncGenerator<{ rel: string }> {
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
      yield* walkMarkdown(full, vaultRoot);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      try {
        await stat(full);
        yield { rel: relative(vaultRoot, full) };
      } catch {
        /* skip unreadable */
      }
    }
  }
}

export interface RebuildResult {
  oldCount: number;
  newCount: number;
  sampleQueriesOk: boolean;
}

/** Builds a NEW `notes_fts_v2` table (Porter-stemmed tokenizer) and
 * populates it from the vault, WITHOUT touching the existing live
 * `notes_fts` table at all. Call `swapFtsTable` separately, only after
 * confirming this result looks sane. */
export async function rebuildFtsWithStemmer(
  db: Database.Database,
  vaultRoot: string,
  vaultDirs: string[],
): Promise<RebuildResult> {
  db.exec(`DROP TABLE IF EXISTS notes_fts_v2;`);
  db.exec(`
    CREATE VIRTUAL TABLE notes_fts_v2 USING fts5(
      doc_id UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61'
    );
  `);

  const insertStmt = db.prepare(`INSERT INTO notes_fts_v2 (doc_id, title, body) VALUES (?, ?, ?)`);
  const insertMany = db.transaction((rows: Array<{ rel: string; title: string; body: string }>) => {
    for (const row of rows) insertStmt.run(row.rel, row.title, row.body);
  });

  const rows: Array<{ rel: string; title: string; body: string }> = [];
  for (const dir of vaultDirs) {
    const absDir = resolve(vaultRoot, dir);
    for await (const entry of walkMarkdown(absDir, vaultRoot)) {
      try {
        const raw = await readFile(resolve(vaultRoot, entry.rel), 'utf-8');
        const { data, body } = parseNote(raw);
        const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : entry.rel;
        rows.push({ rel: entry.rel, title, body });
      } catch {
        /* unreadable file — skip, matches fts-index.ts's existing sync() behavior */
      }
    }
  }
  insertMany(rows);

  const oldCountRow = db.prepare(`SELECT COUNT(*) AS n FROM notes_fts`).get() as { n: number };
  const newCountRow = db.prepare(`SELECT COUNT(*) AS n FROM notes_fts_v2`).get() as { n: number };

  let sampleQueriesOk = true;
  for (const q of SAMPLE_VERIFICATION_QUERIES) {
    const hitRows = db.prepare(`SELECT doc_id FROM notes_fts_v2 WHERE notes_fts_v2 MATCH ?`).all(`"${q}"`) as unknown[];
    if (hitRows.length === 0) {
      log.warn('Sample verification query returned zero results against new table', { query: q });
      sampleQueriesOk = false;
    }
  }

  log.info('FTS rebuild (build phase) complete', {
    oldCount: oldCountRow.n,
    newCount: newCountRow.n,
    sampleQueriesOk,
  });

  return { oldCount: oldCountRow.n, newCount: newCountRow.n, sampleQueriesOk };
}

/** Atomically swaps the freshly-built `notes_fts_v2` into the live
 * `notes_fts` slot, keeping the old table as `notes_fts_old` (a rollback
 * path) rather than dropping it immediately — matches spec §4.2 step 5.
 * Also rebuilds `fts_meta` from scratch against the new table's rows,
 * since fts_meta's mtimes are keyed to the old table's sync history, not
 * meaningfully portable to the new one. */
export function swapFtsTable(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS notes_fts_old;`);
    db.exec(`ALTER TABLE notes_fts RENAME TO notes_fts_old;`);
    db.exec(`ALTER TABLE notes_fts_v2 RENAME TO notes_fts;`);
    db.exec(`DELETE FROM fts_meta;`);
  });
  tx();
  log.info('FTS table swap complete — old table preserved as notes_fts_old; fts_meta cleared for full re-sync');
}
