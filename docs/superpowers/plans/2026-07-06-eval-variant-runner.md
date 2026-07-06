# Eval Variant Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pluggable variant runner (Track A Phase 1) that executes the eval query set against multiple retrieval "arms" and captures per-query returned results, latency, tokens, and search mode — the shared instrument for both the eval and the Track B architecture bake-off.

**Architecture:** A `Variant` describes how to open a configured `HybridStore` (grep-first = keyword-only, as-deployed = hybrid as it runs today). The runner iterates the eval set × variants, calls `store.search()` read-only against the live SQLite index, and writes normalized `RunResult`s to JSON. Accuracy scoring is deliberately out of scope here — it needs pooled ground truth (a later plan); this plan captures the raw retrieval behavior those scores will be computed from.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `tsx` runner, `better-sqlite3`, `vitest`. Reuses `src/search/hybrid-store.ts`, `src/search/factory.ts` primitives, `src/config/loader.ts`.

## Global Constraints

- ESM with `.js` import extensions on all relative imports (project convention; verbatim, e.g. `import { x } from '../../src/foo.js'`).
- Tests MUST live under `test/**/*.test.ts` (vitest `include: ['test/**/*.test.ts']`).
- The runner performs NO index writes. It may open the DB read-write (schema init needs it) but must never call `upsertDoc`/`deleteDoc`/`syncFTS`, and must assert the index is unchanged via a start/end snapshot (fts_meta count + max `indexed_at`).
- Force keyword-only mode via `createHybridStore({ ..., isProviderAvailable: async () => false })` (documented switch, `hybrid-store.ts:92`).
- `doc_id` === vault-relative path (identity, no hash) — the returned hit's `docId` is directly comparable to eval `expected_notes`.
- Never mutate production: this plan's variants (grep-first, as-deployed) read the live DB; the full-coverage-hybrid arm (needs an embedded copy) is a SEPARATE later plan.
- Skip eval items whose query starts with `<ABSENT-STUB` (unfilled author stubs).

---

### Task 1: Shared types + token/char measurement

**Files:**
- Create: `eval/run/types.ts`
- Create: `eval/score/tokens.ts`
- Test: `test/eval/tokens.test.ts`

**Interfaces:**
- Consumes: `HybridStore`, `HybridSearchResult` from `src/search/hybrid-store.ts`.
- Produces: types `Variant`, `VariantProfile`, `RunHit`, `RunResult`, `HarnessRun`; function `measurePayload(payload: unknown): { chars: number; tokensEst: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { measurePayload } from '../../eval/score/tokens.js';

describe('measurePayload', () => {
  it('counts exact JSON chars and estimates tokens at chars/4', () => {
    const payload = [{ path: 'a/b.md', excerpt: 'hello world' }];
    const json = JSON.stringify(payload);
    const { chars, tokensEst } = measurePayload(payload);
    expect(chars).toBe(json.length);
    expect(tokensEst).toBe(Math.ceil(json.length / 4));
  });

  it('treats null/undefined as the literal null payload', () => {
    expect(measurePayload(undefined).chars).toBe('null'.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/tokens.test.ts`
Expected: FAIL — cannot find module `../../eval/score/tokens.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/score/tokens.ts
/** Exact serialized-char length + a tokenizer-free token estimate (chars/4).
 * chars is the primary comparable metric (mirrors the usage log's result_chars);
 * tokensEst is a consistent relative proxy — swap in a real tokenizer if needed. */
export function measurePayload(payload: unknown): { chars: number; tokensEst: number } {
  const chars = JSON.stringify(payload ?? null).length;
  return { chars, tokensEst: Math.ceil(chars / 4) };
}
```

```ts
// eval/run/types.ts
import type { HybridStore } from '../../src/search/hybrid-store.js';

/** Static facts feeding the Track B simplicity score (bake-off spec §4.6). */
export interface VariantProfile {
  runtimeDeps: string[];            // e.g. ['ollama'] or []
  storageGbBeyondFts: number;       // GB of embeddings/index beyond plain FTS
  maintenanceJobs: string[];        // background jobs required to stay correct
  silentDegradationModes: string[]; // ways retrieval silently degrades
  codeSurface: 'low' | 'medium' | 'high';
}

export interface Variant {
  name: string;
  keywordOnly: boolean;
  topK: number;
  openStore: () => HybridStore;
  profile: VariantProfile;
}

export interface RunHit {
  path: string;   // = HybridHit.docId (vault-relative path)
  rank: number;   // 0-indexed position in the returned list
  final: number;  // HybridHit.scores.final
  excerpt: string;
  semanticSim?: number; // present if the semantic pool matched this hit
  keywordRank?: number; // present if the keyword pool matched this hit
}

export interface RunResult {
  itemId: string;
  variant: string;
  query: string;
  returned: RunHit[];
  searchMode: 'hybrid' | 'keyword-only';
  degradationNote?: string;
  latencyMs: number;       // warm median over repeated calls
  responseChars: number;
  responseTokensEst: number;
  error?: string;          // set if the search threw (item scored as a miss later)
}

export interface HarnessRun {
  generatedAt: string;
  dbSnapshot: { docCount: number; newestIndexedAt: string };
  variants: string[];
  k: number;
  itemCount: number;
  results: RunResult[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/tokens.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/run/types.ts eval/score/tokens.ts test/eval/tokens.test.ts
git commit -m "feat(eval): shared runner types + payload measurement"
```

---

### Task 2: Open a variant store (keyword-only vs hybrid)

**Files:**
- Create: `eval/run/open-store.ts`
- Test: `test/eval/open-store.test.ts`

**Interfaces:**
- Consumes: `createProviderFromConfig` (`src/embeddings/factory.ts`), `openEmbeddingStore` (`src/embeddings/store.ts`), `openFTSIndex` (`src/search/fts-index.ts`), `createHybridStore` (`src/search/hybrid-store.ts`), `KarpathyConfig` (`src/config/schema.ts`).
- Produces: `openVariantStore(config: KarpathyConfig, dbPath: string, opts?: { keywordOnly?: boolean }): HybridStore`.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/open-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';

describe('openVariantStore', () => {
  let dir: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-openstore-'));
    // deterministic provider = no Ollama; always "hybrid" when not keywordOnly
    config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana\n---\nyellow banana harness fruit');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('keyword-only variant returns keyword-only search mode', async () => {
    const store = openVariantStore(config, join(dir, 'idx.sqlite'), { keywordOnly: true });
    try {
      await store.syncFTS(['wiki']); // seed the FTS index for the test only
      const res = await store.search('banana', { topK: 5 });
      expect(res.searchMode).toBe('keyword-only');
      expect(res.hits.map((h) => h.docId)).toContain('wiki/banana.md');
    } finally { store.close(); }
  });

  it('hybrid variant (deterministic provider) reports hybrid mode', async () => {
    const store = openVariantStore(config, join(dir, 'idx2.sqlite'), {});
    try {
      await store.syncFTS(['wiki']);
      const res = await store.search('banana', { topK: 5 });
      expect(res.searchMode).toBe('hybrid');
    } finally { store.close(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/open-store.test.ts`
Expected: FAIL — cannot find module `../../eval/run/open-store.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/run/open-store.ts
import Database from 'better-sqlite3';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { createProviderFromConfig } from '../../src/embeddings/factory.js';
import { openEmbeddingStore } from '../../src/embeddings/store.js';
import { openFTSIndex } from '../../src/search/fts-index.js';
import { createHybridStore, type HybridStore } from '../../src/search/hybrid-store.js';

/** Open a HybridStore at an explicit db path, optionally forcing keyword-only.
 * Mirrors src/search/factory.ts but exposes the db path + provider probe so the
 * harness can run different arms against different index files. */
export function openVariantStore(
  config: KarpathyConfig,
  dbPath: string,
  opts: { keywordOnly?: boolean } = {},
): HybridStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  const provider = createProviderFromConfig(config);
  const embeddings = openEmbeddingStore({ db, provider });
  const fts = openFTSIndex(db, { vaultRoot: config.vaultPath });
  const isProviderAvailable = opts.keywordOnly ? async () => false : undefined;
  const store = createHybridStore({ config, db, fts, embeddings, isProviderAvailable });
  const origClose = store.close.bind(store);
  store.close = () => { origClose(); db.close(); };
  return store;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/open-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/run/open-store.ts test/eval/open-store.test.ts
git commit -m "feat(eval): openVariantStore with keyword-only switch"
```

---

### Task 3: Normalize hybrid hits to RunHit

**Files:**
- Create: `eval/run/normalize.ts`
- Test: `test/eval/normalize.test.ts`

**Interfaces:**
- Consumes: `HybridSearchResult` (`src/search/hybrid-store.ts`), `RunHit` (`eval/run/types.ts`).
- Produces: `toRunHits(result: HybridSearchResult, topK: number): RunHit[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { toRunHits } from '../../eval/run/normalize.js';
import type { HybridSearchResult } from '../../src/search/hybrid-store.js';

describe('toRunHits', () => {
  it('maps docId->path, assigns 0-indexed rank, carries scores, truncates to topK', () => {
    const result: HybridSearchResult = {
      searchMode: 'hybrid',
      hits: [
        { docId: 'a.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'A',
          scores: { rrf: 0.1, recency: 0.5, final: 0.42, semanticSim: 0.7, keywordRank: 2 } },
        { docId: 'b.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'B',
          scores: { rrf: 0.05, recency: 0.1, final: 0.2 } },
        { docId: 'c.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'C',
          scores: { rrf: 0.01, recency: 0, final: 0.05 } },
      ],
    };
    const hits = toRunHits(result, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ path: 'a.md', rank: 0, final: 0.42, excerpt: 'A', semanticSim: 0.7, keywordRank: 2 });
    expect(hits[1]).toMatchObject({ path: 'b.md', rank: 1, final: 0.2 });
    expect(hits[1].semanticSim).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/normalize.test.ts`
Expected: FAIL — cannot find module `../../eval/run/normalize.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/run/normalize.ts
import type { HybridSearchResult } from '../../src/search/hybrid-store.js';
import type { RunHit } from './types.js';

export function toRunHits(result: HybridSearchResult, topK: number): RunHit[] {
  return result.hits.slice(0, topK).map((h, i) => ({
    path: h.docId,
    rank: i,
    final: h.scores.final,
    excerpt: h.excerpt,
    semanticSim: h.scores.semanticSim,
    keywordRank: h.scores.keywordRank,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/run/normalize.ts test/eval/normalize.test.ts
git commit -m "feat(eval): normalize hybrid hits to RunHit"
```

---

### Task 4: Variant definitions (grep-first + as-deployed)

**Files:**
- Create: `eval/run/variants.ts`
- Test: `test/eval/variants.test.ts`

**Interfaces:**
- Consumes: `openVariantStore` (`eval/run/open-store.ts`), `KarpathyConfig`, `Variant`/`VariantProfile` (`eval/run/types.ts`).
- Produces: `buildVariants(config: KarpathyConfig, projectRoot: string, topK?: number): Variant[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/variants.test.ts
import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { buildVariants } from '../../eval/run/variants.js';

describe('buildVariants', () => {
  it('defines grep-first (keyword-only, no deps) and as-deployed (hybrid, ollama dep)', () => {
    // profiles are static (independent of config.embeddings.provider), so a
    // deterministic-provider config is enough to verify wiring without Ollama.
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/v', embeddings: { provider: 'deterministic' } });
    const variants = buildVariants(config, '/tmp/root', 10);
    const byName = Object.fromEntries(variants.map((v) => [v.name, v]));

    expect(Object.keys(byName).sort()).toEqual(['as-deployed', 'grep-first']);
    expect(byName['grep-first'].keywordOnly).toBe(true);
    expect(byName['grep-first'].profile.runtimeDeps).toEqual([]);
    expect(byName['as-deployed'].keywordOnly).toBe(false);
    expect(byName['as-deployed'].profile.runtimeDeps).toContain('ollama');
    expect(byName['grep-first'].topK).toBe(10);
    expect(typeof byName['grep-first'].openStore).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/variants.test.ts`
Expected: FAIL — cannot find module `../../eval/run/variants.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/run/variants.ts
import { join } from 'node:path';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from './open-store.js';
import type { Variant } from './types.js';

/** The Phase-1 arms. grep-first + as-deployed both read the LIVE index; the
 * full-coverage-hybrid arm (needs an embedded copy) is added by a later plan. */
export function buildVariants(config: KarpathyConfig, projectRoot: string, topK = 10): Variant[] {
  const liveDb = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  return [
    {
      name: 'grep-first',
      keywordOnly: true,
      topK,
      openStore: () => openVariantStore(config, liveDb, { keywordOnly: true }),
      profile: {
        runtimeDeps: [],
        storageGbBeyondFts: 0,
        maintenanceJobs: [],
        silentDegradationModes: [],
        codeSurface: 'low',
      },
    },
    {
      name: 'as-deployed',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, liveDb, {}),
      profile: {
        runtimeDeps: ['ollama'],
        storageGbBeyondFts: 1,
        maintenanceJobs: ['embedding-index', 'embedding-sync'],
        silentDegradationModes: ['provider-down->keyword-only'],
        codeSurface: 'high',
      },
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/variants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/run/variants.ts test/eval/variants.test.ts
git commit -m "feat(eval): grep-first + as-deployed variant definitions"
```

---

### Task 5: Run harness + eval:run script + real smoke run

**Files:**
- Create: `eval/run/run-harness.ts`
- Modify: `package.json` (add `eval:run` script)
- Test: `test/eval/run-harness.test.ts`

**Interfaces:**
- Consumes: `buildVariants`, `openVariantStore`, `toRunHits`, `measurePayload`, `loadConfig` (`src/config/loader.ts`), types from `eval/run/types.ts`.
- Produces: `executeRun(items, variants, dbPath): Promise<RunResult[]>` and `runHarness(): Promise<HarnessRun>` (CLI entry).

- [ ] **Step 1: Write the failing test**

```ts
// test/eval/run-harness.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { openVariantStore } from '../../eval/run/open-store.js';
import { executeRun } from '../../eval/run/run-harness.js';
import type { Variant } from '../../eval/run/types.js';

describe('executeRun', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-run-'));
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, embeddings: { provider: 'deterministic' } });
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'banana.md'), '---\ntitle: Banana\n---\nyellow banana harness');
    // seed the index once
    const seed = openVariantStore(config, join(dir, 'idx.sqlite'), {});
    try { await seed.syncFTS(['wiki']); } finally { seed.close(); }
    (globalThis as any).__cfg = config;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('runs each item x variant, captures hits/latency/tokens, and guards read-only', async () => {
    const config = (globalThis as any).__cfg;
    const dbPath = join(dir, 'idx.sqlite');
    const variants: Variant[] = [
      { name: 'grep-first', keywordOnly: true, topK: 5,
        openStore: () => openVariantStore(config, dbPath, { keywordOnly: true }),
        profile: { runtimeDeps: [], storageGbBeyondFts: 0, maintenanceJobs: [], silentDegradationModes: [], codeSurface: 'low' } },
    ];
    const items = [{ id: 'x-001', query: 'banana' }, { id: 'x-002', query: '<ABSENT-STUB skip me>' }];
    const results = await executeRun(items, variants, dbPath);

    expect(results).toHaveLength(1); // absent-stub skipped
    const r = results[0];
    expect(r.itemId).toBe('x-001');
    expect(r.variant).toBe('grep-first');
    expect(r.searchMode).toBe('keyword-only');
    expect(r.returned.map((h) => h.path)).toContain('wiki/banana.md');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.responseChars).toBeGreaterThan(0);
    expect(r.responseTokensEst).toBe(Math.ceil(r.responseChars / 4));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/run-harness.test.ts`
Expected: FAIL — cannot find module `../../eval/run/run-harness.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// eval/run/run-harness.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/config/loader.js';
import { buildVariants } from './variants.js';
import { toRunHits } from './normalize.js';
import { measurePayload } from '../score/tokens.js';
import type { RunResult, HarnessRun, Variant } from './types.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function snapshot(dbPath: string): { docCount: number; newestIndexedAt: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m FROM fts_meta').get() as { c: number; m: string };
    return { docCount: row.c, newestIndexedAt: row.m ?? '' };
  } finally { db.close(); }
}

/** Core loop: run every non-stub item through every variant (warm-median latency
 * over 3 calls), capturing normalized hits + token/char cost. Read-only: throws
 * if the index changed between start and end. */
export async function executeRun(
  items: { id: string; query: string }[],
  variants: Variant[],
  dbPath: string,
): Promise<RunResult[]> {
  const before = snapshot(dbPath);
  const results: RunResult[] = [];
  for (const variant of variants) {
    const store = variant.openStore();
    try {
      for (const item of items) {
        if (item.query.startsWith('<ABSENT-STUB')) continue;
        const lat: number[] = [];
        try {
          let res!: Awaited<ReturnType<typeof store.search>>;
          for (let i = 0; i < 3; i++) {
            const t = performance.now();
            res = await store.search(item.query, { topK: variant.topK });
            lat.push(performance.now() - t);
          }
          const returned = toRunHits(res, variant.topK);
          const { chars, tokensEst } = measurePayload(returned);
          results.push({
            itemId: item.id, variant: variant.name, query: item.query, returned,
            searchMode: res.searchMode, degradationNote: res.degradationNote,
            latencyMs: median(lat), responseChars: chars, responseTokensEst: tokensEst,
          });
        } catch (err) {
          results.push({
            itemId: item.id, variant: variant.name, query: item.query, returned: [],
            searchMode: 'keyword-only', latencyMs: 0, responseChars: 0, responseTokensEst: 0,
            error: (err as Error).message,
          });
        }
      }
    } finally { store.close(); }
  }
  const after = snapshot(dbPath);
  if (after.docCount !== before.docCount || after.newestIndexedAt !== before.newestIndexedAt) {
    throw new Error(`Index changed during run (read-only violated): before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  return results;
}

export async function runHarness(): Promise<HarnessRun> {
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const items = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8')) as { id: string; query: string }[];
  const variants = buildVariants(config, REPO_ROOT);
  const results = await executeRun(items, variants, dbPath);
  const run: HarnessRun = {
    generatedAt: new Date().toISOString(),
    dbSnapshot: snapshot(dbPath),
    variants: variants.map((v) => v.name),
    k: variants[0]?.topK ?? 10,
    itemCount: items.length,
    results,
  };
  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outDir, `${date}-runs.json`), JSON.stringify(run, null, 2));
  return run;
}

// CLI entry (tsx): run when invoked directly, not when imported by tests.
if (process.argv[1]?.endsWith('run-harness.ts')) {
  runHarness()
    .then((r) => console.log(`Ran ${r.results.length} (item×variant) results across [${r.variants.join(', ')}]; wrote eval/results/${r.generatedAt.slice(0, 10)}-runs.json`))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/run-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the eval:run script**

Modify `package.json` scripts (after the existing `eval:mine` line):

```json
"eval:run": "tsx eval/run/run-harness.ts",
```

- [ ] **Step 6: Run the full eval test suite + a real smoke run**

Run: `npx vitest run test/eval/`
Expected: PASS (all Task 1–5 tests).

Run: `pnpm eval:run`
Expected: writes `eval/results/<date>-runs.json`; prints the count line. Sanity-check the output:

```bash
npx tsx -e "import {readFileSync} from 'node:fs'; const p='./eval/results/'+new Date().toISOString().slice(0,10)+'-runs.json'; const r=JSON.parse(readFileSync(p,'utf8')); const g=r.results.filter(x=>x.variant==='grep-first'); const d=r.results.filter(x=>x.variant==='as-deployed'); const med=a=>{const s=a.map(x=>x.latencyMs).sort((p,q)=>p-q);return s[Math.floor(s.length/2)]??0}; console.log('grep-first: n='+g.length+' medLatency='+med(g).toFixed(1)+'ms  as-deployed: n='+d.length+' medLatency='+med(d).toFixed(1)+'ms'); console.log('as-deployed searchModes:', JSON.stringify(d.reduce((m,x)=>{m[x.searchMode]=(m[x.searchMode]||0)+1;return m},{})));"
```
Expected: both variants ran over the 74-item set (minus the absent stub); latency and searchMode distribution print. (as-deployed will show `hybrid` when Ollama is up; if it shows all `keyword-only`, Ollama is down — note it, results still valid as a keyword-only reference.)

- [ ] **Step 7: Commit**

```bash
git add eval/run/run-harness.ts test/eval/run-harness.test.ts package.json
git commit -m "feat(eval): variant run harness + eval:run script"
```

- [ ] **Step 8: Update the roadmap**

In `docs/superpowers/ROADMAP.md`, mark Track A Phase 1 status ✅ DONE (variant runner shipped) and update "You are here" to point at the next plan (pooling + judge). Commit:

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs: mark Track A Phase 1 (variant runner) done"
```

---

## Notes for the next plan (out of scope here)
- **Pooling + LLM judge + calibration gate** (Track A Phase 2): builds `pool.json`/`judgments.json` from these runs + the behavioral signal + a keyword sweep; also triages the 74-item draft set's categories.
- **Full-coverage-hybrid arm** (Track B §4.2): backfill embeddings into `eval/state/bakeoff-fullcov.sqlite`, add a third variant pointing at it.
- **Scoring + simplicity + composite verdict** (Track B §4.5): consumes RunResults + judgments to produce the bake-off scorecard.
