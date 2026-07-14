# Arm B Embedding Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disposable, full-coverage-embedding copy of the live index (Track B bake-off's Arm B — `docs/superpowers/specs/2026-07-06-architecture-bakeoff-remediation-design.md` §4.2, §10) by backfilling embeddings for currently-unembedded docs under `Plaud/`, `Curated/sources/`, and `AI Conversations/` into `eval/state/bakeoff-fullcov.sqlite`, and record the backfill's real cost (wall-clock, tokens, DB size delta) for Arm B's simplicity score.

**Architecture:** A standalone orchestrator script (`eval/state/backfill-arm-b.ts`, `pnpm eval:arm-b-backfill`) with two pure, unit-testable primitives (target selection, report assembly) and an I/O-heavy `main()` that copies the DB, opens a `HybridStore` against the copy via the existing `openVariantStore`, and runs the actual embedding backfill with bounded concurrency.

**Tech Stack:** TypeScript ESM (`.js` import extensions), `better-sqlite3`, vitest, no new dependencies.

## Global Constraints

- **Never mutate production.** All work happens against a fresh copy at `eval/state/bakeoff-fullcov.sqlite`, copied from the live `.karpathy/state/embeddings.sqlite` at the start of every run.
- **Backfill scope is exactly 3 prefixes**, confirmed with Tom (spec §10): `Plaud/`, `Curated/sources/`, `AI Conversations/`. Do NOT include `raw/` (pre-ingestion staging, out of scope).
- A doc counts as "already embedded" only for the **dominant `provider_id`** currently in the embeddings table (mirrors `eval/score/coverage.ts`'s exact pattern: `SELECT provider_id, COUNT(DISTINCT doc_id) c FROM embeddings GROUP BY provider_id ORDER BY c DESC LIMIT 1`) — not just "any row exists for this doc_id."
- Chunking must exactly mirror `src/jobs/handlers/embedding-index.ts`: `chunkText(body, 1200, 4000)` from `src/embeddings/store.ts`.
- Concurrency default: 6 (matches the real throughput test in spec §10 — ~21 embedding calls/sec at concurrency 6 with realistic ~4000-char chunks).
- A single doc's read/chunk/embed failure is caught, logged, and skipped — never aborts the run. Failed doc_ids are recorded in the final report.
- The report file `eval/results/<date>-arm-b-backfill.json` must use these exact field names (matching spec §6.2's `backfill_ledger` shape so the eventual bake-off assembly step can consume it without reshaping): `notes_embedded`, `notes_failed`, `wall_clock_min`, `token_cost_estimate`, `db_size_before_bytes`, `db_size_after_bytes`, `db_size_delta_gb`, `failed_doc_ids`.
- `token_cost_estimate` uses chars/4 (matches `eval/score/tokens.ts`'s `measurePayload` convention: `Math.ceil(chars / 4)`).
- All new files use `.js` extensions on relative imports (this codebase's ESM convention).

---

### Task 1: Target selection + report assembly (pure, testable)

**Files:**
- Create: `eval/state/backfill-arm-b.ts` (this task adds only the two pure functions + their types; Task 2 adds `main()` to the same file)
- Test: `test/eval/backfill-arm-b.test.ts`

**Interfaces:**
- Consumes: nothing from elsewhere yet — these are pure functions over primitive inputs (a `better-sqlite3` `Database` instance for target selection; plain numbers/strings for report assembly).
- Produces (used by Task 2):
  - `BACKFILL_PREFIXES: readonly string[]` — the 3 confirmed scope prefixes.
  - `selectBackfillTargets(db: Database.Database): string[]`
  - `interface BackfillReport { notes_embedded: number; notes_failed: number; wall_clock_min: number; token_cost_estimate: number; db_size_before_bytes: number; db_size_after_bytes: number; db_size_delta_gb: number; failed_doc_ids: string[]; }`
  - `buildBackfillReport(input: { notesEmbedded: number; failedDocIds: string[]; wallClockMs: number; tokenCostEstimate: number; dbSizeBeforeBytes: number; dbSizeAfterBytes: number }): BackfillReport`

- [ ] **Step 1: Write the failing tests**

Create `test/eval/backfill-arm-b.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/eval/backfill-arm-b.test.ts`
Expected: FAIL — `eval/state/backfill-arm-b.ts` does not exist yet.

- [ ] **Step 3: Implement the two pure functions**

Create `eval/state/backfill-arm-b.ts`:

```ts
import Database from 'better-sqlite3';

/** Confirmed with Tom (spec §10, 2026-07-14): raw/ is pre-ingestion staging,
 * not curated/retrievable target content — excluded from Arm B's backfill
 * scope even though it's part of the live index's unembedded docs. */
export const BACKFILL_PREFIXES = ['Plaud/', 'Curated/sources/', 'AI Conversations/'] as const;

/** Doc_ids under the 3 confirmed scope prefixes that have no embedding row
 * under the CURRENT dominant provider_id — mirrors eval/score/coverage.ts's
 * exact "dominant provider" convention (a doc embedded only under a stale/
 * minority provider_id still counts as needing backfill for the real one). */
export function selectBackfillTargets(db: Database.Database): string[] {
  const dominant = db
    .prepare('SELECT provider_id, COUNT(DISTINCT doc_id) c FROM embeddings GROUP BY provider_id ORDER BY c DESC LIMIT 1')
    .get() as { provider_id: string } | undefined;
  const providerId = dominant?.provider_id ?? '';

  const like = (prefix: string) => prefix.replace(/[%_]/g, '\\$&') + '%';
  const clauses = BACKFILL_PREFIXES.map(() => "doc_id LIKE ? ESCAPE '\\'").join(' OR ');
  const rows = db
    .prepare(
      `SELECT doc_id FROM fts_meta
       WHERE (${clauses})
       AND doc_id NOT IN (SELECT doc_id FROM embeddings WHERE provider_id = ?)`,
    )
    .all(...BACKFILL_PREFIXES.map(like), providerId) as { doc_id: string }[];

  return rows.map((r) => r.doc_id);
}

export interface BackfillReport {
  notes_embedded: number;
  notes_failed: number;
  wall_clock_min: number;
  token_cost_estimate: number;
  db_size_before_bytes: number;
  db_size_after_bytes: number;
  db_size_delta_gb: number;
  failed_doc_ids: string[];
}

/** Assembles the backfill report with field names matching spec §6.2's
 * backfill_ledger shape exactly, so the eventual bake-off assembly step can
 * consume this file without reshaping it. */
export function buildBackfillReport(input: {
  notesEmbedded: number;
  failedDocIds: string[];
  wallClockMs: number;
  tokenCostEstimate: number;
  dbSizeBeforeBytes: number;
  dbSizeAfterBytes: number;
}): BackfillReport {
  const GIB = 1_073_741_824;
  return {
    notes_embedded: input.notesEmbedded,
    notes_failed: input.failedDocIds.length,
    wall_clock_min: +(input.wallClockMs / 60_000).toFixed(2),
    token_cost_estimate: input.tokenCostEstimate,
    db_size_before_bytes: input.dbSizeBeforeBytes,
    db_size_after_bytes: input.dbSizeAfterBytes,
    db_size_delta_gb: +((input.dbSizeAfterBytes - input.dbSizeBeforeBytes) / GIB).toFixed(2),
    failed_doc_ids: input.failedDocIds,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/eval/backfill-arm-b.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add eval/state/backfill-arm-b.ts test/eval/backfill-arm-b.test.ts
git commit -m "feat(eval): Arm B backfill target selection + report assembly"
```

---

### Task 2: Backfill orchestrator (DB copy, concurrent embedding loop, real run)

**Files:**
- Modify: `eval/state/backfill-arm-b.ts` (add `main()` and the concurrency helper to the same file Task 1 created)
- Modify: `package.json` (add `eval:arm-b-backfill` script)
- Test: none new (the concurrency helper and `main()` are I/O/network-bound orchestration, consistent with this codebase's existing convention of not unit-testing the real Ollama-calling loop — see `src/jobs/handlers/embedding-index.ts`, which has no direct test either)

**Interfaces:**
- Consumes:
  - `BACKFILL_PREFIXES`, `selectBackfillTargets`, `buildBackfillReport`, `BackfillReport` from Task 1 (same file).
  - `openVariantStore(config, dbPath, opts)` from `../run/open-store.js` (existing — returns a `HybridStore`, already supports an arbitrary db path).
  - `chunkText(text, targetChars, maxChars)` from `../../src/embeddings/store.js` (existing).
  - `parseNote(raw)` from `../../src/vault/frontmatter.js` (existing — returns `{ data, body }`).
  - `loadConfig(REPO_ROOT)` from `../../src/config/loader.js` (existing).
- Produces: writes `eval/state/bakeoff-fullcov.sqlite` (the disposable Arm B copy) and `eval/results/<date>-arm-b-backfill.json` (the report). `pnpm eval:arm-b-backfill` runs it.

- [ ] **Step 1: Add the bounded-concurrency helper and `main()`**

First, add these new imports to the TOP of `eval/state/backfill-arm-b.ts`, alongside Task 1's existing `import Database from 'better-sqlite3';` line — do NOT add a second `Database` import, it is already imported:

```ts
import { copyFileSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openVariantStore } from '../run/open-store.js';
import { chunkText } from '../../src/embeddings/store.js';
import { parseNote } from '../../src/vault/frontmatter.js';
```

Then append the following to the END of `eval/state/backfill-arm-b.ts` (after the Task 1 functions):

```ts
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONCURRENCY = 6;

/** Runs `worker` over `items` with at most `limit` in flight at once. A
 * single item's rejection is caught by the caller's own try/catch inside
 * `worker` — this helper only bounds concurrency, it does not swallow
 * errors itself. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i]);
    return runNext();
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(lanes);
}

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const config = await loadConfig(REPO_ROOT);

  const liveDbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const copyDbPath = join(REPO_ROOT, 'eval', 'state', 'bakeoff-fullcov.sqlite');
  mkdirSync(join(REPO_ROOT, 'eval', 'state'), { recursive: true });

  console.log(`Copying ${liveDbPath} -> ${copyDbPath}`);
  copyFileSync(liveDbPath, copyDbPath);
  const dbSizeBeforeBytes = statSync(copyDbPath).size;

  const readonlyDb = new Database(copyDbPath, { readonly: true });
  const targets = selectBackfillTargets(readonlyDb);
  readonlyDb.close();
  console.log(`${targets.length} docs to backfill (scope: ${BACKFILL_PREFIXES.join(', ')})`);

  const store = openVariantStore(config, copyDbPath, {});
  const failedDocIds: string[] = [];
  let tokenCostEstimate = 0;
  let processed = 0;
  const startMs = Date.now();

  await runWithConcurrency(targets, CONCURRENCY, async (path) => {
    try {
      const raw = readFileSync(join(config.vaultPath, path), 'utf8');
      const { data, body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const chunks = chunkText(body, 1200, 4000);
      const title = typeof fm.title === 'string' && fm.title.length > 0 ? fm.title : path;

      tokenCostEstimate += Math.ceil(body.length / 4);

      await store.upsertDoc(
        path,
        title,
        body,
        chunks.map((c) => ({
          doc_id: path,
          chunk_index: c.index,
          chunk_hash: c.hash,
          text: c.text,
          metadata: {
            type: typeof fm.type === 'string' ? fm.type : 'unknown',
            title,
          },
        })),
      );
    } catch (err) {
      console.error(`Failed to backfill ${path}: ${err instanceof Error ? err.message : String(err)}`);
      failedDocIds.push(path);
    } finally {
      processed += 1;
      if (processed % 500 === 0) {
        const elapsedSec = (Date.now() - startMs) / 1000;
        console.log(`${processed}/${targets.length} processed, ${elapsedSec.toFixed(0)}s elapsed, ${(processed / elapsedSec).toFixed(1)}/s`);
      }
    }
  });

  store.close();
  const wallClockMs = Date.now() - startMs;
  const dbSizeAfterBytes = statSync(copyDbPath).size;

  const report = buildBackfillReport({
    notesEmbedded: targets.length - failedDocIds.length,
    failedDocIds,
    wallClockMs,
    tokenCostEstimate,
    dbSizeBeforeBytes,
    dbSizeAfterBytes,
  });

  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(REPO_ROOT, 'eval', 'results', `${date}-arm-b-backfill.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote eval/results/${date}-arm-b-backfill.json`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith('backfill-arm-b.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add the `eval:arm-b-backfill` package.json script**

In `package.json`, in the `"scripts"` block, add this line immediately after the existing `"eval:score"` line:

```json
    "eval:arm-b-backfill": "tsx eval/state/backfill-arm-b.ts",
```

- [ ] **Step 3: Confirm Ollama is up before the real run**

Run: `curl -s http://localhost:11434/api/tags | head -c 200`
Expected: JSON containing `"nomic-embed-text"`. If this fails, stop and report — do not proceed to Step 4 against a down provider (every doc would fail and land in `failed_doc_ids`).

- [ ] **Step 4: Run the real backfill against live data**

Run: `pnpm eval:arm-b-backfill`
Expected: progress lines every 500 docs, then the final report printed and written to `eval/results/<date>-arm-b-backfill.json`. Expect roughly ~12,000 `notes_embedded`, `notes_failed` small (ideally 0, but a handful is acceptable — this project's established "log and don't guess" bar, matching Phase 2's precedent of ~4/73 acceptable failures at a very different scale), `wall_clock_min` roughly in the 10-30 minute range per the spec's throughput estimate. This step can run in the foreground and block — the estimated real runtime is well under this tool's timeout ceiling.

- [ ] **Step 5: Verify the disposable copy actually gained embeddings**

Run:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('eval/state/bakeoff-fullcov.sqlite', { readonly: true });
const before = require('fs').readFileSync(require('fs').readdirSync('eval/results').filter(f => f.endsWith('-arm-b-backfill.json')).sort().pop() && ('eval/results/' + require('fs').readdirSync('eval/results').filter(f => f.endsWith('-arm-b-backfill.json')).sort().pop()), 'utf8');
console.log('report:', before);
console.log('embeddings row count:', db.prepare('SELECT COUNT(*) c FROM embeddings').get());
"
```
Expected: `embeddings row count` is substantially higher than before the run (was 7,851 distinct docs live as of 2026-07-13 — after this run the copy should show roughly `7,851 + notes_embedded` distinct docs, since the copy started as a snapshot of the live DB).

- [ ] **Step 6: Confirm production was not touched**

Run:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('.karpathy/state/embeddings.sqlite', { readonly: true });
console.log('live embeddings row count (must be unchanged from before this task):', db.prepare('SELECT COUNT(DISTINCT doc_id) c FROM embeddings').get());
"
```
Expected: matches the pre-task count (7,851 distinct docs) — confirms the backfill only touched the disposable copy.

- [ ] **Step 7: Confirm `eval/state/` is gitignored (the copy must never be committed — it's large and disposable)**

Run: `git check-ignore -q eval/state/bakeoff-fullcov.sqlite && echo "ignored: yes" || echo "ignored: no — MUST fix .gitignore before continuing"`
If not ignored: add `eval/state/*.sqlite` to `.gitignore`, commit that change, then verify again.

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: all pre-existing tests pass, plus the 7 new tests from Task 1 (should be 795 + 7 = 802, given the 795 baseline after Phase 3's clean re-score).

- [ ] **Step 9: Commit**

```bash
git add eval/state/backfill-arm-b.ts package.json eval/results/*-arm-b-backfill.json
git commit -m "feat(eval): Arm B embedding backfill orchestrator — pnpm eval:arm-b-backfill"
```

Note: do NOT `git add eval/state/bakeoff-fullcov.sqlite` — it's the disposable copy, gitignored by design (Step 7).

---

## Post-plan note for the next plan

This plan produces the disposable full-coverage-hybrid index and its cost
report, but does not run the actual bake-off (Track B spec §4.3-§4.7: the
variant runner needs a third `Variant` entry for `full-cov-hybrid` pointed
at `eval/state/bakeoff-fullcov.sqlite`, and the weighted-scorecard assembly
in §4.5/§6.2 needs to be built). That is the next item in the ROADMAP's
"still unbuilt" list, not part of this plan's scope.
