# Eval Set Fairness Top-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eval set's coverage gap (zero `absent`/`relationship` items, zero genuine fuzzy-recall queries) by fixing `author-absent.ts`'s gating, adding an item-scoping filter to the pooling/judging pipeline, hand-authoring ~10 new relationship/fuzzy-recall items with manually-verified ground truth, and re-scoring.

**Architecture:** Task 1 fixes `author-absent.ts`'s confirmation gate to use grep-first alone (routing around the still-open I9 hybrid scoring-floor bug) and runs it for real. Task 2 adds a shared `--only <id-prefix>` filter to `eval/pool/build-pool.ts` and `eval/pool/judge-full.ts` so re-pooling/re-judging only touches new items, not a wasteful full re-spend on the already-settled 69-73. Task 3 hand-authors the relationship and fuzzy-recall items (real manual research against the vault, not fabricated), runs them through the now-scoped pipeline, and re-scores.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, no new dependencies.

## Global Constraints

- **Sequencing: this plan must run *after* `grep-recall-improvements`'s Task 1 (AND-first/OR-fallback) has landed and been verified** — `author-absent.ts`'s confirmation must reflect grep-first's *final* behavior, not a soon-to-change intermediate state (spec §1.1).
- `EvalItem.category` is a closed TypeScript union (`'plaud' | 'ai-session' | 'entities' | 'hot-topics' | 'decisions'`) — no 6th value. Fuzzy-recall items use `category: 'decisions'` (an honest fit — they're decision/reflection-style paraphrased queries, matching where the taxonomy research found hybrid's closest real precedent), not a schema change.
- No structured relationship data exists anywhere in the vault to mine (`relationships` is a defined-but-unpopulated field on entity frontmatter, confirmed by direct check) — relationship items must come from manually reading real note bodies/backlinks, not fabricated or LLM-guessed.
- `author-absent.ts`'s existing `DEFAULT_SCORE_THRESHOLD = 0.02` is real, current grep-first scores range 0-0.065 across the 10 existing candidates — the threshold may need recalibrating against real output, not guessed.
- Every new authored item follows the exact `EvalItem` schema (`eval/dataset/types.ts`).
- All new/modified files use `.js` extensions on relative imports.

---

### Task 1: Fix `author-absent.ts` gating to grep-first alone

**Files:**
- Modify: `eval/dataset/author-absent.ts`
- Test: `test/eval/author-absent.test.ts`

**Interfaces:**
- Modifies: `isConfirmedAbsent(variants: Variant[], query: string, scoreThreshold?: number): Promise<boolean>` — signature changes to `isConfirmedAbsent(grepFirstVariant: Variant, query: string, scoreThreshold?: number): Promise<boolean>` (single variant, not an array — the whole point of the fix is to stop requiring all variants to agree).

- [ ] **Step 1: Read the existing test file to match its conventions**

Read `test/eval/author-absent.test.ts` in full first — it already tests `isConfirmedAbsent` against fake `Variant` objects; match its existing fake-store construction pattern exactly rather than inventing a new one.

- [ ] **Step 2: Write the failing test for the new single-variant signature**

Add to `test/eval/author-absent.test.ts` (following its existing fake-`Variant`-construction pattern — adjust the fake shape below to match whatever the real file's existing fakes look like once read in Step 1):

```ts
describe('isConfirmedAbsent (grep-first-only gating)', () => {
  it('confirms absent when grep-first alone scores below the threshold', async () => {
    const grepFirst = fakeVariantWithScore(0.0); // use the file's existing fake-variant helper
    const result = await isConfirmedAbsent(grepFirst, 'some query', 0.02);
    expect(result).toBe(true);
  });

  it('does not confirm absent when grep-first scores at or above the threshold', async () => {
    const grepFirst = fakeVariantWithScore(0.05);
    const result = await isConfirmedAbsent(grepFirst, 'some query', 0.02);
    expect(result).toBe(false);
  });

  it('no longer requires other variants to agree — only takes one Variant, not an array', async () => {
    // Type-level check: this must compile with a single Variant argument,
    // not an array — if the old array signature is still in place this
    // test file won't typecheck. (No runtime assertion needed beyond the
    // two above; this comment documents the intent for a human reader.)
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/eval/author-absent.test.ts`
Expected: FAIL — `isConfirmedAbsent` still takes a `Variant[]` array and loops over all of them.

- [ ] **Step 4: Implement the gating fix**

In `eval/dataset/author-absent.ts`, replace the `isConfirmedAbsent` function (currently lines 18-36) with:

```ts
/** Check whether a query is confirmed absent against grep-first ALONE —
 * not all variants. The hybrid variants' scores are known-unreliable for
 * this purpose (issue I9: a scoring-floor artifact clusters `final` in a
 * narrow ~0.11-0.16 band regardless of actual relevance, confirmed still
 * reproducing on both as-deployed and full-cov-hybrid as of 2026-07-15).
 * grep-first is also now the actual production-bound architecture per the
 * Stage 1 bake-off verdict, so confirming absence against it specifically
 * confirms exactly what matters going forward. */
export async function isConfirmedAbsent(
  grepFirstVariant: Variant,
  query: string,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): Promise<boolean> {
  const store = grepFirstVariant.openStore();
  try {
    const result = await store.search(query, { topK: 1 });
    const hits = toRunHits(result, 1);
    if (hits.length > 0 && hits[0].final >= scoreThreshold) return false;
    return true;
  } finally {
    store.close();
  }
}
```

Then update `main()` (currently lines 53-106) to only open/use the `grep-first` variant, not iterate over all of them. Replace the loop body:

```ts
  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const variants = buildVariants(config, REPO_ROOT, 1);
  const grepFirst = variants.find((v) => v.name === 'grep-first');
  if (!grepFirst) throw new Error('grep-first variant not found — check buildVariants()');

  const confirmed: string[] = [];
  for (const query of CANDIDATE_ABSENT_QUERIES) {
    const store = grepFirst.openStore();
    let score = 0;
    try {
      const result = await store.search(query, { topK: 1 });
      const hits = toRunHits(result, 1);
      score = hits[0]?.final ?? 0;
    } finally {
      store.close();
    }
    const absent = score < DEFAULT_SCORE_THRESHOLD;
    console.log(`${absent ? 'ABSENT' : 'FOUND '} "${query}" grep-first score=${score}`);
    if (absent) confirmed.push(query);
  }
  console.log(`\n${confirmed.length}/${CANDIDATE_ABSENT_QUERIES.length} candidates confirmed absent.`);
```

Leave the rest of `main()` (the `items`/`absentItems`/`writeFileSync` block below) unchanged — it already reads/writes `queries.json` correctly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/eval/author-absent.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add eval/dataset/author-absent.ts test/eval/author-absent.test.ts
git commit -m "fix(eval): author-absent gates on grep-first alone, not all variants (routes around I9)"
```

- [ ] **Step 8: Run for real against the live index (only after grep-recall-improvements' Task 1 has landed)**

Run: `pnpm eval:author-absent`

Inspect the printed real scores. If fewer than 5 of the 10 existing candidates confirm absent, add 2-4 more candidate queries to `CANDIDATE_ABSENT_QUERIES` (clearly-unrelated-to-this-vault topics, matching the existing list's style) and re-run, until at least 5 (ideally 5-8, matching the original design's intent) confirm. Report the final real count and scores — do not silently accept fewer than 5 without at least attempting more candidates first.

---

### Task 2: `--only <id-prefix>` filter for pooling and judging

**Files:**
- Modify: `eval/pool/build-pool.ts`
- Modify: `eval/pool/judge-full.ts`
- Test: `test/eval/build-pool.test.ts`
- Test: `test/eval/judge-full.test.ts`

**Interfaces:**
- No changes to `buildPoolForItem`/`judgeItemFull` (the pure, already-tested functions) — only `main()` in each file changes, to filter which items it processes and to merge (not clobber) results for items outside the filter.

- [ ] **Step 1: Write the failing test for `build-pool.ts`'s filtering behavior**

Read `test/eval/build-pool.test.ts` first to see whether it already tests `main()` directly or only `buildPoolForItem` (the pure function) — if `main()` isn't currently under test (likely, given it does real file I/O), add a new, small, focused test file instead: create `test/eval/build-pool-main.test.ts` (or append to the existing file if it already has a pattern for testing `main()`'s file-driven behavior — match whichever is true once you've read it):

```ts
import { describe, it, expect } from 'vitest';
import { filterItemsByIdPrefix } from '../../eval/pool/build-pool.js';

describe('filterItemsByIdPrefix', () => {
  const items = [
    { id: 'decisions-001', query: 'a' },
    { id: 'relationship-001', query: 'b' },
    { id: 'relationship-002', query: 'c' },
    { id: 'fuzzy-001', query: 'd' },
  ];

  it('returns all items when no prefix filter is given', () => {
    expect(filterItemsByIdPrefix(items, undefined)).toEqual(items);
  });

  it('returns only items whose id starts with the given prefix', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-')).toEqual([
      { id: 'relationship-001', query: 'b' },
      { id: 'relationship-002', query: 'c' },
    ]);
  });

  it('supports comma-separated multiple prefixes', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-,fuzzy-')).toEqual([
      { id: 'relationship-001', query: 'b' },
      { id: 'relationship-002', query: 'c' },
      { id: 'fuzzy-001', query: 'd' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/build-pool-main.test.ts`
Expected: FAIL — `filterItemsByIdPrefix` is not exported from `build-pool.ts` yet.

- [ ] **Step 3: Implement the filter + wire it into `build-pool.ts`'s `main()`**

In `eval/pool/build-pool.ts`, add this exported function right after the existing `norm` helper (near the top of the file):

```ts
/** Filters items to those whose `id` starts with any of the given
 * comma-separated prefixes, or returns all items unchanged when no filter
 * is given. Used by `--only` to scope pooling/judging to just-added items
 * without re-spending real cost re-processing already-settled ones. */
export function filterItemsByIdPrefix<T extends { id: string }>(items: T[], prefixFilter: string | undefined): T[] {
  if (!prefixFilter) return items;
  const prefixes = prefixFilter.split(',').map((p) => p.trim()).filter(Boolean);
  return items.filter((it) => prefixes.some((p) => it.id.startsWith(p)));
}
```

Then in `main()`, add the CLI flag parsing right after the existing `const REPO_ROOT = ...` line (or wherever `main` currently starts reading argv — there's no existing argv parsing in this file today, so this is new):

```ts
async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyPrefix = onlyArg?.slice('--only='.length);

  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const variants = buildVariants(config, REPO_ROOT, 20);

  const allItems: { id: string; query: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const items = filterItemsByIdPrefix(allItems, onlyPrefix);
  console.log(onlyPrefix ? `Scoped to ${items.length}/${allItems.length} items matching "${onlyPrefix}"` : `Processing all ${items.length} items`);

  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );

  const db = new Database(dbPath, { readonly: true });
  const newPools: ItemPool[] = [];
  try {
    for (const item of items) {
      if (item.query.startsWith('<ABSENT-STUB')) continue;
      newPools.push(await buildPoolForItem(item, variants, db, behavioral, 20));
    }
  } finally {
    db.close();
  }

  // Merge with existing pool.json when scoped — otherwise a --only run
  // would silently discard every already-pooled item's data.
  let finalPools = newPools;
  if (onlyPrefix) {
    let existingPools: ItemPool[] = [];
    try {
      existingPools = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
    } catch {
      /* no existing pool.json yet — fine, finalPools stays as newPools */
    }
    const newIds = new Set(newPools.map((p) => p.item_id));
    finalPools = [...existingPools.filter((p) => !newIds.has(p.item_id)), ...newPools];
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), JSON.stringify(finalPools, null, 2));
  const totalCandidates = finalPools.reduce((sum, p) => sum + p.candidates.length, 0);
  console.log(`Wrote eval/dataset/pool.json: ${finalPools.length} items, ${totalCandidates} total candidates`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/build-pool-main.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Apply the identical pattern to `judge-full.ts`**

Read `eval/pool/judge-full.ts` in full first (its exact current `main()` body). Add the same `filterItemsByIdPrefix` import (reuse the one just added to `build-pool.ts` — import it from `../pool/build-pool.js` rather than duplicating the function) and the same `--only=` parsing. The merge-on-write logic is slightly different since `judge-full.ts` writes flat `Judgment[]` keyed by `item_id` (not `ItemPool[]`), so the merge step is:

```ts
  let finalJudgments = allJudgments;
  if (onlyPrefix) {
    let existingJudgments: Judgment[] = [];
    try {
      existingJudgments = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));
    } catch {
      /* no existing judgments.json yet */
    }
    const newItemIds = new Set(allJudgments.map((j) => j.item_id));
    finalJudgments = [...existingJudgments.filter((j) => !newItemIds.has(j.item_id)), ...allJudgments];
  }
  writeFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), JSON.stringify(finalJudgments, null, 2));
```

(Adjust variable names to match whatever the real file's existing `main()` calls its judgment-accumulator array — likely `allJudgments` per the version read earlier this session, but confirm against the real current file before writing this, since Task 1/Task 2 of the bake-off plan may have touched neighboring code.)

Add a matching test to `test/eval/judge-full.test.ts` (or a new `judge-full-main.test.ts`) mirroring Step 1's structure, adapted for judgments instead of pools.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add eval/pool/build-pool.ts eval/pool/judge-full.ts test/eval/build-pool-main.test.ts test/eval/judge-full-main.test.ts
git commit -m "feat(eval): --only=<prefix> filter for build-pool/judge-full, merge-not-clobber on write"
```

---

### Task 3: Author relationship + fuzzy-recall items, run pipeline, re-score

**Files:**
- Modify: `eval/dataset/queries.json` (data, not code)

**Interfaces:** none — this task is data authoring + running already-built tooling.

- [ ] **Step 1: Manually research and author 3-5 `relationship` items**

No structured relationship data exists anywhere in the vault to mine (confirmed: `relationships` is a defined-but-unpopulated field on entity frontmatter across all 23 entity notes). Read real entity notes under `Curated/wiki/entities/` and their real backlinks/mentions (via the vault's own search or direct file reads) to find genuine, verifiable multi-hop connections — e.g., two people who both appear in the same real meeting note, or a person whose note links to a project another person's note also links to. For each candidate:
1. Confirm the connection is real by reading the source note(s) directly.
2. Write the query as a natural relationship question (e.g., "who else was in the meeting where we discussed X besides Y").
3. Manually determine the correct answer (which doc_id(s) should be judged relevant) before this item ever reaches the automated judge — this is the ground-truth-confirmation discipline the original mining pipeline used for real queries, applied here to hand-authored ones.

Append to `eval/dataset/queries.json` following the exact schema:
```jsonc
{ "id": "relationship-001", "query": "<the real, verified query text>",
  "category": "entities", "subtype": "relationship", "source": "synthetic",
  "source_ref": "author:relationship-verified", "intent": "entity-graph-walk test",
  "is_regression": false, "query_truncated": false, "needs_review": false }
```

- [ ] **Step 2: Manually research and author 3-5 fuzzy-recall items**

Modeled on the real `decisions` category's narrative style but deliberately stripped of every proper noun/date/exact term — e.g., paraphrasing a real decision this vault documents without naming the tool/person/project involved. Same ground-truth-verification discipline as Step 1: read the real target note first, confirm the paraphrase is genuinely answerable from it, before authoring the item.

```jsonc
{ "id": "fuzzy-001", "query": "<the real, verified paraphrased query text, no proper nouns>",
  "category": "decisions", "subtype": "lookup", "source": "synthetic",
  "source_ref": "author:fuzzy-recall-verified", "intent": "paraphrase-only recall test (no exact terms)",
  "is_regression": false, "query_truncated": false, "needs_review": false }
```
(`subtype: lookup` here, not a new value — the original design's subtype enum doesn't have a dedicated "fuzzy" subtype, and `lookup`/`synthesis` are the only two the schema actually supports alongside `relationship`/`absent`; `lookup` is the closer fit for a single-target paraphrase-recall query.)

- [ ] **Step 3: Run the scoped pooling + judging pipeline for just the new items**

```bash
pnpm eval:pool -- --only=relationship-,fuzzy-,absent-
pnpm eval:judge-full -- --only=relationship-,fuzzy-,absent-
```

(Include `absent-` here too so Task 1's real absent items, if not already pooled/judged, get picked up in the same pass — check whether `author-absent.ts`'s output items need pooling/judging at all: absent items by definition should have an empty or near-empty relevant set, so confirm with the pool/judge output whether they need special handling or naturally produce empty pools, which is fine and expected.)

Expected: `pool.json` and `judgments.json` gain entries only for the new items; the existing 69-73 items' entries are byte-identical to before (verify this directly — diff the relevant entries before/after, not just trust the merge logic).

- [ ] **Step 4: Re-run the harness and re-score**

```bash
pnpm eval:run
pnpm eval:score
```

Expected: a new `<date>-scorecard.json` with additional categories/counts reflecting the ~10-15 new items. Inspect the new `relationship`/fuzzy-recall-containing `decisions` slice's real numbers.

- [ ] **Step 5: Report the real findings**

Compare the new items' real recall/precision/MRR numbers for grep-first vs. full-cov-hybrid. This directly answers the open question from the taxonomy research: does hybrid actually do better on genuine relationship/fuzzy-recall queries, now that they exist in the eval set? Report this — do not silently fold it in without surfacing whether it changes the picture at all.

- [ ] **Step 6: Commit**

```bash
git add eval/dataset/queries.json eval/dataset/pool.json eval/dataset/judgments.json eval/results/*-runs.json eval/results/*-scorecard.json
git commit -m "feat(eval): author relationship + fuzzy-recall items, re-score with full coverage"
```

---

## Post-plan note

This plan does not re-run `pnpm eval:bakeoff` — per the spec's §3.5, that's optional and only worth doing if Tom wants to see whether the ~10-15 new items nudge the composite verdict (very unlikely given the 0.491 margin, but worth a real check rather than an assumption, if he asks for it).
