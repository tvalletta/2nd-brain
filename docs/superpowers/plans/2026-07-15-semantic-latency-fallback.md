# Semantic Search Latency Fix + Confidence-Gated Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `EmbeddingStore.search()`'s brute-force JS scan with `sqlite-vec` (a real native SQLite extension, no new server process), fix the now-confirmed root cause of issue I9 (a scale mismatch between RRF and recency scores that lets recency manufacture a relevance floor), and wire semantic search back into the live MCP `search` tool as a confidence-gated fallback rather than an always-on path.

**Architecture:** Task 1 adds a `vec_embeddings` vec0 virtual table alongside the existing `embeddings` table (kept as the source of truth for text/metadata), dual-writing on every upsert/delete and rewriting `search()` to query via vec0. Task 2 fixes the RRF/recency scale mismatch found by reading the actual fusion code this session (not a guess) and verifies it against both the known-absent candidates and real eval queries. Task 3 changes the live `search` MCP tool's default behavior from always-hybrid to keyword-first-with-gated-fallback, behind a feature flag defaulting off.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, better-sqlite3, **new dependency: `sqlite-vec`** (npm package `sqlite-vec` + platform binary `sqlite-vec-darwin-arm64`, prebuilt, no compile step).

## Global Constraints

- `sqlite-vec` (current stable `0.1.9`) is confirmed brute-force internally as of this version (verified via the project's own open ANN tracking issue) — the speedup comes from native/SIMD execution replacing the JS `BLOB→Float32Array` + `JSON.parse`-per-row overhead, not from approximation. Results stay exact; no recall/accuracy tradeoff from this change.
- The real `embeddings` table schema (confirmed, `src/embeddings/store.ts:112-126`): `CREATE TABLE embeddings (provider_id TEXT, doc_id TEXT, chunk_index INTEGER, chunk_hash TEXT, text TEXT, vector BLOB, metadata TEXT, updated_at TEXT, PRIMARY KEY (provider_id, doc_id, chunk_index))` — no `WITHOUT ROWID`, so it has an implicit integer rowid (verify this directly in Task 1 Step 1 rather than assume).
- **I9's root cause is now confirmed, not speculative** (found this session by reading the real code): `finalScore = alpha*rrfScore + beta*recency` (`hybrid-store.ts:213`) combines two wildly different-scale quantities as if they were comparable. `recency` is bounded `[0, 0.5]` (`hybrid-store.ts:313`). Raw RRF `score` with `k=60` (`rrf.ts:10`) has a per-list max contribution of `1/60 ≈ 0.0167`, so even a rank-0 hit in both lists tops out around `0.033` — roughly **10-15x smaller** than recency's range. With `beta` at 0.1-0.3 (`src/config/schema.ts:93-102`) and `alpha = 1-beta` (0.7-0.9), `beta*recency`'s max (0.075-0.15) already exceeds or rivals `alpha*rrfScore`'s max (0.012-0.03) for ANY query, relevant or not — recency doesn't just create a floor for irrelevant docs, it can outweigh genuine relevance signal entirely.
- All new/modified files use `.js` extensions on relative imports.
- `EmbeddingProvider` (confirmed, `src/embeddings/provider.ts:12-19`) exposes `readonly dimensions: number` (plural — not `dimension`). This varies by provider: `createDeterministicProvider()` (used throughout the test suite) uses 256 (`DETERMINISTIC_DIMS`, `src/embeddings/provider.ts:25`), the real production `createOllamaProvider` (nomic-embed-text) defaults to 768 (`src/embeddings/ollama.ts:27`), and `createBedrockTitanProvider` supports 256/512/1024. The `vec_embeddings` table's fixed-width `float[N]` column must therefore be created using `opts.provider.dimensions` at store-open time, not a hardcoded literal — see Task 1 Step 5.
- `openEmbeddingStore` (confirmed, `src/embeddings/store.ts:84-97`) accepts `{ provider, dbPath? , db? }` — either `dbPath` (it opens its own `Database`) or a pre-opened `db` handle works; it throws if neither is given.

---

### Task 1: sqlite-vec integration

**Files:**
- Modify: `package.json` (add `sqlite-vec` dependency)
- Modify: `src/embeddings/store.ts`
- Test: `test/embeddings/store.test.ts`

**Interfaces:**
- No changes to `EmbeddingStore`'s public interface (`upsert`, `getByDoc`, `replaceDoc`, `deleteDoc`, `search`, `all`, `count`, `getCacheStats`, `resetCacheStats`, `pruneProvider`, `listProviders`, `close`) — this is an internal implementation swap, callers are unaffected.

- [ ] **Step 1: Verify the rowid assumption against the real table**

Before writing any code, confirm `embeddings` has a usable implicit rowid (needed to join `vec_embeddings` back to it). Run directly against a scratch copy (not the live production DB):

```bash
cp .karpathy/state/embeddings.sqlite /tmp/embeddings-rowid-check.sqlite
node -e "
const Database = require('better-sqlite3');
const db = new Database('/tmp/embeddings-rowid-check.sqlite', { readonly: true });
const row = db.prepare('SELECT rowid, provider_id, doc_id, chunk_index FROM embeddings LIMIT 1').get();
console.log(row);
"
rm /tmp/embeddings-rowid-check.sqlite
```

Expected: a row with a real `rowid` integer field alongside the named columns — confirms the composite-PK table still exposes rowid. If this fails (e.g., `no such column: rowid`), STOP and re-derive the join-key design in Task 1 Step 3 before proceeding — do not assume it works.

- [ ] **Step 2: Add the `sqlite-vec` dependency**

```bash
pnpm add sqlite-vec
```

Verify it installed `sqlite-vec-darwin-arm64` (or the relevant platform package) as an optional dependency without requiring a compile step:

```bash
ls node_modules/.pnpm/ | grep sqlite-vec
```

- [ ] **Step 3: Write the failing test for vec0 schema + dual-write**

`test/embeddings/store.test.ts`'s existing `beforeEach` (confirmed, lines 17-23) constructs `store` via `openEmbeddingStore({ dbPath: join(dir, 'embeddings.sqlite'), provider: createDeterministicProvider() })` — it doesn't keep a `Database` handle around for direct SQL introspection, since `openEmbeddingStore` opens its own internally in `dbPath` mode. The new tests need direct SQL access to verify `vec_embeddings`, so they construct their own `Database` and pass it via the `db` option instead (both are supported per `EmbeddingStoreOptions`, Global Constraints). Add:

```ts
import Database from 'better-sqlite3';
```

to the existing import block, then add:

```ts
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
```

The fourth test relies on `createDeterministicProvider()` producing closer vectors for near-identical text than for unrelated text (this must hold for a "deterministic" provider used across this whole test suite for exactly this kind of similarity assertion — if it doesn't hold, read `src/embeddings/provider.ts`'s deterministic implementation to confirm what property of the input text it actually keys off of, and adjust the two doc bodies so one is closer to the query under that provider's real scheme).

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/embeddings/store.test.ts`
Expected: FAIL — no `vec_embeddings` table exists yet, `search()` still uses brute-force scan.

- [ ] **Step 5: Implement the vec0 table, dual-write, and vec0-backed search**

In `src/embeddings/store.ts`, add the import at the top:

```ts
import * as sqliteVec from 'sqlite-vec';
```

Right after the `mkdirSync`/`db = new Database(...)` setup block (after line 110, before the existing `db.exec(CREATE TABLE embeddings...)` call), add:

```ts
  sqliteVec.load(db);
```

After the existing `CREATE TABLE embeddings` block (after line 126), add:

```ts
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      vector float[${opts.provider.dimensions}] distance_metric=cosine
    );
  `);
```

This uses `opts.provider.dimensions` (confirmed field, Global Constraints) rather than a hardcoded literal — the deterministic test provider uses 256, Ollama (production) uses 768, and Bedrock Titan can be 256/512/1024, so a fixed literal would break every test using the deterministic provider and any non-Ollama deployment. `dimensions` is a validated `z.number().int().positive()`-derived value from the configured provider, not user input, so string-interpolating it into DDL (vec0's `float[N]` syntax can't take a bound parameter for `N`) is safe.

**Known limitation, stated explicitly rather than silently ignored:** if a vault's `embeddings.sqlite` already has a `vec_embeddings` table sized for one provider's dimensions (e.g. 768 from Ollama) and the configured provider later changes to one with a different dimension count (e.g. a Bedrock Titan config at 1024), `CREATE VIRTUAL TABLE IF NOT EXISTS` will silently keep the old-dimension table, and a subsequent `vecUpsertStmt.run(rowid, newVector)` would fail at the SQLite level (dimension mismatch). This is an existing-class-of-problem already handled elsewhere in this codebase for provider swaps (`pruneProvider` exists precisely because switching embedding providers requires reindexing) — it does not need new handling in this plan, but is worth flagging to whoever executes a future provider swap: they'll need to drop and rebuild `vec_embeddings` (a single `DROP TABLE vec_embeddings` plus re-running Step 9's backfill) as part of that swap, same as they already must reprocess the `embeddings` table's rows for the new provider.

Add two new prepared statements near the existing ones (after `cacheLookupStmt`):

```ts
  const vecUpsertStmt = db.prepare(`INSERT INTO vec_embeddings (rowid, vector) VALUES (?, ?) ON CONFLICT(rowid) DO UPDATE SET vector = excluded.vector`);
  const vecDeleteByRowidStmt = db.prepare(`DELETE FROM vec_embeddings WHERE rowid = ?`);
  const embeddingRowidStmt = db.prepare(
    `SELECT rowid FROM embeddings WHERE provider_id = ? AND doc_id = ? AND chunk_index = ?`,
  );
```

Add a small helper right after `rowToTyped`:

```ts
  /** Looks up the definitive rowid for a just-upserted embeddings row (not
   * `.lastInsertRowid` from the upsert statement, whose semantics on the
   * ON CONFLICT DO UPDATE branch aren't reliably "the updated row" across
   * better-sqlite3/SQLite versions — an explicit lookup is unambiguous). */
  function currentRowid(providerId: string, docId: string, chunkIndex: number): number {
    const row = embeddingRowidStmt.get(providerId, docId, chunkIndex) as { rowid: number };
    return row.rowid;
  }
```

Update the `upsert` method's transaction body (currently lines 228-242) to also dual-write:

```ts
    async upsert(inputs: UpsertInput[]) {
      if (inputs.length === 0) return;
      const vectors = await embedWithCache(inputs);
      const now = new Date().toISOString();
      const tx = db.transaction((items: UpsertInput[]) => {
        items.forEach((it, idx) => {
          upsertStmt.run({
            provider_id: opts.provider.id,
            doc_id: it.doc_id,
            chunk_index: it.chunk_index,
            chunk_hash: it.chunk_hash,
            text: it.text,
            vector: vectorToBuffer(vectors[idx]),
            metadata: JSON.stringify(it.metadata ?? {}),
            updated_at: now,
          });
          const rowid = currentRowid(opts.provider.id, it.doc_id, it.chunk_index);
          vecUpsertStmt.run(rowid, vectorToBuffer(vectors[idx]));
        });
      });
      tx(inputs);
    },
```

Update `replaceDoc`'s transaction body (currently lines 261-280) similarly — add the vec dual-write in both branches:

```ts
    async replaceDoc(docId: string, inputs: UpsertInput[]) {
      const existingPromise = Promise.resolve(this.getByDoc(docId));
      const vectors = inputs.length > 0 ? await embedWithCache(inputs) : [];
      const existing = await existingPromise;
      const now = new Date().toISOString();
      const wantedIndices = new Set(inputs.map((i) => i.chunk_index));

      const tx = db.transaction(() => {
        for (const row of existing) {
          if (!wantedIndices.has(row.chunk_index)) {
            const staleRowid = currentRowid(opts.provider.id, docId, row.chunk_index);
            deleteChunkStmt.run(opts.provider.id, docId, row.chunk_index);
            vecDeleteByRowidStmt.run(staleRowid);
          }
        }
        inputs.forEach((it, idx) => {
          upsertStmt.run({
            provider_id: opts.provider.id,
            doc_id: it.doc_id,
            chunk_index: it.chunk_index,
            chunk_hash: it.chunk_hash,
            text: it.text,
            vector: vectorToBuffer(vectors[idx]),
            metadata: JSON.stringify(it.metadata ?? {}),
            updated_at: now,
          });
          const rowid = currentRowid(opts.provider.id, it.doc_id, it.chunk_index);
          vecUpsertStmt.run(rowid, vectorToBuffer(vectors[idx]));
        });
      });
      tx();
    },
```

**Important ordering note:** the stale-chunk deletion above looks up `staleRowid` via `currentRowid` *before* calling `deleteChunkStmt.run(...)`, since the lookup query depends on the row still existing in `embeddings` at query time.

Update `deleteDoc` (currently lines 283-285):

```ts
    deleteDoc(docId: string) {
      const rows = db.prepare(`SELECT rowid FROM embeddings WHERE provider_id = ? AND doc_id = ?`).all(opts.provider.id, docId) as { rowid: number }[];
      const tx = db.transaction(() => {
        deleteDocStmt.run(opts.provider.id, docId);
        for (const row of rows) vecDeleteByRowidStmt.run(row.rowid);
      });
      tx();
    },
```

Finally, replace the `search` method's brute-force body (currently lines 287-305):

```ts
    async search(queryText, options = {}) {
      const topK = options.topK ?? 10;
      const [qVec] = await opts.provider.embed([queryText]);
      const qBuf = vectorToBuffer(qVec);

      // sqlite-vec's KNN doesn't support an arbitrary JS predicate mid-query,
      // so when a `filter` is given, over-fetch a wider candidate window
      // (10x topK, capped) and filter in JS after hydrating full rows — this
      // preserves the exact same filter semantics as the old brute-force
      // path, just with a much cheaper candidate-generation step.
      const knnLimit = options.filter ? Math.min(topK * 10, 2000) : topK;

      const knnRows = db
        .prepare(
          `SELECT rowid, distance FROM vec_embeddings WHERE vector MATCH ? AND k = ? ORDER BY distance`,
        )
        .all(qBuf, knnLimit) as Array<{ rowid: number; distance: number }>;

      if (knnRows.length === 0) return [];

      const rowids = knnRows.map((r) => r.rowid);
      const placeholders = rowids.map(() => '?').join(',');
      const hydrated = db
        .prepare(
          `SELECT rowid, doc_id, chunk_index, chunk_hash, text, vector, metadata, updated_at
           FROM embeddings WHERE rowid IN (${placeholders})`,
        )
        .all(...rowids) as Array<Parameters<typeof rowToTyped>[0] & { rowid: number }>;
      const byRowid = new Map(hydrated.map((r) => [r.rowid, rowToTyped(r)]));

      // cosine distance in sqlite-vec is `1 - cosine_similarity` — convert
      // back to similarity so callers (and existing tests/callers expecting
      // `SearchHit.similarity`) see the same semantics as before.
      const scored: SearchHit[] = [];
      for (const { rowid, distance } of knnRows) {
        const row = byRowid.get(rowid);
        if (!row) continue;
        if (options.filter && !options.filter(row)) continue;
        scored.push({
          doc_id: row.doc_id,
          chunk_index: row.chunk_index,
          chunk_hash: row.chunk_hash,
          text: row.text,
          metadata: row.metadata,
          updated_at: row.updated_at,
          similarity: 1 - distance,
        });
        if (scored.length >= topK) break;
      }
      return scored;
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/embeddings/store.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (this touches a shared, widely-depended-on module — a regression here would likely show up broadly, so treat any new failure as a signal to investigate, not a fixture to patch around).

- [ ] **Step 8: Commit**

```bash
git add package.json src/embeddings/store.ts test/embeddings/store.test.ts
git commit -m "feat(embeddings): sqlite-vec-backed search, replacing brute-force JS scan"
```

- [ ] **Step 9: One-time backfill migration for existing embeddings**

Write and run a one-off script (scratch, not committed) that opens the real production `.karpathy/state/embeddings.sqlite` **through the real `openEmbeddingStore` function** (so `vec_embeddings` is created with the correct, dynamically-derived dimension for whatever provider production is actually configured with — see Step 5's fix — rather than duplicating/hardcoding the schema here) and, for every existing row in `embeddings`, inserts the corresponding vector into `vec_embeddings` (necessary because Step 5's dual-write only covers *future* writes — existing rows predate it):

```ts
// scratch: npx tsx this-file.ts
import { openStoreFromConfig } from './src/embeddings/factory.js';
import { loadConfig } from './src/config/index.js'; // real no-arg convention, per this codebase's karpathy.ts usage
import Database from 'better-sqlite3';

const config = loadConfig();
// openStoreFromConfig builds the real configured provider (Ollama in
// production) and opens the store — its own setup (Step 5) creates
// vec_embeddings sized to that provider's real `dimensions`, so this
// backfill always matches whatever production is actually configured with.
const store = openStoreFromConfig(config, config.projectRoot ?? process.cwd());
store.close(); // just needed it open once to create vec_embeddings; close before raw SQL below

const db = new Database(`${config.stateDir}/embeddings.sqlite`);
const rows = db.prepare(`SELECT rowid, vector FROM embeddings`).all() as { rowid: number; vector: Buffer }[];
const insertStmt = db.prepare(
  `INSERT INTO vec_embeddings (rowid, vector) VALUES (?, ?) ON CONFLICT(rowid) DO UPDATE SET vector = excluded.vector`,
);
const tx = db.transaction((items: typeof rows) => {
  for (const r of items) insertStmt.run(r.rowid, r.vector);
});
tx(rows);
console.log(`Backfilled ${rows.length} vectors into vec_embeddings.`);
db.close();
```

Run it, confirm the printed count matches production's known embedded-doc-chunk count (should be in the low tens of thousands, matching the real `embeddings` table's current row count — check `SELECT COUNT(*) FROM embeddings` first for the expected number).

- [ ] **Step 10: Real benchmark against production data**

```bash
node -e "
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database('.karpathy/state/embeddings.sqlite', { readonly: true });
sqliteVec.load(db);
const row = db.prepare('SELECT vector FROM embeddings LIMIT 1').get();
const times = [];
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  db.prepare('SELECT rowid, distance FROM vec_embeddings WHERE vector MATCH ? AND k = 10 ORDER BY distance').all(row.vector);
  times.push(Date.now() - t0);
}
times.sort((a,b)=>a-b);
console.log('median ms:', times[Math.floor(times.length/2)], 'p95 ms:', times[Math.floor(times.length*0.95)]);
"
```

Expected: report the real median/p95 numbers (success criterion from the spec: comfortably under 100ms; report whatever the real number is, don't round favorably). This is a read-only benchmark against the live file — safe to run directly.

---

### Task 2: Fix I9 (RRF/recency scale mismatch)

**Files:**
- Modify: `src/search/hybrid-store.ts`
- Test: `test/search/hybrid-store.test.ts`

**Interfaces:**
- No public interface changes — `finalScore`'s computation changes internally; `HybridHit.scores.final` still means the same thing (a blended relevance+recency score), just correctly scaled now.

- [ ] **Step 1: Write the failing test proving the current scale mismatch**

Note on test design: the bug is **not** about relative ranking between two matched docs with equal recency — RRF's rank-based ordering already survives the pre-fix formula when recency is identical for both candidates, since `beta*recency` is a constant added to both. The real, production-observed symptom (issue I9, reproduced this session via `pnpm eval:author-absent`) is **absolute score inflation**: a doc with only an incidental semantic-pool match for a genuinely unrelated query still gets a `finalScore` in the ~0.11-0.16 band instead of something near zero, because `beta*recency` (up to 0.15) dwarfs `alpha*rrfScore` (up to ~0.03). That absolute-score compression is what breaks any downstream consumer that treats the score as a confidence signal (the `author-absent` threshold, and this plan's own Task 3 confidence gate). Test that directly.

Add to `test/search/hybrid-store.test.ts`, matching the file's real fixtures (`store`, `db`, `config` from the existing `beforeEach`):

```ts
it('a semantic-only match for a genuinely unrelated query gets a low absolute score, not inflated by recency (I9 regression guard)', async () => {
  await store.upsertDoc(
    'irrelevant.md',
    'Sourdough Starter Tips',
    'sourdough starter feeding schedule and hydration ratio',
    [
      {
        doc_id: 'irrelevant.md',
        chunk_index: 0,
        chunk_hash: 'h1',
        text: 'sourdough starter feeding schedule and hydration ratio',
        metadata: { type: 'concept' },
      },
    ],
  );
  const result = await store.search('quarterly OKR planning process for the engineering org');
  const hit = result.hits.find((h) => h.docId === 'irrelevant.md');
  // With createDeterministicProvider, an unrelated doc can still surface
  // via the semantic pool (some nonzero cosine similarity for any vector
  // pair), but its absolute finalScore must not be propped up into a
  // "looks confident" range purely by recency. The exact pre-fix score
  // must be read from a real run (see Step 2) before locking in this
  // threshold — do not guess a number in the abstract.
  if (hit) {
    expect(hit.scores.final).toBeLessThan(0.05);
  }
});
```

Before finalizing the `0.05` threshold: run this test against the pre-fix code first (expect it to fail — read the printed actual `hit.scores.final` value from the assertion failure output) to confirm the pre-fix score really does land in the inflated band described in the problem statement, and confirm `0.05` is a meaningful post-fix bar (comfortably above 0 for a real near-match, comfortably below the pre-fix ~0.11-0.16 band) rather than an arbitrary number — adjust the constant if the real observed pre-fix value suggests a different cutoff is more honest.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/search/hybrid-store.test.ts -t "I9 regression guard"`
Expected: FAIL, with the assertion failure output showing the actual pre-fix `hit.scores.final` value — record this real number (expected to be in the ~0.11-0.16 band per the problem statement) before proceeding, confirming the bug reproduces in this test exactly as it does in production.

- [ ] **Step 3: Implement the fix — normalize RRF score before blending with recency**

In `src/search/hybrid-store.ts`, find the RRF fusion section (currently around lines 162-167, building `lists` and calling `rrf(lists)`). Immediately after `const fused = rrf(lists);`, add:

```ts
      // Fix for issue I9: raw RRF scores (max ~1/60 per contributing list,
      // so ~0.017-0.033 total) are on a wildly different scale than
      // `recency` (bounded [0, 0.5]) — combining them directly as
      // `alpha*score + beta*recency` lets recency swamp genuine relevance
      // for ANY query, not just irrelevant ones. Normalize by the
      // theoretical max RRF score for this query's actual pool composition
      // (1/60 per list that contributed) so `normalizedScore` is
      // genuinely in [0, 1] and comparable to recency's scale.
      const maxPossibleRrfScore = lists.length / 60;
      const normalizeScore = (raw: number) => (maxPossibleRrfScore > 0 ? raw / maxPossibleRrfScore : 0);
```

Then change the `finalScore` computation (currently `const finalScore = alpha * score + beta * recency;`) to:

```ts
        const finalScore = alpha * normalizeScore(score) + beta * recency;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/search/hybrid-store.test.ts -t "I9 regression guard"`
Expected: PASS.

- [ ] **Step 5: Run the full existing hybrid-store test suite to check for regressions**

Run: `npx vitest run test/search/hybrid-store.test.ts`
Expected: all pass. If any pre-existing test asserted a specific numeric `final` score value (not just relative ordering), it will need its expected value recalculated under the new formula — read any failures carefully and update expected numbers to the new, correctly-scaled values (recompute by hand from the formula, don't just copy whatever the test run prints without checking it's sane).

- [ ] **Step 6: Real verification against the live index**

Run the same 10 absent-candidate queries from `eval/dataset/author-absent.ts`'s `CANDIDATE_ABSENT_QUERIES` list directly against the live `as-deployed` and `full-cov-hybrid` variants (reuse the pattern from this session's own I9 reproduction: `buildVariants(config, REPO_ROOT, 1)`, loop the candidates, print `store.search(query, {topK:1})`'s top score per variant). Expected: scores for genuinely-irrelevant queries should now be meaningfully lower and more topic-discriminating than the previous ~0.11-0.16 clustered band — report the real before/after numbers.

Also spot-check 3-5 real, known-relevant eval queries (from `eval/dataset/queries.json`) to confirm their top results are unchanged or improved, not regressed by the normalization.

- [ ] **Step 7: Commit**

```bash
git add src/search/hybrid-store.ts test/search/hybrid-store.test.ts
git commit -m "fix(search): normalize RRF score before recency fusion (issue I9)

Raw RRF scores (max ~0.033) and recency (max 0.5) were combined directly
despite being on a 10-15x different scale, letting recency dominate or
create a relevance floor for any query, not just irrelevant ones.
Confirmed root cause by reading the actual fusion code and config
defaults, not by guessing. Normalizes RRF score to [0,1] against the
theoretical max for the query's pool composition before blending."
```

---

### Task 3: Confidence-gated fallback in the live search path

**Files:**
- Modify: `src/config/schema.ts` (new feature-flag field)
- Modify: `src/search/hybrid-store.ts`
- Test: `test/search/hybrid-store.test.ts`

**Interfaces:**
- `HybridSearchResult` gains a new field: `searchMode: 'hybrid' | 'keyword-only' | 'keyword-with-semantic-fallback'` (widens the existing union, doesn't remove either current value).
- New config field: `config.search.semanticFallbackEnabled: boolean` (default `false` — ships off, per the spec's rollout-care requirement).

- [ ] **Step 1: Add the feature-flag config field**

`KarpathyConfigSchema` (confirmed real structure, `src/config/schema.ts:272-289`) has 16 top-level keys, each a sub-schema `.default({})`; a new top-level key requires four coordinated edits, matching the codebase's existing pattern for every other sub-config (`embeddings`, `notifications`, etc.):

1. Add a new schema definition right before `export const KarpathyConfigSchema` (before line 272):

```ts
export const SearchConfigSchema = z.object({
  /** When true, keyword search runs first and semantic search only fires
   * as a fallback on low keyword confidence, instead of running
   * unconditionally on every query. Defaults off — see the
   * semantic-latency-fallback design spec's rollout-care requirement. */
  semanticFallbackEnabled: z.boolean().default(false),
});
```

2. Add `search: SearchConfigSchema.default({}),` as a new line after `layout: LayoutConfigSchema.default({}),` (line 288) in `KarpathyConfigSchema`.

3. Add `const PartialSearchConfigSchema = SearchConfigSchema.partial();` after line 301 (`const PartialLayoutConfigSchema = LayoutConfigSchema.partial();`).

4. Add `search: PartialSearchConfigSchema.optional(),` as a new line after `layout: PartialLayoutConfigSchema.optional(),` in **both** `ProjectOverrideSchema` (currently ending line 318-319) and `GlobalDefaultsSchema` (currently ending line 336-337) — both structs repeat the exact same key list today, so both need the addition to stay consistent with the codebase's existing convention of every sub-config being overridable at both the project and global level.

5. Add `export type SearchConfig = z.infer<typeof SearchConfigSchema>;` alongside the other `export type ... = z.infer<...>` lines (after line 344's `KarpathyConfig` export), matching the existing convention of exporting an inferred type per sub-schema.

- [ ] **Step 2: Write the failing test for confidence gating**

Add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` line (becomes `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`). Add to `test/search/hybrid-store.test.ts`:

```ts
describe('confidence-gated semantic fallback', () => {
  async function buildStoreWithFlag(semanticFallbackEnabled: boolean) {
    const fbDir = await mkdtemp(join(tmpdir(), 'karpathy-hybrid-fb-'));
    const fbConfig = KarpathyConfigSchema.parse({
      vaultPath: fbDir,
      embeddings: { provider: 'deterministic' },
      search: { semanticFallbackEnabled },
    });
    const fbDb = new Database(join(fbDir, 'hybrid.sqlite'));
    fbDb.pragma('journal_mode = WAL');
    const fbFts = openFTSIndex(fbDb, { vaultRoot: fbDir });
    const fbEmbeddings = openEmbeddingStore({ db: fbDb, provider: createDeterministicProvider() });
    const searchSpy = vi.spyOn(fbEmbeddings, 'search');
    const fbStore = createHybridStore({ config: fbConfig, db: fbDb, fts: fbFts, embeddings: fbEmbeddings });
    return {
      store: fbStore,
      searchSpy,
      cleanup: async () => {
        fbStore.close();
        fbDb.close();
        await rm(fbDir, { recursive: true, force: true });
      },
    };
  }

  it('does not run the semantic path when keyword search already found >= 3 hits and semanticFallbackEnabled is true', async () => {
    const { store: fbStore, searchSpy, cleanup } = await buildStoreWithFlag(true);
    try {
      await fbStore.upsertDoc('a.md', 'Banana', 'banana harness one', []);
      await fbStore.upsertDoc('b.md', 'Banana', 'banana harness two', []);
      await fbStore.upsertDoc('c.md', 'Banana', 'banana harness three', []);
      const result = await fbStore.search('banana harness');
      expect(searchSpy).not.toHaveBeenCalled();
      expect(result.searchMode).toBe('keyword-only');
    } finally {
      await cleanup();
    }
  });

  it('runs the semantic path as a fallback when keyword search returns zero hits and semanticFallbackEnabled is true', async () => {
    const { store: fbStore, searchSpy, cleanup } = await buildStoreWithFlag(true);
    try {
      await fbStore.upsertDoc(
        'd.md',
        'Sourdough',
        'sourdough starter feeding schedule',
        [
          {
            doc_id: 'd.md',
            chunk_index: 0,
            chunk_hash: 'h1',
            text: 'sourdough starter feeding schedule',
            metadata: { type: 'concept' },
          },
        ],
      );
      const result = await fbStore.search('a completely different unrelated topic zzz');
      expect(searchSpy).toHaveBeenCalled();
      expect(result.searchMode).toBe('keyword-with-semantic-fallback');
    } finally {
      await cleanup();
    }
  });

  it('never runs the semantic path at all when semanticFallbackEnabled is false, regardless of keyword confidence', async () => {
    const { store: fbStore, searchSpy, cleanup } = await buildStoreWithFlag(false);
    try {
      const result = await fbStore.search('zero fts hits for this query zzz');
      expect(searchSpy).toHaveBeenCalled(); // unchanged today's behavior: always consults semantic when flag is off
      expect(result.searchMode).toBe('hybrid');
    } finally {
      await cleanup();
    }
  });
});
```

The third test's expectations look counter-intuitive at first — with the flag off, behavior must exactly match *today's* pre-existing always-on path (semantic always runs, `searchMode` stays `'hybrid'`), which is the deliberate current-production-safe default described in Step 4's design. Only the first two tests exercise the new gating behavior.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/search/hybrid-store.test.ts -t "confidence-gated"`
Expected: FAIL — no gating logic exists yet; semantic search always runs today regardless of config.

- [ ] **Step 4: Implement the confidence gate**

In `src/search/hybrid-store.ts`, update the `HybridSearchResult` interface (line 60-64, currently `searchMode: 'hybrid' | 'keyword-only';`) to:

```ts
export interface HybridSearchResult {
  hits: HybridHit[];
  searchMode: 'hybrid' | 'keyword-only' | 'keyword-with-semantic-fallback';
  degradationNote?: string;
}
```

In the `search()` method, the current code (lines 119-149) always runs the embedding pool whenever the provider is up:

```ts
      let semanticHits: SemanticHit[] = [];
      let searchMode: 'hybrid' | 'keyword-only' = 'hybrid';
      let degradationNote: string | undefined;

      // Embedding pool — gated on provider availability.
      const providerUp =
        config.embeddings.provider === 'ollama' ? await isProviderAvailable() : true;

      if (providerUp) {
        try {
          const raw = await embeddings.search(query, { topK: poolK });
          semanticHits = raw.map((h) => ({
            doc_id: h.doc_id,
            chunk_index: h.chunk_index,
            chunk_hash: h.chunk_hash,
            text: h.text,
            metadata: h.metadata,
            updated_at: h.updated_at,
            similarity: h.similarity,
          }));
        } catch (err) {
          searchMode = 'keyword-only';
          degradationNote = `Semantic search unavailable: ${(err as Error).message}. Returning keyword results only.`;
        }
      } else {
        searchMode = 'keyword-only';
        degradationNote =
          config.embeddings.provider === 'ollama'
            ? 'Ollama not running — keyword results only. Run `ollama serve` to enable semantic search.'
            : 'Embedding provider unavailable — keyword results only.';
      }
```

Replace it with:

```ts
      let semanticHits: SemanticHit[] = [];
      let searchMode: 'hybrid' | 'keyword-only' | 'keyword-with-semantic-fallback' = 'hybrid';
      let degradationNote: string | undefined;

      // Confidence gate (spec: semantic-latency-fallback-design.md §4): when
      // the fallback feature is enabled, only consult the semantic pool if
      // keyword search alone looks under-confident — zero hits or fewer
      // than 3. Score-based gating is deliberately deferred until real
      // BM25-score-distribution calibration data exists (see the plan's
      // Task 3 post-plan note), rather than guessing a cutoff. When the
      // flag is off, behavior is byte-for-byte the pre-existing always-on
      // path.
      const keywordLooksLowConfidence = ftsHits.length === 0 || ftsHits.length < 3;
      const shouldConsultSemantic =
        !config.search.semanticFallbackEnabled || keywordLooksLowConfidence;
      const isFallbackAttempt =
        config.search.semanticFallbackEnabled && keywordLooksLowConfidence;

      const providerUp =
        shouldConsultSemantic && config.embeddings.provider === 'ollama'
          ? await isProviderAvailable()
          : shouldConsultSemantic;

      if (shouldConsultSemantic && providerUp) {
        try {
          const raw = await embeddings.search(query, { topK: poolK });
          semanticHits = raw.map((h) => ({
            doc_id: h.doc_id,
            chunk_index: h.chunk_index,
            chunk_hash: h.chunk_hash,
            text: h.text,
            metadata: h.metadata,
            updated_at: h.updated_at,
            similarity: h.similarity,
          }));
          if (isFallbackAttempt) searchMode = 'keyword-with-semantic-fallback';
        } catch (err) {
          searchMode = 'keyword-only';
          degradationNote = `Semantic search unavailable: ${(err as Error).message}. Returning keyword results only.`;
        }
      } else if (!shouldConsultSemantic) {
        searchMode = 'keyword-only';
      } else {
        searchMode = 'keyword-only';
        degradationNote =
          config.embeddings.provider === 'ollama'
            ? 'Ollama not running — keyword results only. Run `ollama serve` to enable semantic search.'
            : 'Embedding provider unavailable — keyword results only.';
      }
```

(When `semanticFallbackEnabled` is `false`: `shouldConsultSemantic` is always `true` and `isFallbackAttempt` is always `false`, so this reduces exactly to the original always-on path — `searchMode` only ever lands on `'hybrid'` or `'keyword-only'`, never the new third value. The new value appears only when the flag is on AND the semantic pool was actually consulted as a fallback.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/search/hybrid-store.test.ts`
Expected: PASS, including all pre-existing tests (default-off behavior must be unchanged).

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts src/search/hybrid-store.ts test/search/hybrid-store.test.ts
git commit -m "feat(search): confidence-gated semantic fallback behind semanticFallbackEnabled (default off)"
```

---

## Post-plan note — rollout is a separate, deliberate step

This plan ships `semanticFallbackEnabled: false` by default (per the spec's §4.3 rollout-care requirement) — flipping it on for real is a distinct, later decision, not automated by this plan's execution. Before flipping it: (a) confirm Task 2's I9 fix and Task 1's latency numbers both hold up under a real sampling window of live usage, (b) consider adding the score-based (not just hit-count-based) confidence signal once real BM25-score-distribution data exists (today's `mcp-usage.jsonl` doesn't record it — a small logging addition would be needed first, per the spec §4.1). Also out of scope here: backfilling production's embedding coverage beyond its current ~34% (spec §6 — explicit non-goal, preserves the bake-off's cost/complexity tradeoff).
