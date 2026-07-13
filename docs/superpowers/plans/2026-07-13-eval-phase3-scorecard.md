# Eval Phase 3 — Scoring/Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute recall/precision/MRR (full-corpus and scope-matched, k=10 and k=5, against both `E` and `E_primary`) from the existing `eval/results/2026-07-06-runs.json` + `eval/dataset/judgments.json`, with bootstrap 95% CIs, and assemble the final `eval/results/<date>-scorecard.json` per spec §11.4.

**Architecture:** Three new pure/stateless modules (`metrics.ts`, `bootstrap.ts`, `scope.ts`) compute the statistics; a fourth module (`build-scorecard.ts`) exports a pure `buildScorecard()` function that joins the already-loaded data and produces the scorecard object, plus a thin `main()` that does the file I/O and is skipped by the test suite (mirrors the existing `judgeItemFull`/`main()` split in `eval/pool/judge-full.ts`).

**Tech Stack:** TypeScript ESM (`.js` import extensions on relative imports), vitest, no new dependencies.

## Global Constraints

- Data sources are already confirmed compatible — do not re-run `eval:run` or `eval:judge-full`. Read `eval/results/2026-07-06-runs.json`, `eval/dataset/judgments.json`, `eval/dataset/queries.json`, `eval/results/routing-analysis.json`, `eval/results/coverage-funnel.json` as-is.
- Every judgment in `judgments.json` is trusted ground truth regardless of `label_provenance` (`'llm'` or `'behavioral'`) — do not filter by provenance (spec addendum §19).
- `E` = doc_ids with `label >= 1`; `E_primary` = doc_ids with `label === 2` (spec §8.2).
- Compute both `k=10` and `k=5`, both `E` and `E_primary`, both `full-corpus` and `scope-matched` scope — 8 metric cells per (category, variant) group (spec §19, confirmed in scope).
- Scope-matched prefixes (spec §7.6, resolved in addendum §19): exactly `'Curated/wiki'`, `'AI Conversations/_summaries'`, `'Curated/sources'`, `'Curated/review'` — a path is in scope if it starts with any of these 4 strings.
- Bootstrap CI: 1000 resamples, seeded PRNG for determinism (spec §14).
- `recallAtK` returns `null` (excluded from aggregation) when `|E| = 0` — never a silent 0 (spec §7.1, §15).
- A `RunResult` with `.error` set scores as a total miss (empty `returned`), not skipped (spec §15).
- `routing` and `coverage` sections of the scorecard are the existing `routing-analysis.json`'s `.routing` key and the existing `coverage-funnel.json` object, embedded verbatim — do not recompute or reshape them.
- All new files use `.js` extensions on relative imports (this codebase's ESM convention) even though the source files are `.ts`.

---

### Task 1: Metric primitives + scope restriction

**Files:**
- Create: `eval/score/metrics.ts`
- Create: `eval/score/scope.ts`
- Test: `test/eval/metrics.test.ts`
- Test: `test/eval/scope.test.ts`

**Interfaces:**
- Consumes: `RunHit` from `eval/run/types.ts` (already exists — fields: `path: string`, `rank: number` (0-indexed), `final: number`, `excerpt: string`, optional `semanticSim?`, `keywordRank?`).
- Produces (used by Task 3):
  - `recallAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null`
  - `precisionAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null`
  - `reciprocalRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number`
  - `firstRelevantRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null`
  - `SCOPE_MATCHED_PREFIXES: readonly string[]`
  - `restrictToScope(returned: RunHit[], relevantDocIds: Set<string>): { returned: RunHit[]; relevantDocIds: Set<string> }`

- [ ] **Step 1: Write the failing tests for `metrics.ts`**

Create `test/eval/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { recallAtK, precisionAtK, reciprocalRank, firstRelevantRank } from '../../eval/score/metrics.js';
import type { RunHit } from '../../eval/run/types.js';

function hit(path: string, rank: number): RunHit {
  return { path, rank, final: 1 - rank * 0.1, excerpt: '' };
}

describe('recallAtK', () => {
  it('computes |E ∩ R_k| / |E|', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['a.md', 'c.md', 'd.md']);
    expect(recallAtK(returned, relevant, 10)).toBeCloseTo(2 / 3);
  });

  it('returns null when E is empty (undefined per spec §7.1, not a silent 0)', () => {
    expect(recallAtK([hit('a.md', 0)], new Set(), 10)).toBeNull();
  });

  it('respects the k cutoff', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1)];
    const relevant = new Set(['b.md']);
    expect(recallAtK(returned, relevant, 1)).toBe(0);
    expect(recallAtK(returned, relevant, 2)).toBe(1);
  });
});

describe('precisionAtK', () => {
  it('computes |E ∩ R_k| / |R_k|', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['a.md']);
    expect(precisionAtK(returned, relevant, 3)).toBeCloseTo(1 / 3);
  });

  it('returns null when nothing was returned (nothing to score)', () => {
    expect(precisionAtK([], new Set(['a.md']), 10)).toBeNull();
  });
});

describe('reciprocalRank', () => {
  it('is 1/(rank+1) for the first relevant hit (rank is 0-indexed)', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['c.md']);
    expect(reciprocalRank(returned, relevant, 10)).toBeCloseTo(1 / 3);
  });

  it('is 0 when nothing relevant is in the top-k (per spec §7.3)', () => {
    const returned = [hit('a.md', 0)];
    expect(reciprocalRank(returned, new Set(['zzz.md']), 10)).toBe(0);
  });
});

describe('firstRelevantRank', () => {
  it('returns the 1-indexed rank of the first relevant hit', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    expect(firstRelevantRank(returned, new Set(['c.md']), 10)).toBe(3);
  });

  it('returns null when none found', () => {
    expect(firstRelevantRank([hit('a.md', 0)], new Set(['zzz.md']), 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the metrics tests to verify they fail**

Run: `npx vitest run test/eval/metrics.test.ts`
Expected: FAIL — `eval/score/metrics.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement `metrics.ts`**

Create `eval/score/metrics.ts`:

```ts
import type { RunHit } from '../run/types.js';

/** recall@k = |E ∩ R_k| / |E| (spec §7.1). `returned` is trusted to already
 * be rank-ordered (the harness's stable sort, spec §12/§15) — this function
 * slices, it does not re-sort. Returns null when |E| = 0: recall is
 * undefined against an empty relevant set, not a silent 0 (spec §7.1, §15). */
export function recallAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  if (relevantDocIds.size === 0) return null;
  const topK = returned.slice(0, k);
  const hits = topK.filter((h) => relevantDocIds.has(h.path)).length;
  return hits / relevantDocIds.size;
}

/** precision@k = |E ∩ R_k| / |R_k| (spec §7.2). Returns null when nothing
 * was returned — there is nothing to score precision against. */
export function precisionAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  const topK = returned.slice(0, k);
  if (topK.length === 0) return null;
  const hits = topK.filter((h) => relevantDocIds.has(h.path)).length;
  return hits / topK.length;
}

/** RR = 1 / rank_of_first_relevant, 0 if none in top-k (spec §7.3). `rank`
 * on RunHit is 0-indexed; RR uses the 1-indexed position. */
export function reciprocalRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number {
  const topK = returned.slice(0, k);
  const firstHit = topK.find((h) => relevantDocIds.has(h.path));
  if (!firstHit) return 0;
  return 1 / (firstHit.rank + 1);
}

/** The 1-indexed rank of the first relevant hit in the top-k, or null if
 * none found. Used to compute the aggregate's median_first_rank (spec §7.3
 * reports median rank alongside mean RR). */
export function firstRelevantRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  const topK = returned.slice(0, k);
  const firstHit = topK.find((h) => relevantDocIds.has(h.path));
  return firstHit ? firstHit.rank + 1 : null;
}
```

- [ ] **Step 4: Run the metrics tests to verify they pass**

Run: `npx vitest run test/eval/metrics.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Write the failing tests for `scope.ts`**

Create `test/eval/scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { restrictToScope, SCOPE_MATCHED_PREFIXES } from '../../eval/score/scope.js';
import type { RunHit } from '../../eval/run/types.js';

function hit(path: string): RunHit {
  return { path, rank: 0, final: 1, excerpt: '' };
}

describe('SCOPE_MATCHED_PREFIXES', () => {
  it('is the exact 4-folder list search-vault.ts scans by default (spec §7.6/§19)', () => {
    expect(SCOPE_MATCHED_PREFIXES).toEqual([
      'Curated/wiki',
      'AI Conversations/_summaries',
      'Curated/sources',
      'Curated/review',
    ]);
  });
});

describe('restrictToScope', () => {
  it('keeps only returned hits under the 4 scope-matched prefixes', () => {
    const returned = [hit('Curated/wiki/foo.md'), hit('Plaud/bar.md'), hit('Curated/sources/baz.md')];
    const relevant = new Set(['Curated/wiki/foo.md', 'Plaud/bar.md']);
    const restricted = restrictToScope(returned, relevant);
    expect(restricted.returned.map((h) => h.path)).toEqual(['Curated/wiki/foo.md', 'Curated/sources/baz.md']);
  });

  it('keeps only relevant doc_ids under the 4 scope-matched prefixes', () => {
    const relevant = new Set(['Curated/wiki/foo.md', 'Plaud/bar.md', 'Curated/review/baz.md']);
    const restricted = restrictToScope([], relevant);
    expect(restricted.relevantDocIds).toEqual(new Set(['Curated/wiki/foo.md', 'Curated/review/baz.md']));
  });

  it('is a prefix match, not exact-equality — a path just under the folder still counts', () => {
    const returned = [hit('Curated/sources/deep/nested/note.md')];
    const restricted = restrictToScope(returned, new Set());
    expect(restricted.returned).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run the scope tests to verify they fail**

Run: `npx vitest run test/eval/scope.test.ts`
Expected: FAIL — `eval/score/scope.ts` does not exist yet.

- [ ] **Step 7: Implement `scope.ts`**

Create `eval/score/scope.ts`:

```ts
import type { RunHit } from '../run/types.js';

/** The 4 folders `search_vault`'s default scan covers — resolved concretely
 * from `src/mcp/tools/search-vault.ts`'s `folders = [layout.wiki,
 * layout.aiSummaries, layout.sources, layout.review]` against the live
 * global config (spec §7.6, addendum §19). Used to compute the
 * scope-matched metric variant, isolating "hybrid wins by indexing more"
 * from "hybrid ranks better" (spec §7.6). */
export const SCOPE_MATCHED_PREFIXES = [
  'Curated/wiki',
  'AI Conversations/_summaries',
  'Curated/sources',
  'Curated/review',
] as const;

function inScope(path: string): boolean {
  return SCOPE_MATCHED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Restrict both the returned hit list and the relevant-doc-id set to paths
 * under the 4 scope-matched prefixes (spec §7.6). Both sides are filtered
 * together so recall/precision/MRR computed on the result are a fair
 * apples-to-apples comparison scoped to what search_vault can see at all. */
export function restrictToScope(
  returned: RunHit[],
  relevantDocIds: Set<string>,
): { returned: RunHit[]; relevantDocIds: Set<string> } {
  return {
    returned: returned.filter((h) => inScope(h.path)),
    relevantDocIds: new Set([...relevantDocIds].filter((id) => inScope(id))),
  };
}
```

- [ ] **Step 8: Run the scope tests to verify they pass**

Run: `npx vitest run test/eval/scope.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add eval/score/metrics.ts eval/score/scope.ts test/eval/metrics.test.ts test/eval/scope.test.ts
git commit -m "feat(eval): Phase 3 metric primitives — recall/precision/MRR + scope-matched restriction"
```

---

### Task 2: Bootstrap confidence intervals

**Files:**
- Create: `eval/score/bootstrap.ts`
- Test: `test/eval/bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (pure statistical primitive, independent of the metric functions).
- Produces (used by Task 3): `bootstrapCI(values: number[], resamples?: number, seed?: number): [number, number]`

- [ ] **Step 1: Write the failing tests**

Create `test/eval/bootstrap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bootstrapCI } from '../../eval/score/bootstrap.js';

describe('bootstrapCI', () => {
  it('returns [0, 0] for no data', () => {
    expect(bootstrapCI([])).toEqual([0, 0]);
  });

  it('returns [value, value] for a single data point (nothing to resample)', () => {
    expect(bootstrapCI([0.7])).toEqual([0.7, 0.7]);
  });

  it('is deterministic for the same seed', () => {
    const values = [0.2, 0.4, 0.6, 0.8, 1.0];
    const a = bootstrapCI(values, 1000, 42);
    const b = bootstrapCI(values, 1000, 42);
    expect(a).toEqual(b);
  });

  it('produces a different CI for a different seed (confirms the seed is actually used)', () => {
    const values = [0.1, 0.3, 0.9, 0.2, 0.7, 0.4];
    const a = bootstrapCI(values, 1000, 1);
    const b = bootstrapCI(values, 1000, 2);
    expect(a).not.toEqual(b);
  });

  it('collapses to a tight range around the constant when all values are equal', () => {
    const [lo, hi] = bootstrapCI([0.5, 0.5, 0.5, 0.5], 1000, 1);
    expect(lo).toBeCloseTo(0.5);
    expect(hi).toBeCloseTo(0.5);
  });

  it('bounds the CI within the observed data range (resampling with replacement never invents values outside it)', () => {
    const values = [0.1, 0.5, 0.9];
    const [lo, hi] = bootstrapCI(values, 1000, 7);
    expect(lo).toBeGreaterThanOrEqual(0.1);
    expect(hi).toBeLessThanOrEqual(0.9);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/eval/bootstrap.test.ts`
Expected: FAIL — `eval/score/bootstrap.ts` does not exist yet.

- [ ] **Step 3: Implement `bootstrap.ts`**

Create `eval/score/bootstrap.ts`:

```ts
/** Deterministic PRNG (mulberry32) so bootstrap resampling is reproducible
 * across runs given the same seed — required for a reproducible, testable
 * scorecard (spec §14). Not cryptographic; a fast, well-distributed
 * generator is all that's needed for resampling. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap 95% CI over `values` via resampling-with-replacement (spec
 * §14) — 1000 resamples by default, since categories only have 15-25 items
 * and every reported recall/precision needs an honesty check against
 * small-n noise. `seed` makes the output deterministic for the same input,
 * so scorecards are reproducible and this function is unit-testable.
 * Returns [0, 0] for no data, [value, value] for a single point (nothing to
 * resample). */
export function bootstrapCI(values: number[], resamples = 1000, seed = 42): [number, number] {
  if (values.length === 0) return [0, 0];
  if (values.length === 1) return [values[0], values[0]];

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      const idx = Math.floor(rand() * values.length);
      sum += values[idx];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);

  const lowIdx = Math.floor(0.025 * resamples);
  const highIdx = Math.min(resamples - 1, Math.floor(0.975 * resamples));
  return [means[lowIdx], means[highIdx]];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/eval/bootstrap.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add eval/score/bootstrap.ts test/eval/bootstrap.test.ts
git commit -m "feat(eval): Phase 3 bootstrap 95% CI (seeded, deterministic)"
```

---

### Task 3: Scorecard orchestrator

**Files:**
- Create: `eval/score/build-scorecard.ts`
- Modify: `package.json` (add `eval:score` script)
- Test: `test/eval/build-scorecard.test.ts`

**Interfaces:**
- Consumes:
  - `recallAtK`, `precisionAtK`, `reciprocalRank`, `firstRelevantRank` from `./metrics.js` (Task 1)
  - `restrictToScope` from `./scope.js` (Task 1)
  - `bootstrapCI` from `./bootstrap.js` (Task 2)
  - `RunHit`, `RunResult` from `../run/types.js` (existing)
  - `Judgment` from `../pool/judge.js` (existing — fields: `item_id: string`, `doc_id: string`, `label: number`, `label_provenance: 'llm' | 'behavioral' | 'human' | 'llm+human'`)
  - `EvalItem` from `../dataset/types.js` (existing — fields include `id: string`, `category: 'plaud' | 'ai-session' | 'entities' | 'hot-topics' | 'decisions'`)
- Produces: `buildScorecard(input: ScorecardInput): Scorecard` — a pure function taking already-parsed data (no file I/O), so it is directly unit-testable with small fixtures. `main()` (file I/O only, guarded by the `process.argv[1]?.endsWith(...)` pattern already used in `eval/pool/judge-full.ts`) reads the 5 real files and calls it.

- [ ] **Step 1: Write the failing integration test**

Create `test/eval/build-scorecard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildScorecard } from '../../eval/score/build-scorecard.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';
import type { EvalItem } from '../../eval/dataset/types.js';

function item(id: string, category: EvalItem['category']): EvalItem {
  return {
    id,
    query: `query for ${id}`,
    category,
    subtype: 'lookup',
    source: 'log',
    source_ref: 'x',
    intent: '',
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  };
}

function judgment(item_id: string, doc_id: string, label: number): Judgment {
  return { item_id, doc_id, label, reason: '', label_provenance: 'llm' };
}

function runResult(itemId: string, variant: string, returned: RunResult['returned'], overrides: Partial<RunResult> = {}): RunResult {
  return {
    itemId,
    variant,
    query: `query for ${itemId}`,
    returned,
    searchMode: 'hybrid',
    latencyMs: 100,
    responseChars: 500,
    responseTokensEst: 125,
    ...overrides,
  };
}

describe('buildScorecard', () => {
  const items = [item('decisions-001', 'decisions'), item('decisions-002', 'decisions')];
  const judgments = [
    judgment('decisions-001', 'Curated/wiki/a.md', 2),
    judgment('decisions-001', 'Curated/wiki/b.md', 1),
    judgment('decisions-002', 'Plaud/c.md', 2),
  ];
  const results: RunResult[] = [
    runResult('decisions-001', 'as-deployed', [
      { path: 'Curated/wiki/a.md', rank: 0, final: 0.9, excerpt: '' },
      { path: 'Curated/wiki/b.md', rank: 1, final: 0.5, excerpt: '' },
    ]),
    runResult('decisions-002', 'as-deployed', [
      { path: 'Plaud/c.md', rank: 0, final: 0.8, excerpt: '' },
    ]),
  ];
  const routingAnalysis = { routing: { overall_fast_pct: 10.3, overall: { correct: 19, total: 184 }, by_month: {} } };
  const coverageFunnel = { generated_at: 'x', totals: {}, funnel: [] };

  it('groups by (category, variant) and computes all 8 metric cells', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });

    expect(scorecard.by_category_variant).toHaveLength(1);
    const group = scorecard.by_category_variant[0];
    expect(group.category).toBe('decisions');
    expect(group.variant).toBe('as-deployed');
    expect(group.n_items).toBe(2);
    expect(group.cells).toHaveLength(8);
  });

  it('computes recall@10 against E (label>=1) correctly for the full-corpus scope', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus',
    )!;
    // decisions-001: E={a.md,b.md}, both returned -> recall 1.0
    // decisions-002: E={c.md}, returned -> recall 1.0
    expect(cell.recall_at_k.mean).toBeCloseTo(1.0);
  });

  it('computes recall@10 against E_primary (label==2 only) as a stricter subset', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e_primary' && c.scope === 'full-corpus',
    )!;
    // decisions-001: E_primary={a.md} only (b.md is label 1, excluded) -> recall 1.0 (a.md is returned)
    // decisions-002: E_primary={c.md} -> recall 1.0
    expect(cell.recall_at_k.mean).toBeCloseTo(1.0);
    expect(cell.n).toBe(2);
  });

  it('restricts to the 4 scope-matched prefixes for the scope-matched cell (Plaud/ is out of scope)', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'scope-matched',
    )!;
    // decisions-002's only relevant doc (Plaud/c.md) is out of scope -> its E becomes empty -> excluded (n=1, not 2)
    expect(cell.n).toBe(1);
  });

  it('treats a RunResult with .error as a total miss (recall 0), not a skip', () => {
    const erroredResults = [
      runResult('decisions-001', 'as-deployed', [], { error: 'search threw' }),
      runResult('decisions-002', 'as-deployed', [{ path: 'Plaud/c.md', rank: 0, final: 0.8, excerpt: '' }]),
    ];
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results: erroredResults },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus',
    )!;
    expect(cell.n).toBe(2); // both items counted (E non-empty for both) — decisions-001 scores 0
    expect(cell.recall_at_k.mean).toBeCloseTo(0.5); // (0 + 1) / 2
  });

  it('embeds routing and coverage verbatim without recomputing them', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: false, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    expect(scorecard.routing).toEqual(routingAnalysis.routing);
    expect(scorecard.coverage).toEqual(coverageFunnel);
  });

  it('passes indexChangedDuringRun through as any_degraded_runs', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, indexChangedDuringRun: true, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    expect(scorecard.run.any_degraded_runs).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/build-scorecard.test.ts`
Expected: FAIL — `eval/score/build-scorecard.ts` does not exist yet.

- [ ] **Step 3: Implement `build-scorecard.ts`**

Create `eval/score/build-scorecard.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHit, RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';
import type { EvalItem } from '../dataset/types.js';
import { recallAtK, precisionAtK, reciprocalRank, firstRelevantRank } from './metrics.js';
import { restrictToScope } from './scope.js';
import { bootstrapCI } from './bootstrap.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const K_VALUES = [10, 5] as const;
const RELEVANCE_LEVELS = ['e', 'e_primary'] as const;
const SCOPES = ['full-corpus', 'scope-matched'] as const;

type Relevance = (typeof RELEVANCE_LEVELS)[number];
type Scope = (typeof SCOPES)[number];

export interface MetricCell {
  k: number;
  relevance: Relevance;
  scope: Scope;
  n: number;
  recall_at_k: { mean: number; ci: [number, number] };
  precision_at_k: { mean: number; ci: [number, number] };
  mrr: { mean: number; ci: [number, number] };
  median_first_rank: number | null;
}

export interface CategoryVariantScore {
  category: string;
  variant: string;
  n_items: number;
  cells: MetricCell[];
  latency_ms_median: number;
  latency_ms_p95: number;
  response_tokens_median: number;
}

export interface Scorecard {
  run: {
    date: string;
    generated_at: string;
    db_doc_count: number;
    any_degraded_runs: boolean;
  };
  by_category_variant: CategoryVariantScore[];
  routing: unknown;
  coverage: unknown;
}

export interface ScorecardInput {
  runsFile: {
    dbSnapshot: { docCount: number; newestIndexedAt: string };
    indexChangedDuringRun: boolean;
    results: RunResult[];
  };
  judgments: Judgment[];
  items: EvalItem[];
  routingAnalysis: { routing: unknown };
  coverageFunnel: unknown;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

interface RelevanceEntry {
  e: Set<string>;
  e_primary: Set<string>;
}

/** Build item_id -> {e, e_primary} from judgments.json. Every judgment
 * counts as trusted ground truth regardless of label_provenance — the
 * judging-v2 dual-judge/behavioral-shortcut design already established
 * that provenance is a diagnostic field, not a scoring filter (spec
 * addendum §19). */
function buildRelevanceIndex(judgments: Judgment[]): Map<string, RelevanceEntry> {
  const index = new Map<string, RelevanceEntry>();
  for (const j of judgments) {
    if (!index.has(j.item_id)) index.set(j.item_id, { e: new Set(), e_primary: new Set() });
    const entry = index.get(j.item_id)!;
    if (j.label >= 1) entry.e.add(j.doc_id);
    if (j.label === 2) entry.e_primary.add(j.doc_id);
  }
  return index;
}

function relevantSetFor(relevance: Relevance, entry: RelevanceEntry | undefined): Set<string> {
  if (!entry) return new Set();
  return relevance === 'e' ? entry.e : entry.e_primary;
}

function computeCell(
  k: number,
  relevance: Relevance,
  scope: Scope,
  groupResults: RunResult[],
  relevanceIndex: Map<string, RelevanceEntry>,
): MetricCell {
  const recalls: number[] = [];
  const precisions: number[] = [];
  const rrs: number[] = [];
  const firstRanks: number[] = [];

  for (const result of groupResults) {
    const entry = relevanceIndex.get(result.itemId);
    // A thrown search call scores as a total miss (empty returned), not a
    // skip (spec §15) — this naturally drives recall to 0 for that item
    // when its E is non-empty, without special-casing the metric functions.
    let returned: RunHit[] = result.error ? [] : result.returned;
    let relevantDocIds = relevantSetFor(relevance, entry);

    if (scope === 'scope-matched') {
      const restricted = restrictToScope(returned, relevantDocIds);
      returned = restricted.returned;
      relevantDocIds = restricted.relevantDocIds;
    }

    const recall = recallAtK(returned, relevantDocIds, k);
    if (recall !== null) recalls.push(recall);

    const precision = precisionAtK(returned, relevantDocIds, k);
    if (precision !== null) precisions.push(precision);

    rrs.push(reciprocalRank(returned, relevantDocIds, k));

    const firstRank = firstRelevantRank(returned, relevantDocIds, k);
    if (firstRank !== null) firstRanks.push(firstRank);
  }

  return {
    k,
    relevance,
    scope,
    n: recalls.length,
    recall_at_k: { mean: mean(recalls), ci: bootstrapCI(recalls) },
    precision_at_k: { mean: mean(precisions), ci: bootstrapCI(precisions) },
    mrr: { mean: mean(rrs), ci: bootstrapCI(rrs) },
    median_first_rank: firstRanks.length > 0 ? median(firstRanks) : null,
  };
}

/** Pure scorecard assembly — no file I/O, so this is directly unit-testable
 * with small fixtures. `main()` below does the real file I/O and calls
 * this. */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const { runsFile, judgments, items, routingAnalysis, coverageFunnel } = input;
  const itemCategory = new Map(items.map((it) => [it.id, it.category]));
  const relevanceIndex = buildRelevanceIndex(judgments);

  const groups = new Map<string, RunResult[]>();
  for (const result of runsFile.results) {
    const category = itemCategory.get(result.itemId);
    if (!category) continue; // not in the finalized dataset — shouldn't happen, see plan Global Constraints
    const key = `${category}::${result.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(result);
  }

  const byCategoryVariant: CategoryVariantScore[] = [...groups.entries()].map(([key, groupResults]) => {
    const [category, variant] = key.split('::');
    const cells: MetricCell[] = [];
    for (const k of K_VALUES) {
      for (const relevance of RELEVANCE_LEVELS) {
        for (const scope of SCOPES) {
          cells.push(computeCell(k, relevance, scope, groupResults, relevanceIndex));
        }
      }
    }
    const latencies = groupResults.map((r) => r.latencyMs);
    const tokens = groupResults.map((r) => r.responseTokensEst);
    return {
      category,
      variant,
      n_items: groupResults.length,
      cells,
      latency_ms_median: median(latencies),
      latency_ms_p95: percentile(latencies, 0.95),
      response_tokens_median: median(tokens),
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  return {
    run: {
      date,
      generated_at: new Date().toISOString(),
      db_doc_count: runsFile.dbSnapshot.docCount,
      any_degraded_runs: runsFile.indexChangedDuringRun,
    },
    by_category_variant: byCategoryVariant,
    routing: routingAnalysis.routing,
    coverage: coverageFunnel,
  };
}

interface RunsFile {
  generatedAt: string;
  dbSnapshot: { docCount: number; newestIndexedAt: string };
  variants: string[];
  k: number;
  itemCount: number;
  results: RunResult[];
  indexChangedDuringRun: boolean;
}

async function main() {
  const runsFile: RunsFile = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/2026-07-06-runs.json'), 'utf8'));
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));
  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const routingAnalysis = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/routing-analysis.json'), 'utf8'));
  const coverageFunnel = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/coverage-funnel.json'), 'utf8'));

  const scorecard = buildScorecard({ runsFile, judgments, items, routingAnalysis, coverageFunnel });

  const outPath = join(REPO_ROOT, 'eval', 'results', `${scorecard.run.date}-scorecard.json`);
  writeFileSync(outPath, JSON.stringify(scorecard, null, 2));
  console.log(`Wrote eval/results/${scorecard.run.date}-scorecard.json`);
  console.log(`${scorecard.by_category_variant.length} category×variant groups scored.`);
}

if (process.argv[1]?.endsWith('build-scorecard.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/build-scorecard.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Add the `eval:score` package.json script**

In `package.json`, in the `"scripts"` block, add this line immediately after the existing `"eval:judge-full"` line (around line 24):

```json
    "eval:score": "tsx eval/score/build-scorecard.ts",
```

- [ ] **Step 6: Run the real script against the live data and verify it produces a sane scorecard**

Run: `pnpm eval:score`
Expected: Prints `Wrote eval/results/<today's date>-scorecard.json` and a group count. Then inspect the output:

```bash
node -e "
const sc = JSON.parse(require('fs').readFileSync(require('fs').readdirSync('eval/results').filter(f => f.endsWith('-scorecard.json')).sort().pop() && 'eval/results/' + require('fs').readdirSync('eval/results').filter(f => f.endsWith('-scorecard.json')).sort().pop(), 'utf8'));
console.log('groups:', sc.by_category_variant.length);
console.log('cells per group:', sc.by_category_variant[0].cells.length);
console.log('sample cell:', JSON.stringify(sc.by_category_variant[0].cells[0], null, 2));
console.log('routing present:', !!sc.routing);
console.log('coverage present:', !!sc.coverage);
"
```

Expected: `groups` is a positive number (up to 5 categories × 2 variants = 10), `cells per group` is 8, `routing present`/`coverage present` are both `true`.

- [ ] **Step 7: Run the full eval test suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests pass (previous count was 767; expect 767 + 9 (metrics) + 6 (bootstrap) + 3 (scope) + 7 (build-scorecard) = 792).

- [ ] **Step 8: Commit**

```bash
git add eval/score/build-scorecard.ts test/eval/build-scorecard.test.ts package.json eval/results/*-scorecard.json
git commit -m "feat(eval): Phase 3 scorecard orchestrator — pnpm eval:score"
```

---

## Post-plan note for the next plan

This plan does not render a human-readable `.md` report from the scorecard
JSON (spec §16 Phase 3 row mentions `results/<date>-scorecard.{md,json}` —
only the `.json` half is built here). Producing the `.md` companion (and/or
consuming the scorecard for the actual Track A/B bake-off decision) is
follow-up work, not part of this plan's scope — it was not one of the three
scope questions confirmed before this plan was written, and adding it here
would silently expand scope beyond what was approved.
