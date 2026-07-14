# Bake-Off Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `full-cov-hybrid` arm to the variant runner, re-run the existing harness + scorer against all 3 arms, and build the final weighted-composite bake-off assembly (`eval/score/build-bakeoff.ts`, `pnpm eval:bakeoff`) that decides grep-first vs full-coverage hybrid per spec §4.5-§4.7, writing `eval/results/<date>-bakeoff.{json,md}`.

**Architecture:** Task 1 extends already-merged, already-tested modules with minimal, well-scoped changes (a shared `stats.ts`, a few new exports from `build-scorecard.ts`, a third `Variant` in `variants.ts`). Task 2 is a new orchestrator that pools raw per-item results for an unambiguous, item-weighted arm-level accuracy figure (rather than re-aggregating the scorecard's already-aggregated per-category means, which would require separate item-count weighting per metric to combine correctly), reuses the scorecard's per-category cells directly for the `by_category` breakdown, and computes the simplicity rubric from the shared `VariantProfile` data.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, no new dependencies.

## Global Constraints

- Bake-off **contenders** are exactly `grep-first` and `full-cov-hybrid`. `as-deployed` is a **reference only** — it is excluded from the `min()` used to normalize latency and token sub-scores (spec §11 addendum, confirmed with Tom 2026-07-15), though its own numbers are still reported in the scorecard for context.
- Accuracy sub-score = `0.6·recall@10 + 0.25·precision@10 + 0.15·MRR`, computed from the **`E` (label≥1), full-corpus, k=10** cell — not `E_primary`, not scope-matched (matches the original spec §4.4 formula; those other variants are Track A Phase 3 additions, not part of this formula).
- Accuracy is computed by **pooling raw `RunResult`s for a variant across all items** (ignoring category grouping) and calling the same `computeCell` primitive once — not by re-averaging the scorecard's per-category means, which have different, metric-specific item counts that don't combine by simple averaging.
- Composite = `0.50·accuracy_sub + 0.20·latency_sub + 0.15·tokens_sub + 0.15·simplicity_sub`.
- Simplicity penalty per arm = `depsPenalty + storageGbBeyondFts + jobsPenalty + failureModesPenalty + surfacePenalty`, where `depsPenalty = runtimeDeps.length > 0 ? 2 : 0`, `jobsPenalty = maintenanceJobs.length > 0 ? 2 : 0`, `failureModesPenalty = silentDegradationModes.length > 0 ? 1 : 0`, `surfacePenalty` = `{low: 0, medium: 0.5, high: 1}[codeSurface]` (resolved with Tom: `low=0, high=1`, matching the rubric's smallest existing scale). `storageGbBeyondFts` uses the **real measured `1.3`** from `eval/results/2026-07-14-arm-b-backfill.json`'s `db_size_delta_gb` (resolved with Tom: use the real value, not the spec's `~1.0` placeholder). `simplicity_sub = 1 - penalty / max_penalty` where `max_penalty` = the higher of the two arms' total penalties.
- Verdict: highest composite wins; if the margin is `<= 0.03`, `grep-first` wins (simplicity tiebreak, spec §4.5).
- `full-cov-hybrid`'s store must open against `eval/state/bakeoff-fullcov.sqlite` in real (non-keyword-only) hybrid mode, via the existing `openVariantStore` (no changes needed there).
- All new/modified files use `.js` extensions on relative imports.
- `eval/results/<date>-bakeoff.json` and `.md` both get written (spec §4.7 requires both — unlike Track A Phase 3's scorecard, which only needed `.json`).

---

### Task 1: Shared stats module, scorecard exports, third variant

**Files:**
- Create: `eval/score/stats.ts`
- Test: `test/eval/stats.test.ts`
- Modify: `eval/score/build-scorecard.ts`
- Modify: `eval/run/variants.ts`
- Modify: `test/eval/variants.test.ts`

**Interfaces:**
- Produces (used by Task 2):
  - `mean(values: number[]): number`, `median(values: number[]): number`, `percentile(values: number[], p: number): number` from `eval/score/stats.js`
  - `computeCell(k: number, relevance: Relevance, scope: Scope, groupResults: RunResult[], relevanceIndex: Map<string, RelevanceEntry>): MetricCell`, `buildRelevanceIndex(judgments: Judgment[]): Map<string, RelevanceEntry>`, and the `RelevanceEntry`, `Relevance`, `Scope` types, all now exported from `eval/score/build-scorecard.js`
  - `VARIANT_PROFILES: Record<'grep-first' | 'as-deployed' | 'full-cov-hybrid', VariantProfile>` from `eval/run/variants.js`

- [ ] **Step 1: Write the failing test for `stats.ts`**

Create `test/eval/stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mean, median, percentile } from '../../eval/score/stats.js';

describe('mean', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2);
  });

  it('returns 0 for an empty array', () => {
    expect(mean([])).toBe(0);
  });
});

describe('median', () => {
  it('returns the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('percentile', () => {
  it('returns the value at the given percentile', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.95)).toBe(10);
  });

  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/stats.test.ts`
Expected: FAIL — `eval/score/stats.ts` does not exist yet.

- [ ] **Step 3: Implement `stats.ts`**

Create `eval/score/stats.ts`:

```ts
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/stats.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Update `build-scorecard.ts` to use the shared stats module and export its internals**

In `eval/score/build-scorecard.ts`:

1. Add this import near the top (alongside the existing imports):
   ```ts
   import { mean, median, percentile } from './stats.js';
   ```

2. Delete the three private function definitions (the `function mean(...)`, `function median(...)`, `function percentile(...)` blocks) — they are now provided by the import above.

3. Change `type Relevance = ...` and `type Scope = ...` to `export type Relevance = ...` and `export type Scope = ...`.

4. Change `interface RelevanceEntry { ... }` to `export interface RelevanceEntry { ... }`.

5. Change `function buildRelevanceIndex(...)` to `export function buildRelevanceIndex(...)`.

6. Change `function computeCell(...)` to `export function computeCell(...)`.

Everything else in the file stays exactly as-is — this is a mechanical export-widening plus a de-duplication, not a behavior change.

- [ ] **Step 6: Run the full existing test suite for this file to confirm no regression**

Run: `npx vitest run test/eval/build-scorecard.test.ts test/eval/stats.test.ts`
Expected: PASS (7 + 6 = 13 tests, same 7 build-scorecard tests as before, now passing against the refactored file)

- [ ] **Step 7: Add the `full-cov-hybrid` variant to `variants.ts`**

Replace the full contents of `eval/run/variants.ts` with:

```ts
import { join } from 'node:path';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { openVariantStore } from './open-store.js';
import type { Variant, VariantProfile } from './types.js';

/** Static simplicity-rubric facts per arm (spec §4.6, §6.1), shared between
 * `buildVariants` (which wires these into the real harness-executable
 * `Variant`s) and `eval/score/build-bakeoff.ts` (which scores the bake-off
 * composite from these same facts) — a single source of truth so the
 * harness and the scoring never drift apart. `full-cov-hybrid`'s
 * `storageGbBeyondFts: 1.3` is the REAL measured value from
 * `eval/results/2026-07-14-arm-b-backfill.json`'s `db_size_delta_gb`
 * (spec §11 addendum — use real facts, not the design doc's `~1.0`
 * placeholder). */
export const VARIANT_PROFILES: Record<'grep-first' | 'as-deployed' | 'full-cov-hybrid', VariantProfile> = {
  'grep-first': {
    runtimeDeps: [],
    storageGbBeyondFts: 0,
    maintenanceJobs: [],
    silentDegradationModes: [],
    codeSurface: 'low',
  },
  'as-deployed': {
    runtimeDeps: ['ollama'],
    storageGbBeyondFts: 1,
    maintenanceJobs: ['embedding-index'],
    silentDegradationModes: ['provider-down->keyword-only'],
    codeSurface: 'high',
  },
  'full-cov-hybrid': {
    runtimeDeps: ['ollama'],
    storageGbBeyondFts: 1.3,
    maintenanceJobs: ['embedding-index', 'embedding-sync'],
    silentDegradationModes: ['provider-down->keyword-only'],
    codeSurface: 'high',
  },
};

/** The bake-off's 3 arms: 2 real contenders (grep-first, full-cov-hybrid)
 * plus as-deployed as a free reference (not a contender — spec §4.1). */
export function buildVariants(config: KarpathyConfig, projectRoot: string, topK = 10): Variant[] {
  const liveDb = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  const fullCovDb = join(projectRoot, 'eval', 'state', 'bakeoff-fullcov.sqlite');
  return [
    {
      name: 'grep-first',
      keywordOnly: true,
      topK,
      openStore: () => openVariantStore(config, liveDb, { keywordOnly: true }),
      profile: VARIANT_PROFILES['grep-first'],
    },
    {
      name: 'as-deployed',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, liveDb, {}),
      profile: VARIANT_PROFILES['as-deployed'],
    },
    {
      name: 'full-cov-hybrid',
      keywordOnly: false,
      topK,
      openStore: () => openVariantStore(config, fullCovDb, {}),
      profile: VARIANT_PROFILES['full-cov-hybrid'],
    },
  ];
}
```

- [ ] **Step 8: Update `test/eval/variants.test.ts` for the third variant**

Replace the full contents of `test/eval/variants.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { buildVariants, VARIANT_PROFILES } from '../../eval/run/variants.js';

describe('buildVariants', () => {
  it('defines grep-first (keyword-only, no deps), as-deployed (hybrid, ollama dep), and full-cov-hybrid (hybrid, ollama dep, higher storage/jobs)', () => {
    // profiles are static (independent of config.embeddings.provider), so a
    // deterministic-provider config is enough to verify wiring without Ollama.
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/v', embeddings: { provider: 'deterministic' } });
    const variants = buildVariants(config, '/tmp/root', 10);
    const byName = Object.fromEntries(variants.map((v) => [v.name, v]));

    expect(Object.keys(byName).sort()).toEqual(['as-deployed', 'full-cov-hybrid', 'grep-first']);
    expect(byName['grep-first'].keywordOnly).toBe(true);
    expect(byName['grep-first'].profile.runtimeDeps).toEqual([]);
    expect(byName['as-deployed'].keywordOnly).toBe(false);
    expect(byName['as-deployed'].profile.runtimeDeps).toContain('ollama');
    expect(byName['full-cov-hybrid'].keywordOnly).toBe(false);
    expect(byName['full-cov-hybrid'].profile.runtimeDeps).toContain('ollama');
    expect(byName['full-cov-hybrid'].profile.storageGbBeyondFts).toBe(1.3);
    expect(byName['full-cov-hybrid'].profile.maintenanceJobs).toEqual(['embedding-index', 'embedding-sync']);
    expect(byName['grep-first'].topK).toBe(10);
    expect(typeof byName['grep-first'].openStore).toBe('function');
    expect(typeof byName['full-cov-hybrid'].openStore).toBe('function');
  });

  it('exports VARIANT_PROFILES as the single source of truth used by both the harness and the bake-off scorer', () => {
    expect(VARIANT_PROFILES['grep-first'].codeSurface).toBe('low');
    expect(VARIANT_PROFILES['full-cov-hybrid'].codeSurface).toBe('high');
  });
});
```

- [ ] **Step 9: Run the variants test to verify it passes**

Run: `npx vitest run test/eval/variants.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 10: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: all pre-existing tests pass, plus the new stats.ts tests (baseline was 802; expect 802 + 6 (stats) + 1 (new variants test case) = 809 — the variants.test.ts file goes from 1 test to 2 tests, a net +1, and stats.test.ts adds 6 new tests).

- [ ] **Step 11: Commit**

```bash
git add eval/score/stats.ts eval/score/build-scorecard.ts eval/run/variants.ts test/eval/stats.test.ts test/eval/variants.test.ts
git commit -m "feat(eval): shared stats module, scorecard internals exported, full-cov-hybrid variant"
```

---

### Task 2: Bake-off composite assembly + real run

**Files:**
- Create: `eval/score/build-bakeoff.ts`
- Modify: `package.json` (add `eval:bakeoff` script)
- Test: `test/eval/build-bakeoff.test.ts`

**Interfaces:**
- Consumes:
  - `mean`, `median`, `percentile` from `./stats.js` (Task 1)
  - `computeCell`, `buildRelevanceIndex`, `MetricCell`, `Scorecard`, `CategoryVariantScore` from `./build-scorecard.js` (Task 1 exports + pre-existing exports)
  - `VARIANT_PROFILES` from `../run/variants.js` (Task 1)
  - `RunResult` from `../run/types.js` (pre-existing)
  - `Judgment` from `../pool/judge.js` (pre-existing)
- Produces: `buildBakeoff(input: BakeoffInput): Bakeoff` (pure), `renderBakeoffMarkdown(bakeoff: Bakeoff): string` (pure), `main()` (file I/O), `pnpm eval:bakeoff`.

- [ ] **Step 1: Write the failing tests**

Create `test/eval/build-bakeoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBakeoff, renderBakeoffMarkdown } from '../../eval/score/build-bakeoff.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';
import type { Scorecard } from '../../eval/score/build-scorecard.js';

function judgment(item_id: string, doc_id: string, label: number): Judgment {
  return { item_id, doc_id, label, reason: '', label_provenance: 'llm' };
}

function runResult(itemId: string, variant: string, returned: RunResult['returned'], latencyMs: number, responseTokensEst: number): RunResult {
  return {
    itemId,
    variant,
    query: `query for ${itemId}`,
    returned,
    searchMode: 'hybrid',
    latencyMs,
    responseChars: responseTokensEst * 4,
    responseTokensEst,
  };
}

describe('buildBakeoff', () => {
  const judgments = [
    judgment('decisions-001', 'a.md', 2),
    judgment('decisions-002', 'b.md', 2),
  ];

  // grep-first: perfect recall, slower and more tokens.
  // full-cov-hybrid: perfect recall, faster and fewer tokens.
  const runsResults: RunResult[] = [
    runResult('decisions-001', 'grep-first', [{ path: 'a.md', rank: 0, final: 1, excerpt: '' }], 200, 2000),
    runResult('decisions-002', 'grep-first', [{ path: 'b.md', rank: 0, final: 1, excerpt: '' }], 220, 2100),
    runResult('decisions-001', 'full-cov-hybrid', [{ path: 'a.md', rank: 0, final: 1, excerpt: '' }], 100, 1000),
    runResult('decisions-002', 'full-cov-hybrid', [{ path: 'b.md', rank: 0, final: 1, excerpt: '' }], 110, 1050),
    runResult('decisions-001', 'as-deployed', [], 5, 10), // reference, deliberately the fastest/cheapest of all 3 — must NOT win normalization
    runResult('decisions-002', 'as-deployed', [], 5, 10),
  ];

  const scorecard: Scorecard = {
    run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 100, any_degraded_runs: false },
    by_category_variant: [
      {
        category: 'decisions',
        variant: 'grep-first',
        n_items: 2,
        cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
        latency_ms_median: 210,
        latency_ms_p95: 220,
        response_tokens_median: 2050,
      },
      {
        category: 'decisions',
        variant: 'full-cov-hybrid',
        n_items: 2,
        cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
        latency_ms_median: 105,
        latency_ms_p95: 110,
        response_tokens_median: 1025,
      },
    ],
    routing: {},
    coverage: {},
  };

  const backfillReport = { notes_embedded: 19638, wall_clock_min: 37.21, db_size_delta_gb: 1.3 };

  it('excludes as-deployed from latency/token normalization (the fastest/cheapest reference must not deflate the contenders)', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    // full-cov-hybrid is faster than grep-first among the two contenders -> its own latency sub should be 1.0 (it IS the best contender).
    expect(fullCov.latency.sub).toBeCloseTo(1.0);
    // grep-first's sub should reflect its ratio to full-cov-hybrid (~105/210), NOT to as-deployed's ~5ms.
    expect(grepFirst.latency.sub).toBeCloseTo(105 / 210, 1);
  });

  it('computes composite as 0.5*accuracy + 0.2*latency + 0.15*tokens + 0.15*simplicity', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const expected = 0.5 * grepFirst.accuracy.sub + 0.2 * grepFirst.latency.sub + 0.15 * grepFirst.tokens.sub + 0.15 * grepFirst.simplicity.sub;
    expect(grepFirst.composite).toBeCloseTo(expected);
  });

  it('gives grep-first a perfect simplicity sub-score (zero penalty) and full-cov-hybrid a zero simplicity sub-score (max penalty)', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    expect(grepFirst.simplicity.penalty).toBe(0);
    expect(grepFirst.simplicity.sub).toBeCloseTo(1.0);
    expect(fullCov.simplicity.sub).toBeCloseTo(0);
  });

  it('applies the <=0.03 margin tiebreak in favor of grep-first when the composite margin is small', () => {
    // Hand-verified against the formula: both arms have accSub=1.0 (perfect
    // recall/precision/mrr on both decisions items). grep-first latSub=0.5
    // (210ms vs the pooled-best 105ms), tokSub=0.5 (2050 vs best 1025),
    // simSub=1.0 (zero penalty) -> composite = 0.5*1 + 0.2*0.5 + 0.15*0.5 +
    // 0.15*1 = 0.825. full-cov-hybrid latSub=1.0, tokSub=1.0, simSub=0 (it's
    // the only arm with any penalty, so its own penalty == maxPenalty) ->
    // composite = 0.5*1 + 0.2*1 + 0.15*1 + 0.15*0 = 0.85. margin = 0.025,
    // which is <= 0.03 -> grep-first wins by the tiebreak despite having the
    // numerically lower raw composite.
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    expect(grepFirst.composite).toBeCloseTo(0.825);
    expect(fullCov.composite).toBeCloseTo(0.85);
    expect(bakeoff.verdict.margin).toBeCloseTo(0.025);
    expect(bakeoff.verdict.margin).toBeLessThanOrEqual(0.03);
    expect(bakeoff.verdict.winner).toBe('grep-first');
  });

  it('detects a mixed verdict when a category winner differs from the overall winner', () => {
    // Add a 3rd item (hot-topics-001) where full-cov-hybrid hits and
    // grep-first misses entirely -> full-cov-hybrid's OVERALL pooled
    // accuracy (3 items: 2 perfect ties + 1 decisive win) becomes clearly
    // higher than grep-first's, giving a wide (non-tie) composite margin
    // in full-cov-hybrid's favor: grep-first accSub = 0.6*(2/3) + 0.25*(2/2,
    // precision excludes the miss's null) + 0.15*(2/3) = 0.75; full-cov-hybrid
    // accSub = 1.0 (perfect on all 3). Pooled latency/tokens: grep-first
    // median [200,220,200]=200, full-cov-hybrid [100,110,100]=100 ->
    // grep latSub=0.5, full-cov latSub=1.0 (same shape for tokens). Overall
    // composite: grep-first = 0.5*0.75+0.2*0.5+0.15*0.5+0.15*1 = 0.7;
    // full-cov-hybrid = 0.5*1+0.2*1+0.15*1+0.15*0 = 0.85. margin=0.15 (not a
    // tie) -> full-cov-hybrid wins outright.
    //
    // The by_category scorecard fixture below is independently crafted (it
    // does not need to numerically match the runsResults above — this test
    // exercises only the mixed-detection logic) to make grep-first win the
    // 'decisions' category specifically by a wide margin, producing a
    // genuine mixed result: overall winner is full-cov-hybrid, but the
    // 'decisions' category's own winner is grep-first.
    const mixedRunsResults: RunResult[] = [
      ...runsResults,
      runResult('hot-topics-001', 'grep-first', [], 200, 2000),
      runResult('hot-topics-001', 'full-cov-hybrid', [{ path: 'c.md', rank: 0, final: 1, excerpt: '' }], 100, 1000),
      runResult('hot-topics-001', 'as-deployed', [], 5, 10),
    ];
    const mixedJudgments = [...judgments, judgment('hot-topics-001', 'c.md', 2)];
    const mixedScorecard: Scorecard = {
      ...scorecard,
      by_category_variant: [
        {
          category: 'decisions',
          variant: 'grep-first',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
          latency_ms_median: 50,
          latency_ms_p95: 60,
          response_tokens_median: 500,
        },
        {
          category: 'decisions',
          variant: 'full-cov-hybrid',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 0, ci: [0, 0] }, precision_at_k: { mean: 0, ci: [0, 0] }, mrr: { mean: 0, ci: [0, 0] }, median_first_rank: null }],
          latency_ms_median: 300,
          latency_ms_p95: 310,
          response_tokens_median: 3000,
        },
      ],
    };
    const bakeoff = buildBakeoff({
      runsResults: mixedRunsResults,
      scorecard: mixedScorecard,
      judgments: mixedJudgments,
      backfillReport,
    });
    expect(bakeoff.verdict.winner).toBe('full-cov-hybrid');
    expect(bakeoff.verdict.mixed).toBe(true);
  });

  it('passes the backfill ledger through with the exact field names from spec §6.2', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    expect(bakeoff.backfill_ledger).toEqual({ notes_embedded: 19638, wall_clock_min: 37.21, db_size_delta_gb: 1.3 });
  });
});

describe('renderBakeoffMarkdown', () => {
  it('includes the winner, margin, and a composite table row per arm', () => {
    const bakeoff = buildBakeoff({
      runsResults: [
        { itemId: 'x', variant: 'grep-first', query: 'q', returned: [], searchMode: 'keyword-only', latencyMs: 100, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'full-cov-hybrid', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 50, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'as-deployed', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 5, responseChars: 40, responseTokensEst: 10 },
      ],
      scorecard: {
        run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 1, any_degraded_runs: false },
        by_category_variant: [],
        routing: {},
        coverage: {},
      },
      judgments: [],
      backfillReport: { notes_embedded: 1, wall_clock_min: 1, db_size_delta_gb: 1 },
    });
    const md = renderBakeoffMarkdown(bakeoff);
    expect(md).toContain(bakeoff.verdict.winner);
    expect(md).toContain('grep-first');
    expect(md).toContain('full-cov-hybrid');
    expect(md).toContain('| Arm | Accuracy | Latency | Tokens | Simplicity | Composite |');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/build-bakeoff.test.ts`
Expected: FAIL — `eval/score/build-bakeoff.ts` does not exist yet.

- [ ] **Step 3: Implement `build-bakeoff.ts`**

Create `eval/score/build-bakeoff.ts`:

```ts
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';
import { VARIANT_PROFILES } from '../run/variants.js';
import { computeCell, buildRelevanceIndex, type MetricCell, type Scorecard } from './build-scorecard.js';
import { median, percentile } from './stats.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const CONTENDERS = ['grep-first', 'full-cov-hybrid'] as const;
type Contender = (typeof CONTENDERS)[number];

const DEPS_WEIGHT = 2;
const JOBS_WEIGHT = 2;
const FAILURE_MODES_WEIGHT = 1;
const SURFACE_WEIGHT: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 0.5, high: 1 };

export interface ArmComposite {
  name: Contender;
  accuracy: { recall_at_10: number; precision_at_10: number; mrr: number; sub: number };
  latency: { median_ms: number; p95_ms: number; sub: number };
  tokens: { median: number; sub: number };
  simplicity: { penalty: number; sub: number };
  composite: number;
  by_category: Record<string, { composite: number }>;
}

export interface BakeoffVerdict {
  winner: Contender;
  margin: number;
  rationale: string;
  mixed: boolean;
}

export interface Bakeoff {
  run: { date: string; eval_set_version: string; k: number };
  backfill_ledger: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
  arms: ArmComposite[];
  verdict: BakeoffVerdict;
}

export interface BakeoffInput {
  runsResults: RunResult[];
  scorecard: Scorecard;
  judgments: Judgment[];
  backfillReport: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
}

/** Total simplicity penalty for one arm (spec §4.6). deps/jobs/failure-mode
 * penalties are fixed per-factor weights triggered by "does this arm have
 * any of these at all" (not a literal count — the spec table assigns a
 * flat 2/2/1 weight per factor, not one point per array entry). Storage
 * uses the real measured GB value directly, since it's a continuous fact,
 * not a category. Code surface uses the resolved low=0/high=1 (medium=0.5
 * for type completeness, unused by either current arm). */
function computeSimplicityPenalty(name: Contender): number {
  const profile = VARIANT_PROFILES[name];
  const depsPenalty = profile.runtimeDeps.length > 0 ? DEPS_WEIGHT : 0;
  const jobsPenalty = profile.maintenanceJobs.length > 0 ? JOBS_WEIGHT : 0;
  const failureModesPenalty = profile.silentDegradationModes.length > 0 ? FAILURE_MODES_WEIGHT : 0;
  const surfacePenalty = SURFACE_WEIGHT[profile.codeSurface];
  return depsPenalty + profile.storageGbBeyondFts + jobsPenalty + failureModesPenalty + surfacePenalty;
}

/** Item-weighted accuracy across ALL of a variant's results, pooled
 * (ignoring category grouping) — avoids re-averaging the scorecard's
 * already-aggregated per-category means, which have different per-metric
 * item counts that don't combine by simple averaging. Matches spec §4.4's
 * original formula inputs: E (label>=1), full-corpus, k=10. */
function pooledAccuracyCell(
  variantResults: RunResult[],
  relevanceIndex: ReturnType<typeof buildRelevanceIndex>,
): MetricCell {
  return computeCell(10, 'e', 'full-corpus', variantResults, relevanceIndex);
}

function accuracySub(cell: MetricCell): number {
  return 0.6 * cell.recall_at_k.mean + 0.25 * cell.precision_at_k.mean + 0.15 * cell.mrr.mean;
}

/** Pure bake-off assembly — no file I/O, directly unit-testable with small
 * fixtures. `main()` below does the real file I/O and calls this. */
export function buildBakeoff(input: BakeoffInput): Bakeoff {
  const { runsResults, scorecard, judgments, backfillReport } = input;
  const relevanceIndex = buildRelevanceIndex(judgments);

  const armStats = new Map<
    Contender,
    { cell: MetricCell; latencyMedian: number; latencyP95: number; tokensMedian: number }
  >();
  for (const name of CONTENDERS) {
    // Excludes as-deployed by construction (CONTENDERS has only 2 entries) —
    // the reference arm's results are simply never pooled or normalized
    // against here (spec §11 addendum: as-deployed must not deflate/inflate
    // either contender's sub-score).
    const variantResults = runsResults.filter((r) => r.variant === name);
    const cell = pooledAccuracyCell(variantResults, relevanceIndex);
    const latencies = variantResults.map((r) => r.latencyMs);
    const tokens = variantResults.map((r) => r.responseTokensEst);
    armStats.set(name, {
      cell,
      latencyMedian: median(latencies),
      latencyP95: percentile(latencies, 0.95),
      tokensMedian: median(tokens),
    });
  }

  const bestLatency = Math.min(...CONTENDERS.map((n) => armStats.get(n)!.latencyMedian));
  const bestTokens = Math.min(...CONTENDERS.map((n) => armStats.get(n)!.tokensMedian));

  const penalties = new Map(CONTENDERS.map((n) => [n, computeSimplicityPenalty(n)]));
  const maxPenalty = Math.max(...CONTENDERS.map((n) => penalties.get(n)!));

  const categoriesForVariant = (name: Contender) => scorecard.by_category_variant.filter((g) => g.variant === name);

  const arms: ArmComposite[] = CONTENDERS.map((name) => {
    const stats = armStats.get(name)!;
    const accSub = accuracySub(stats.cell);
    const latSub = stats.latencyMedian > 0 ? bestLatency / stats.latencyMedian : 1;
    const tokSub = stats.tokensMedian > 0 ? bestTokens / stats.tokensMedian : 1;
    const penalty = penalties.get(name)!;
    const simSub = maxPenalty > 0 ? 1 - penalty / maxPenalty : 1;
    const composite = 0.5 * accSub + 0.2 * latSub + 0.15 * tokSub + 0.15 * simSub;

    const byCategory: Record<string, { composite: number }> = {};
    for (const group of categoriesForVariant(name)) {
      const groupCell = group.cells.find((c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus');
      if (!groupCell) continue;
      const groupAccSub = accuracySub(groupCell);
      const groupLatSub = group.latency_ms_median > 0 ? bestLatency / group.latency_ms_median : 1;
      const groupTokSub = group.response_tokens_median > 0 ? bestTokens / group.response_tokens_median : 1;
      byCategory[group.category] = {
        composite: 0.5 * groupAccSub + 0.2 * groupLatSub + 0.15 * groupTokSub + 0.15 * simSub,
      };
    }

    return {
      name,
      accuracy: {
        recall_at_10: stats.cell.recall_at_k.mean,
        precision_at_10: stats.cell.precision_at_k.mean,
        mrr: stats.cell.mrr.mean,
        sub: accSub,
      },
      latency: { median_ms: stats.latencyMedian, p95_ms: stats.latencyP95, sub: latSub },
      tokens: { median: stats.tokensMedian, sub: tokSub },
      simplicity: { penalty, sub: simSub },
      composite,
      by_category: byCategory,
    };
  });

  const [a, b] = arms;
  const margin = Math.abs(a.composite - b.composite);
  // Ties within 0.03 go to grep-first (simplicity tiebreak, spec §4.5's stated lean).
  const winner: Contender = margin <= 0.03 ? 'grep-first' : a.composite > b.composite ? a.name : b.name;
  const winnerArm = arms.find((arm) => arm.name === winner)!;
  const loserArm = arms.find((arm) => arm.name !== winner)!;
  const mixed = Object.keys(winnerArm.by_category).some((cat) => {
    const winnerCatComposite = winnerArm.by_category[cat]?.composite;
    const loserCatComposite = loserArm.by_category[cat]?.composite;
    return winnerCatComposite !== undefined && loserCatComposite !== undefined && loserCatComposite > winnerCatComposite;
  });
  const rationale =
    margin <= 0.03
      ? `Composite scores are within the 0.03 tie threshold (margin ${margin.toFixed(3)}) — simplicity breaks the tie in favor of grep-first per spec §4.5.`
      : `${winner} wins by a ${margin.toFixed(3)} composite margin over ${loserArm.name}.`;

  return {
    run: { date: new Date().toISOString().slice(0, 10), eval_set_version: scorecard.run.date, k: 10 },
    backfill_ledger: {
      notes_embedded: backfillReport.notes_embedded,
      wall_clock_min: backfillReport.wall_clock_min,
      db_size_delta_gb: backfillReport.db_size_delta_gb,
    },
    arms,
    verdict: { winner, margin: +margin.toFixed(3), rationale, mixed },
  };
}

/** Human-readable companion to the JSON (spec §4.7 requires both). */
export function renderBakeoffMarkdown(bakeoff: Bakeoff): string {
  const lines: string[] = [];
  lines.push(`# Bake-off Report — ${bakeoff.run.date}`, '');
  lines.push(`## Verdict`, '');
  lines.push(`**Winner: ${bakeoff.verdict.winner}** (margin: ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed ? 'yes' : 'no'})`, '');
  lines.push(bakeoff.verdict.rationale, '');
  lines.push(`## Backfill cost (Arm B, full-cov-hybrid)`, '');
  lines.push(`- Notes embedded: ${bakeoff.backfill_ledger.notes_embedded}`);
  lines.push(`- Wall clock: ${bakeoff.backfill_ledger.wall_clock_min} min`);
  lines.push(`- DB size delta: ${bakeoff.backfill_ledger.db_size_delta_gb} GB`, '');
  lines.push(`## Composite scores`, '');
  lines.push(`| Arm | Accuracy | Latency | Tokens | Simplicity | Composite |`);
  lines.push(`|-----|----------|---------|--------|------------|-----------|`);
  for (const arm of bakeoff.arms) {
    lines.push(
      `| ${arm.name} | ${arm.accuracy.sub.toFixed(3)} | ${arm.latency.sub.toFixed(3)} | ${arm.tokens.sub.toFixed(3)} | ${arm.simplicity.sub.toFixed(3)} | ${arm.composite.toFixed(3)} |`,
    );
  }
  lines.push('');
  lines.push(`## By category`, '');
  const categories = [...new Set(bakeoff.arms.flatMap((arm) => Object.keys(arm.by_category)))].sort();
  if (categories.length > 0) {
    lines.push(`| Category | ${bakeoff.arms.map((a) => a.name).join(' | ')} |`);
    lines.push(`|----------|${bakeoff.arms.map(() => '---').join('|')}|`);
    for (const cat of categories) {
      const cells = bakeoff.arms.map((arm) => arm.by_category[cat]?.composite?.toFixed(3) ?? 'n/a');
      lines.push(`| ${cat} | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function findLatestDatedFile(dir: string, suffixPattern: RegExp): string {
  const candidates = readdirSync(dir).filter((f) => suffixPattern.test(f));
  if (candidates.length === 0) throw new Error(`No file matching ${suffixPattern} found in ${dir}`);
  candidates.sort();
  return join(dir, candidates[candidates.length - 1]);
}

async function main() {
  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  const runsPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-runs\.json$/);
  const scorecardPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-scorecard\.json$/);
  const backfillPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-arm-b-backfill\.json$/);
  console.log(`Using runs: ${runsPath.replace(REPO_ROOT + '/', '')}`);
  console.log(`Using scorecard: ${scorecardPath.replace(REPO_ROOT + '/', '')}`);
  console.log(`Using backfill report: ${backfillPath.replace(REPO_ROOT + '/', '')}`);

  const runsFile = JSON.parse(readFileSync(runsPath, 'utf8')) as { results: RunResult[] };
  const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8')) as Scorecard;
  const backfillReport = JSON.parse(readFileSync(backfillPath, 'utf8')) as {
    notes_embedded: number;
    wall_clock_min: number;
    db_size_delta_gb: number;
  };
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));

  const bakeoff = buildBakeoff({ runsResults: runsFile.results, scorecard, judgments, backfillReport });

  const date = bakeoff.run.date;
  writeFileSync(join(resultsDir, `${date}-bakeoff.json`), JSON.stringify(bakeoff, null, 2));
  writeFileSync(join(resultsDir, `${date}-bakeoff.md`), renderBakeoffMarkdown(bakeoff));
  console.log(`Wrote eval/results/${date}-bakeoff.json and .md`);
  console.log(`Verdict: ${bakeoff.verdict.winner} (margin ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed})`);
}

if (process.argv[1]?.endsWith('build-bakeoff.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/build-bakeoff.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Add the `eval:bakeoff` package.json script**

In `package.json`, in the `"scripts"` block, add this line immediately after the existing `"eval:arm-b-backfill"` line:

```json
    "eval:bakeoff": "tsx eval/score/build-bakeoff.ts",
```

- [ ] **Step 6: Run the real pipeline end to end against live data**

Run these three commands in order (each depends on the previous one's output file):

```bash
pnpm eval:run
pnpm eval:score
pnpm eval:bakeoff
```

Expected: `eval:run` prints a new `<date>-runs.json` with 3 variants (219 results — 73 items × 3 arms; the `full-cov-hybrid` arm will make real Ollama calls, so this may take longer than the 2-arm baseline, but should still complete in well under this tool's timeout). `eval:score` prints the new group count (should be 15 now: 5 categories × 3 variants). `eval:bakeoff` prints the verdict line.

- [ ] **Step 7: Inspect the real bake-off output**

Run:
```bash
node -e "
const fs = require('fs');
const files = fs.readdirSync('eval/results').filter(f => /^\d{4}-\d{2}-\d{2}-bakeoff\.json$/.test(f)).sort();
const bakeoff = JSON.parse(fs.readFileSync('eval/results/' + files[files.length - 1], 'utf8'));
console.log(JSON.stringify(bakeoff, null, 2));
"
cat eval/results/*-bakeoff.md
```

Expected: both arms' `composite` values are plausible numbers roughly in `[0, 1]`, `simplicity.penalty` is `0` for `grep-first` and a positive number for `full-cov-hybrid`, `verdict.winner` is one of the two contender names, and the `.md` file renders a readable report with the same numbers.

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (baseline 809 from Task 1 + 7 new from this task = 816).

- [ ] **Step 9: Commit**

```bash
git add eval/score/build-bakeoff.ts test/eval/build-bakeoff.test.ts package.json eval/results/*-runs.json eval/results/*-scorecard.json eval/results/*-bakeoff.json eval/results/*-bakeoff.md
git commit -m "feat(eval): bake-off composite assembly + verdict — pnpm eval:bakeoff"
```

---

## Post-plan note for the next plan

This plan produces the actual Stage 1 verdict. Stage 2 (holistic remediation
toward the winner, spec §5) is explicitly scoped only after this verdict is
in hand, and is not part of this plan.
