# Grep-First Recall Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise grep-first's recall (currently 0.212 pooled, 0.09 on `entities`) via three independent, keyword-first levers: AND-first/OR-fallback query relaxation, a Porter stemmer (requiring a new, safe FTS5 rebuild mechanism), and entity alias population (a real, confirmed duplicate merge plus a new low-friction alias-authoring tool).

**Architecture:** Task 1 changes `FTSIndex.query()`'s return shape to surface which match mode fired, threaded into `HybridSearchResult` the same way `degradationNote` already is. Task 2 builds a new, from-scratch rebuild mechanism (none exists today) using a build-verify-swap pattern so the live 23,600+-note index is never mutated in place. Task 3 has two independent parts: reusing already-built entity-reconciliation tooling for a real known duplicate, and a new small CLI script for alias authoring.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, better-sqlite3, no new dependencies.

## Global Constraints

- `FTSIndex.query()`'s only production caller is `src/search/hybrid-store.ts:107` — confirmed via repo-wide grep, so its return-type change in Task 1 has exactly one call site to update outside tests.
- The live FTS index lives in `.karpathy/state/embeddings.sqlite`, shared with the embedding store — any rebuild must not touch the `embeddings` table.
- `notes_fts` has no `tokenize=` clause today (default `unicode61`); FTS5 tokenizers are fixed at table-creation time and cannot be changed via `ALTER TABLE` — a tokenizer change requires dropping and recreating the table.
- Entity notes live under `Curated/wiki/entities/` in the vault (23 real files today, confirmed by direct count) — every one has `aliases: []` in frontmatter (from `BaseFrontmatterSchema`, `src/vault/frontmatter.ts:59-103`), all empty.
- Frontmatter round-tripping must go through `parseNote(content): { data, body }` and `serializeNote(data, body): string` (`src/vault/frontmatter.ts:222,227`) — never hand-edit YAML text directly, to avoid corrupting fields this plan doesn't touch.
- All new/modified files use `.js` extensions on relative imports.

---

### Task 1: AND-first, OR-fallback query relaxation

**Files:**
- Modify: `src/search/fts-index.ts`
- Modify: `src/search/hybrid-store.ts`
- Test: `test/search/fts-index.test.ts`
- Test: `test/search/hybrid-store.test.ts`

**Interfaces:**
- Produces (used by Task 3's testing, and by any future caller): `FTSIndex.query(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' }` (changed from the current `FTSHit[]`).
- Consumed by: `HybridSearchResult` gains a new optional field `ftsMatchMode?: 'and' | 'or'`.

- [ ] **Step 1: Write the failing tests for the new query behavior**

In `test/search/fts-index.test.ts`, every existing call site of `index.query(...)` currently expects a bare array (e.g. `expect(index.query('FSRS', 5)).toHaveLength(1)`). Update **all** of them to unwrap `.hits` — read the file first to find every call site (9 confirmed via grep: lines 28, 36, 43, 49, 51, 56, 92, 93, 102), and change each `index.query(X, Y)` to `index.query(X, Y).hits` everywhere it's used as an array (e.g. `.toHaveLength(...)`, indexing `[0]`), and where it's captured in a variable (e.g. `const hits = index.query('FSRS', 5);`), change to `const { hits } = index.query('FSRS', 5);`.

Then add these new tests to the same file (appended at the end, inside the existing top-level `describe` block — read the file to match its exact existing structure/imports first):

```ts
describe('AND-first, OR-fallback query relaxation', () => {
  it('reports matchMode "and" when the exact AND query finds results', () => {
    index.upsert('doc1.md', 'Doc One', 'apple banana cherry');
    const result = index.query('apple banana', 5);
    expect(result.matchMode).toBe('and');
    expect(result.hits).toHaveLength(1);
  });

  it('falls back to OR and reports matchMode "or" when AND finds zero results', () => {
    index.upsert('doc2.md', 'Doc Two', 'apple only, no other fruit here');
    index.upsert('doc3.md', 'Doc Three', 'banana only, no other fruit here');
    // "apple banana" as AND matches neither doc2 nor doc3 (each has only one term).
    const result = index.query('apple banana', 5);
    expect(result.matchMode).toBe('or');
    expect(result.hits.map((h) => h.docId).sort()).toEqual(['doc2.md', 'doc3.md']);
  });

  it('does not fall back to OR when AND already found at least one result', () => {
    index.upsert('doc4.md', 'Doc Four', 'apple banana together');
    index.upsert('doc5.md', 'Doc Five', 'apple only');
    const result = index.query('apple banana', 5);
    expect(result.matchMode).toBe('and');
    // Only doc4 matches AND; doc5 (apple-only) must NOT appear even though
    // it would match under OR — proves the fallback didn't fire.
    expect(result.hits.map((h) => h.docId)).toEqual(['doc4.md']);
  });

  it('single-term queries are unaffected by AND/OR distinction', () => {
    index.upsert('doc6.md', 'Doc Six', 'unique-single-term-zzz');
    const result = index.query('unique-single-term-zzz', 5);
    expect(result.matchMode).toBe('and');
    expect(result.hits).toHaveLength(1);
  });

  it('returns matchMode "and" with empty hits when even OR finds nothing', () => {
    const result = index.query('completely-absent-term-xyz', 5);
    expect(result.matchMode).toBe('and');
    expect(result.hits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/search/fts-index.test.ts`
Expected: FAIL — `query()` still returns a bare array, `.matchMode`/`.hits` don't exist on it; the updated existing tests fail with a type/shape mismatch.

- [ ] **Step 3: Implement AND-first/OR-fallback in `fts-index.ts`**

In `src/search/fts-index.ts`, change the `FTSIndex` interface's `query` method signature (currently `query(text: string, limit: number): FTSHit[];` at line 51) to:

```ts
  query(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' };
```

Replace the `querySnippet` function (lines 163-187) with:

```ts
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
    const andQuery = sanitizeFtsQuery(trimmed);
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
```

Then update the returned object's `query` method (currently lines 193-195):

```ts
    query(text: string, limit: number): { hits: FTSHit[]; matchMode: 'and' | 'or' } {
      return querySnippet(text, limit);
    },
```

Finally, add a new exported function right after the existing `sanitizeFtsQuery` (after line 308, at the end of the file):

```ts
/**
 * Same tokenization/sanitization as `sanitizeFtsQuery`, but joins tokens
 * with `OR` instead of implicit AND — used as a recall fallback when the
 * AND query finds nothing (spec: grep-recall-improvements-design.md §3).
 */
export function sanitizeFtsQueryOr(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/search/fts-index.test.ts`
Expected: PASS (all existing tests + 5 new ones)

- [ ] **Step 5: Update the one production call site in `hybrid-store.ts`**

Read `src/search/hybrid-store.ts` around line 107 and the `HybridSearchResult` interface (line 60) first to see the exact current surrounding code. Change:

```ts
export interface HybridSearchResult {
  hits: HybridHit[];
  searchMode: 'hybrid' | 'keyword-only';
  degradationNote?: string;
}
```

to:

```ts
export interface HybridSearchResult {
  hits: HybridHit[];
  searchMode: 'hybrid' | 'keyword-only';
  degradationNote?: string;
  ftsMatchMode?: 'and' | 'or';
}
```

Change the call site:

```ts
      const ftsHits = fts.query(query, poolK);
```

to:

```ts
      const { hits: ftsHits, matchMode: ftsMatchMode } = fts.query(query, poolK);
```

Then find where the final `HybridSearchResult` object is constructed (near the existing `if (degradationNote) result.degradationNote = degradationNote;` line) and add:

```ts
      if (ftsMatchMode === 'or') result.ftsMatchMode = ftsMatchMode;
```

(Only set it when `'or'` — matching the existing convention of only setting `degradationNote` when there's something notable to report, keeping the common case's output uncluttered.)

- [ ] **Step 6: Update `test/search/hybrid-store.test.ts` for the new destructuring**

Read the file first — any test that mocks/stubs `FTSIndex.query` (search for `query:` in a fake/mock FTSIndex object) needs its mock updated to return `{ hits: [...], matchMode: 'and' }` instead of a bare array, matching the new interface. Add one new test:

```ts
it('surfaces ftsMatchMode "or" on the result when the FTS layer fell back to OR', () => {
  // Construct with a fake FTSIndex whose query() returns matchMode: 'or'
  // (read the file's existing fake-FTSIndex construction pattern and mirror
  // it exactly here — the fake must implement the full FTSIndex interface).
});
```

(Fill in the actual fake-construction code once Step 6 reads the real file — the plan cannot know the exact existing fake shape without reading it, but the assertion is: `result.ftsMatchMode` equals `'or'` when the fake's `query()` returns `matchMode: 'or'`, and is `undefined` on a normal `matchMode: 'and'` result.)

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/search/fts-index.ts src/search/hybrid-store.ts test/search/fts-index.test.ts test/search/hybrid-store.test.ts
git commit -m "feat(search): AND-first, OR-fallback FTS5 query relaxation for recall"
```

---

### Task 2: Porter stemmer via safe build-verify-swap rebuild

**Files:**
- Create: `src/maintenance/rebuild-fts-tokenizer.ts`
- Modify: `src/search/fts-index.ts` (export a small helper Task 2 needs)
- Modify: `src/bin/karpathy.ts`
- Test: `test/maintenance/rebuild-fts-tokenizer.test.ts`

**Interfaces:**
- Consumes: `FTSIndex`'s `sync` semantics are not reused directly (the rebuild walks the vault itself against a *new* table name, since `sync()` is hardcoded to `notes_fts`) — instead this task writes its own walk-and-populate logic against an explicit table name, mirroring `fts-index.ts`'s existing `walkMarkdown` generator logic exactly (duplicated intentionally, since `walkMarkdown` is a private closure inside `openFTSIndex`, not exported — exporting it is in-scope if that proves cleaner once you're editing the file, but duplication is acceptable here given this is a one-time migration tool, not a hot path).
- Produces: `rebuildFtsWithStemmer(db: Database.Database, vaultRoot: string, vaultDirs: string[]): Promise<{ oldCount: number; newCount: number; sampleQueriesOk: boolean }>` (dry-run: builds + verifies, does NOT swap) and `swapFtsTable(db: Database.Database): void` (the actual atomic rename, called only after the dry-run's counts/samples check out).

- [ ] **Step 1: Write the failing test for the build+verify phase**

Create `test/maintenance/rebuild-fts-tokenizer.test.ts`:

```ts
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
    writeFileSync(join(vaultDir, 'wiki', 'b.md'), '---\ntitle: B\n---\nThe team is meeting again to discuss the decision.');
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
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notes_fts%'`)
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
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notes_fts%'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['notes_fts', 'notes_fts_old']);
    // The live notes_fts (now the renamed v2) must be queryable and stemmed-tokenized.
    const rows = db2.prepare(`SELECT doc_id FROM notes_fts WHERE notes_fts MATCH 'hello'`).all() as { doc_id: string }[];
    expect(rows).toHaveLength(1);

    db2.close();
    rmSync(vaultDir2, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/maintenance/rebuild-fts-tokenizer.test.ts`
Expected: FAIL — `src/maintenance/rebuild-fts-tokenizer.ts` does not exist yet.

- [ ] **Step 3: Implement `rebuild-fts-tokenizer.ts`**

Create `src/maintenance/rebuild-fts-tokenizer.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/maintenance/rebuild-fts-tokenizer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the `maintenance --rebuild-fts-tokenizer` CLI command**

Read `src/bin/karpathy.ts`'s existing `maintenanceCommand` function in full first (search for `async function maintenanceCommand`) to match its exact existing argument-parsing and config/db-opening conventions. Add a new subcommand branch inside it, following the same pattern as its neighbors:

```ts
    case 'rebuild-fts-tokenizer': {
      const confirm = subArgs.includes('--confirm');
      const config = await loadConfig(); // matches this file's existing convention (no arg — loadConfig defaults internally)
      const dbPath = join(process.cwd(), config.stateDir, 'embeddings.sqlite');
      const db = new Database(dbPath);
      try {
        const { rebuildFtsWithStemmer, swapFtsTable } = await import('../maintenance/rebuild-fts-tokenizer.js');
        const layout = layoutFromConfig(config);
        const vaultDirs = [layout.wiki, layout.aiSummaries, layout.sources, layout.review];
        console.log('Building new Porter-stemmed FTS table (does not touch the live table yet)...');
        const result = await rebuildFtsWithStemmer(db, config.vaultPath, vaultDirs);
        console.log(`Old table: ${result.oldCount} rows. New table: ${result.newCount} rows. Sample queries OK: ${result.sampleQueriesOk}.`);
        if (!result.sampleQueriesOk) {
          console.error('Sample verification queries failed against the new table — NOT swapping. Investigate before retrying.');
          return;
        }
        if (Math.abs(result.newCount - result.oldCount) > result.oldCount * 0.05) {
          console.error(
            `New table's row count differs from the old table by more than 5% (${result.oldCount} -> ${result.newCount}) — NOT swapping automatically. Investigate before retrying with --confirm.`,
          );
          return;
        }
        if (!confirm) {
          console.log('Dry run complete and looks safe. Re-run with --confirm to perform the live swap.');
          return;
        }
        swapFtsTable(db);
        console.log('Swap complete. Old table preserved as notes_fts_old for one verification cycle — drop it manually once confirmed working.');
      } finally {
        db.close();
      }
      break;
    }
```

(Match the exact variable names already in scope in `maintenanceCommand` — e.g. if the function already has a `config`/`db` variable from an outer scope rather than needing its own, adjust to reuse those instead of re-declaring, per whatever the real function body looks like once you read it in Step 5.)

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/maintenance/rebuild-fts-tokenizer.ts src/bin/karpathy.ts test/maintenance/rebuild-fts-tokenizer.test.ts
git commit -m "feat(maintenance): safe build-verify-swap FTS5 rebuild with Porter stemmer"
```

- [ ] **Step 8: Run the real dry-run against the live production index**

Run: `node dist/bin/karpathy.js maintenance rebuild-fts-tokenizer` (no `--confirm` — this only builds and reports, never mutates the live table). If `dist/` isn't built for this branch's changes yet, run via `npx tsx src/bin/karpathy.ts maintenance rebuild-fts-tokenizer` instead.

Expected: prints old/new row counts (should be close — within the 5% check above) and `Sample queries OK: true`. Do **not** pass `--confirm` as part of this plan's execution — actually swapping the live production index is a deliberate, separate action for Tom to trigger once he's reviewed the dry-run numbers, not something this plan auto-executes.

---

### Task 3: Entity duplicate merge + alias-authoring tool

**Files:**
- Create: `src/maintenance/list-entity-aliases.ts`
- Modify: `src/bin/karpathy.ts`
- Test: `test/maintenance/list-entity-aliases.test.ts`

**Interfaces:**
- Consumes: `parseNote`/`serializeNote` (`src/vault/frontmatter.js`), `VaultAdapter.listMarkdownFiles`/`read`/`atomicWrite` (`src/vault/adapter.js`), `layoutFromConfig` (`src/vault/paths.js`).
- Produces: `listEntitiesNeedingAliases(vault: VaultAdapter, entitiesDir: string): Promise<Array<{ path: string; canonicalName: string; currentAliases: string[] }>>` and `writeAliases(vault: VaultAdapter, path: string, aliases: string[]): Promise<void>`.

**Part A — resolve the real Bryan Pino / pino duplicate (no new code, uses existing tooling):**

- [ ] **Step 1: Run duplicate detection against the live vault**

Confirmed: `detect-entity-dupes` is a registered job type (`src/jobs/types.ts:42,106`) mapped to `detectEntityDupesHandler` (`src/jobs/handlers/index.ts:71`), but there is no direct CLI command for it today, and the live reconciliation queue file doesn't exist yet on disk — this job has likely never actually run against the current vault. `detectEntityDupesHandler.execute(_job, context)` never uses its `_job` parameter, so it can be invoked directly without the full enqueue/dequeue machinery. Write and run a small one-off script (not part of this plan's permanent codebase — a throwaway invocation, matching how other one-off maintenance checks have been run directly this session):

```ts
// scratch script, run via: npx tsx <path-to-this-file>
import { loadConfig } from './src/config/loader.js';
import { createFsAdapter } from './src/vault/fs-adapter.js';
import { createNoopClient } from './src/enrichment/llm-client.js';
import { detectEntityDupesHandler } from './src/jobs/handlers/detect-entity-dupes.js';

const config = await loadConfig();
const vault = createFsAdapter(config.vaultPath);
const context = {
  vaultPath: config.vaultPath,
  projectRoot: process.cwd(),
  enqueue: async () => { throw new Error('enqueue not needed for this direct invocation'); },
  llm: createNoopClient(),
  vault,
  config,
};
await detectEntityDupesHandler.execute({ id: 'manual', type: 'detect-entity-dupes' } as never, context);
console.log('Done — check Curated/_system/reconciliation-queue.md for new entries.');
```

Expected: the reconciliation queue (`Curated/_system/reconciliation-queue.md`, per `RECONCILIATION_QUEUE_REGION`) gets created with a new pending entry for `Bryan Pino.md` / `pino.md`.

- [ ] **Step 2: Resolve it via the existing `reconcile_entities` MCP tool**

Call the `reconcile_entities` tool with no arguments to see the pending entry and its `id`, then call it again with `{ id: <the real id>, decision: "merge" }` (verify from the tool's response which of `Bryan Pino.md`/`pino.md` is `sourcePath` vs `targetPath` before confirming — merge direction matters for which page survives as canonical).

Expected: response confirms `"Merged ... -> ..."` with `aliasesAdded` and `wikilinksRewritten` counts; the surviving entity page now has the other name unioned into its `aliases` array (per `entity-merger.ts`'s existing merge logic).

**Part B — new alias-authoring tool:**

- [ ] **Step 3: Write the failing test**

Create `test/maintenance/list-entity-aliases.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { listEntitiesNeedingAliases, writeAliases } from '../../src/maintenance/list-entity-aliases.js';
import type { VaultAdapter } from '../../src/vault/adapter.js';

function fakeVault(files: Record<string, string>): VaultAdapter {
  const store = { ...files };
  return {
    async ensureFolder() {},
    async listMarkdownFiles(folder: string) {
      return Object.keys(store).filter((p) => p.startsWith(folder));
    },
    async listFiles(folder: string) {
      return Object.keys(store).filter((p) => p.startsWith(folder));
    },
    async read(path: string) {
      return store[path];
    },
    async write(path: string, content: string) {
      store[path] = content;
    },
    async create(path: string, content: string) {
      store[path] = content;
    },
    async exists(path: string) {
      return path in store;
    },
    async getModifiedTime() {
      return Date.now();
    },
    async atomicWrite(path: string, content: string) {
      store[path] = content;
    },
    async delete(path: string) {
      delete store[path];
    },
  };
}

describe('listEntitiesNeedingAliases', () => {
  it('lists every entity note with its canonical name and current (possibly empty) aliases', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/alice.md':
        '---\ntitle: Alice\ntype: entity\nentity_kind: person\ncanonical_name: Alice Smith\naliases: []\n---\nBody text.',
      'Curated/wiki/entities/bob.md':
        '---\ntitle: Bob\ntype: entity\nentity_kind: person\ncanonical_name: Bob Jones\naliases: ["Bobby"]\n---\nBody text.',
    });
    const result = await listEntitiesNeedingAliases(vault, 'Curated/wiki/entities');
    expect(result.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'Curated/wiki/entities/alice.md', canonicalName: 'Alice Smith', currentAliases: [] },
      { path: 'Curated/wiki/entities/bob.md', canonicalName: 'Bob Jones', currentAliases: ['Bobby'] },
    ]);
  });

  it('skips the entities folder _index.md file', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/_index.md': '---\ntitle: Entities Index\ntype: index\n---\nAuto-generated.',
      'Curated/wiki/entities/carol.md':
        '---\ntitle: Carol\ntype: entity\nentity_kind: person\ncanonical_name: Carol Lee\naliases: []\n---\nBody.',
    });
    const result = await listEntitiesNeedingAliases(vault, 'Curated/wiki/entities');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('Curated/wiki/entities/carol.md');
  });
});

describe('writeAliases', () => {
  it('writes new aliases into frontmatter while preserving the rest of the note', async () => {
    const vault = fakeVault({
      'Curated/wiki/entities/dan.md':
        '---\ntitle: Dan\ntype: entity\nentity_kind: person\ncanonical_name: Dan Park\naliases: []\nstatus: active\n---\nSome body content that must survive.',
    });
    await writeAliases(vault, 'Curated/wiki/entities/dan.md', ['Danny', '@dpark']);
    const updated = await vault.read('Curated/wiki/entities/dan.md');
    expect(updated).toContain('Some body content that must survive.');
    expect(updated).toMatch(/aliases:\s*\n?\s*-\s*Danny/);
    expect(updated).toMatch(/@dpark/);
    expect(updated).toContain('status: active');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/maintenance/list-entity-aliases.test.ts`
Expected: FAIL — `src/maintenance/list-entity-aliases.ts` does not exist yet.

- [ ] **Step 3: Implement `list-entity-aliases.ts`**

Create `src/maintenance/list-entity-aliases.ts`:

```ts
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';

export interface EntityAliasEntry {
  path: string;
  canonicalName: string;
  currentAliases: string[];
}

/** Lists every real entity note (skips auto-generated _index.md files) with
 * its canonical name and current aliases, for a human to review in one
 * sitting — the vault has zero alias-revealing text in note bodies to mine
 * automatically (confirmed by direct grep across all entity notes), so
 * this is deliberately a listing tool for human input, not an AI-guess tool. */
export async function listEntitiesNeedingAliases(
  vault: VaultAdapter,
  entitiesDir: string,
): Promise<EntityAliasEntry[]> {
  const files = await vault.listMarkdownFiles(entitiesDir);
  const entries: EntityAliasEntry[] = [];
  for (const path of files) {
    if (path.endsWith('/_index.md') || path.endsWith('_index.md')) continue;
    const raw = await vault.read(path);
    const { data } = parseNote(raw);
    const canonicalName = typeof data.canonical_name === 'string' ? data.canonical_name : String(data.title ?? path);
    const currentAliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
    entries.push({ path, canonicalName, currentAliases });
  }
  return entries;
}

/** Writes a new aliases array into one entity note's frontmatter, preserving
 * every other field and the full body untouched. */
export async function writeAliases(vault: VaultAdapter, path: string, aliases: string[]): Promise<void> {
  const raw = await vault.read(path);
  const { data, body } = parseNote(raw);
  const updated = { ...data, aliases };
  await vault.atomicWrite(path, serializeNote(updated, body));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/maintenance/list-entity-aliases.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add a low-friction CLI walkthrough**

Add a new top-level command (following the exact dispatch pattern already in `src/bin/karpathy.ts` — read the file's top-level `switch`/command-registration structure first to match it precisely) named `entity-aliases`:

```ts
    case 'entity-aliases': {
      const { layoutFromConfig } = await import('../vault/paths.js');
      const { createFsAdapter } = await import('../vault/fs-adapter.js');
      const { listEntitiesNeedingAliases, writeAliases } = await import('../maintenance/list-entity-aliases.js');
      const readline = await import('node:readline/promises');

      const config = await loadConfig(); // matches this file's existing convention (no arg — loadConfig defaults internally)
      const layout = layoutFromConfig(config);
      const vault = createFsAdapter(config.vaultPath); // matches this file's existing construction pattern (e.g. line 190)

      const entries = await listEntitiesNeedingAliases(vault, layout.wiki + '/entities');
      console.log(`${entries.length} entities found. Press Enter to skip any entity, or type comma-separated aliases.\n`);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      for (const entry of entries) {
        const existing = entry.currentAliases.length > 0 ? ` (current: ${entry.currentAliases.join(', ')})` : '';
        const answer = await rl.question(`${entry.canonicalName}${existing}: `);
        const trimmed = answer.trim();
        if (trimmed.length === 0) continue;
        const newAliases = [...new Set([...entry.currentAliases, ...trimmed.split(',').map((a) => a.trim()).filter(Boolean)])];
        await writeAliases(vault, entry.path, newAliases);
        console.log(`  -> saved: ${newAliases.join(', ')}`);
      }
      rl.close();
      console.log('Done.');
      break;
    }
```

(This step's exact import names for the vault adapter factory and config loader must be verified against the real file during implementation — `src/bin/karpathy.ts` already imports and uses both elsewhere in the file for other commands; match those exact existing imports rather than the placeholder names shown here.)

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/maintenance/list-entity-aliases.ts src/bin/karpathy.ts test/maintenance/list-entity-aliases.test.ts
git commit -m "feat(maintenance): entity alias-authoring CLI walkthrough"
```

- [ ] **Step 8: Run the real tool against the live vault**

Run: `node dist/bin/karpathy.js entity-aliases` (or via `npx tsx src/bin/karpathy.ts entity-aliases` if `dist/` isn't rebuilt yet) and actually walk through all real entity notes, supplying real aliases where known. This is Tom's own single-sitting data-entry pass, not something an implementer subagent can meaningfully do on his behalf — flag this step back to Tom rather than skipping or fabricating answers.

---

## Post-plan note for the next plan

After Task 1 lands and is verified, `eval-fairness-topup`'s `author-absent.ts` gating change should be implemented next (per that spec's §1.1 cross-spec sequencing note) — its absent-item confirmation needs to reflect grep-first's *final* post-relaxation behavior, not the pre-Task-1 state. Task 2's live swap (`--confirm`) and Task 3 Part B's real alias-entry sitting are both explicitly left as Tom's own follow-up actions, not part of this plan's automated execution.
