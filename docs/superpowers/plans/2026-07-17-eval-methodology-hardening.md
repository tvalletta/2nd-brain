# Eval Methodology Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two real bugs found by the 2026-07-17 bake-off re-run (an OR-fallback latency cliff, three layout-scope bugs), expand the fuzzy-recall/relationship eval categories via bounded real research, disclose a known calibration limitation, add bootstrap confidence intervals and a composite-weight sensitivity check to the bake-off report, then re-run the full pipeline for final, scrutiny-ready numbers.

**Architecture:** Tasks 1-3 are independent code fixes (stopword filtering, entity-merge layout bug, FTS-rebuild scope bug). Task 4 is a bounded manual research-and-authoring pass adding new eval items. Task 5 is a documentation-only change. Tasks 6-7 extend `eval/score/build-bakeoff.ts` with new reporting capabilities. Task 8 re-runs the real pipeline end to end.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest, existing `eval/` harness (`tsx`-run scripts), no new dependencies.

## Global Constraints

- All new/modified files use `.js` extensions on relative imports.
- `queries.json`'s `EvalItem` schema is unchanged by this plan except for new entries following the exact existing shape (`eval/dataset/types.ts`).
- `fuzzy-*` items cannot be filtered by `subtype` (confirmed: `subtype: 'lookup'` is shared with other, non-fuzzy `decisions` items) — always filter by `id.startsWith('fuzzy-')` / `id.startsWith('relationship-')`.
- `buildEntityIndex(vault, layout: VaultLayout = DEFAULT_LAYOUT)` (`src/ingest/entity-resolver.ts:42-45`) already accepts an optional `layout` parameter — the bug is call sites not passing it, not the function itself.
- A repo-wide grep found **8 total call sites** of `buildEntityIndex(vault)` without a `layout` argument (only `src/compilation/compiler.ts:49` passes it correctly). This plan fixes only the 2 call sites directly implicated in the real Bryan Pino/pino repro (`src/bin/karpathy.ts`'s `mergeCommand`, `src/compilation/entity-merger.ts`'s own internal `buildEntityIndex(vault)` call at line 244) — the other 6 (`src/intelligence/topic-refresh.ts:228`, `src/agent/tools/resolve-entity.ts:28`, `src/agent/tools/create-entity.ts:38`, `src/maintenance/lint.ts:79`, `src/jobs/handlers/link-concepts.ts:35`, `src/compilation/cross-linker.ts:32`) are a real, latent, same-shaped bug but out of scope for this plan — do not fix them here, flag them to Tom as a separate follow-up when this plan is reported done.
- Real current eval script names (`package.json`): `eval:pool` → `tsx eval/pool/build-pool.ts`, `eval:judge-full` → `tsx eval/pool/judge-full.ts`, `eval:run` → `tsx eval/run/run-harness.ts`, `eval:score` → `tsx eval/score/build-scorecard.ts`, `eval:bakeoff` → `tsx eval/score/build-bakeoff.ts`.
- Long-running eval commands (`eval:pool`, `eval:judge-full`, `eval:run`) have repeatedly been silently auto-backgrounded and killed mid-run in this project — always verify real completion via output file mtime/content, never by command return alone.

---

### Task 1: OR-fallback stopword filtering

**Files:**
- Modify: `src/search/fts-index.ts`
- Test: `test/search/fts-index.test.ts`

**Interfaces:**
- `sanitizeFtsQueryOr(query: string): string` — signature unchanged, only its internal token-filtering behavior changes.

- [ ] **Step 1: Write the failing test**

Read `test/search/fts-index.test.ts` first to match its existing test structure for `sanitizeFtsQueryOr` (added in the grep-recall-improvements plan). Add:

```ts
describe('sanitizeFtsQueryOr stopword filtering', () => {
  it('filters common English stopwords out of the OR-joined query', () => {
    const result = sanitizeFtsQueryOr('that meeting where we went back and forth on trust');
    // "that", "where", "we", "and", "on" are stopwords; "meeting", "went",
    // "back", "forth", "trust" are not.
    expect(result).toBe('"meeting" OR "went" OR "back" OR "forth" OR "trust"');
  });

  it('falls back to the unfiltered token list if every token is a stopword', () => {
    const result = sanitizeFtsQueryOr('the and or but');
    expect(result).toBe('"the" OR "and" OR "or" OR "but"');
  });

  it('returns an empty string for an empty query, same as before', () => {
    expect(sanitizeFtsQueryOr('   ')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/search/fts-index.test.ts -t "stopword filtering"`
Expected: FAIL — `sanitizeFtsQueryOr` currently OR-joins every token including stopwords, so the first test's expected output won't match.

- [ ] **Step 3: Implement the stopword filter**

In `src/search/fts-index.ts`, add a module-level constant right before `sanitizeFtsQueryOr` (currently at line 331):

```ts
// A short, standard English stopword list. Filtering these out of the
// OR-fallback path avoids unioning enormous FTS5 posting lists for common
// words on long natural-language queries — a 30+ word paraphrase-only
// query previously took ~58-61 seconds identically across every search
// variant sharing this FTS layer, traced to exactly this (found via the
// 2026-07-17 bake-off re-run's fuzzy-recall latency data).
const OR_FALLBACK_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or',
  'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);
```

Replace `sanitizeFtsQueryOr` (currently lines 331-338):

```ts
export function sanitizeFtsQueryOr(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';

  const filtered = tokens.filter((t) => !OR_FALLBACK_STOPWORDS.has(t.toLowerCase()));
  // If filtering stopwords would leave nothing (e.g. a query that happens
  // to be entirely stopwords), fall back to the unfiltered list rather
  // than returning an empty query — that would incorrectly trigger
  // querySnippet's "no OR query" branch for a query that does have real
  // (if all-common) words.
  const finalTokens = filtered.length > 0 ? filtered : tokens;

  return finalTokens.map((t) => `"${t}"`).join(' OR ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/search/fts-index.test.ts -t "stopword filtering"`
Expected: PASS

- [ ] **Step 5: Run the full fts-index test suite to check for regressions**

Run: `npx vitest run test/search/fts-index.test.ts test/search/hybrid-store.test.ts`
Expected: all pass — any existing OR-fallback test that used a query containing stopwords may need its expected token list updated to match the new filtered behavior; read any failures and fix the expected values (recompute by hand from the stopword list above, don't guess).

- [ ] **Step 6: Real before/after latency verification**

Run the same 5 real `fuzzy-*` queries from `eval/dataset/queries.json` directly against the live vault (reuse the pattern established in prior real-verification steps this project: `buildVariants(config, REPO_ROOT, 1)`, loop the 5 queries, time `store.search(query, {topK: 10})` for each, per variant). Expected: the previously-measured ~58-61s outlier (whichever item it was — check `eval/results/2026-07-17-runs.json` for the exact slowest item and its latency) now completes in a time comparable to the rest of the dataset (target: well under 5s, ideally under 1s). Also confirm each of the 5 items' top-10 hit set is unchanged from before the fix (stopword filtering should only prune near-useless terms from the OR union — it must not change which real documents match). Report the real before/after numbers.

- [ ] **Step 7: Commit**

```bash
git add src/search/fts-index.ts test/search/fts-index.test.ts
git commit -m "fix(search): filter stopwords from OR-fallback to prevent pathological query cost"
```

---

### Task 2: Fix entity-merge layout-scope bugs

**Files:**
- Modify: `src/bin/karpathy.ts`
- Modify: `src/compilation/entity-merger.ts`
- Test: `test/compilation/entity-merger.test.ts`

**Interfaces:**
- `mergeEntities(sourcePath: string, targetPath: string, vault: VaultAdapter, layout?: VaultLayout): Promise<MergeResult>` — gains an optional 4th parameter, defaulting to `DEFAULT_LAYOUT` (backward compatible with existing callers that don't pass it).
- `rewriteWikilinks` (private to `entity-merger.ts`) gains the same optional `layout` parameter, used internally by `mergeEntities`.

- [ ] **Step 1: Write the failing test**

Read `test/compilation/entity-merger.test.ts` first to match its existing fixture conventions (likely a fake/in-memory `VaultAdapter`, real note fixtures). Add:

```ts
describe('mergeEntities with a non-default layout', () => {
  it('finds and rewrites wikilinks under a custom wiki content folder, not the DEFAULT_LAYOUT default', async () => {
    const customLayout: VaultLayout = {
      ...DEFAULT_LAYOUT,
      wiki: 'Curated/wiki',
    };
    // Fixture vault with entity notes under Curated/wiki/entities/ (NOT the
    // default wiki/entities/) and a third note under Curated/wiki/decisions/
    // that contains a [[source-entity]] wikilink to rewrite.
    const vault = fakeVaultWith({
      'Curated/wiki/entities/source-entity.md': '---\ncanonical_name: Source Entity\n---\nBody.',
      'Curated/wiki/entities/target-entity.md': '---\ncanonical_name: Target Entity\n---\nBody.',
      'Curated/wiki/decisions/some-decision.md': '---\ntitle: Some Decision\n---\nSee [[source-entity]] for context.',
    });

    const result = await mergeEntities(
      'Curated/wiki/entities/source-entity.md',
      'Curated/wiki/entities/target-entity.md',
      vault,
      customLayout,
    );

    expect(result.wikilinksRewritten).toBe(1);
    const decisionContent = await vault.read('Curated/wiki/decisions/some-decision.md');
    expect(decisionContent).toContain('[[target-entity]]');
    expect(decisionContent).not.toContain('[[source-entity]]');
  });
});
```

(Match `fakeVaultWith`/equivalent to whatever the test file's real existing fixture helper is named — read the file first.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/compilation/entity-merger.test.ts -t "non-default layout"`
Expected: FAIL — `mergeEntities` doesn't accept a 4th `layout` argument yet (TypeScript error or the wikilink rewrite silently scanning the wrong, default folders and finding 0 links to rewrite).

- [ ] **Step 3: Thread `layout` through `mergeEntities` and `rewriteWikilinks`**

In `src/compilation/entity-merger.ts`, add the import (alongside the existing `WIKI_CONTENT_FOLDERS` import at line 7):

```ts
import { wikiContentFolders } from '../vault/paths.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
```

(Combine into the existing import line from `../vault/paths.js` if `DEFAULT_LAYOUT`/`VaultLayout` aren't already imported there — check first. Remove the now-unused `WIKI_CONTENT_FOLDERS` import only if nothing else in this file still uses it — grep the file to confirm before removing.)

Change `mergeEntities`'s signature (currently `src/compilation/entity-merger.ts:29-33`):

```ts
export async function mergeEntities(
  sourcePath: string,
  targetPath: string,
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<MergeResult> {
```

Find the call to `rewriteWikilinks` inside `mergeEntities` (near the end of the function, per the spec's reference to "the real, currently-deployed indexing scope" section) and pass `layout` through:

```ts
  const wikilinksRewritten = await rewriteWikilinks(vault, sourceSlug, targetSlug, layout);
```

Change `rewriteWikilinks`'s signature (currently lines 171-175):

```ts
async function rewriteWikilinks(
  vault: VaultAdapter,
  sourceSlug: string,
  targetSlug: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  let total = 0;

  const folders = wikiContentFolders(layout);
```

(Replacing the current `const folders = WIKI_CONTENT_FOLDERS;` at line 178.)

- [ ] **Step 4: Fix the internal `buildEntityIndex(vault)` call in this same file**

`entity-merger.ts` has its own internal call to `buildEntityIndex(vault)` (line 244, inside whatever function it's in — read the surrounding function to find its own `layout` parameter, or thread one through the same way if it doesn't have one yet). Change it to pass `layout` (matching whatever this function's own signature ends up needing — if this function is called by `mergeCommand`'s `--detect`/`--auto` paths, thread `layout` through those call chains too, following the exact same pattern as Step 3).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/compilation/entity-merger.test.ts -t "non-default layout"`
Expected: PASS

- [ ] **Step 6: Fix the `mergeCommand` call site in `karpathy.ts`**

In `src/bin/karpathy.ts`, change line 1022 (currently `const index = await buildEntityIndex(vault);`) to:

```ts
  const index = await buildEntityIndex(vault, config.layout);
```

Also update the call to `mergeEntities` inside `mergeCommand` (find it further down in the function, after path resolution) to pass `config.layout` as the 4th argument, matching Task 2 Step 3's new signature.

- [ ] **Step 7: Run the full entity-merger and karpathy CLI test suites**

Run: `npx vitest run test/compilation/entity-merger.test.ts test/bin/`
Expected: all pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/bin/karpathy.ts src/compilation/entity-merger.ts test/compilation/entity-merger.test.ts
git commit -m "fix(entity-merger): thread real vault layout through merge + wikilink rewrite, not DEFAULT_LAYOUT"
```

---

### Task 3: Fix rebuild-fts-tokenizer's CLI scope

**Files:**
- Modify: `src/bin/karpathy.ts`
- Test: `test/maintenance/rebuild-fts-tokenizer.test.ts` (if this CLI-level scope is covered there) or a new focused test

**Interfaces:**
- No function signature changes — this is a single constant-value fix at the CLI call site.

- [ ] **Step 1: Confirm the real bug directly**

Read `src/bin/karpathy.ts` around line 1634. Confirm the current line reads:

```ts
const vaultDirs = [config.layout.wiki, config.layout.aiSummaries, config.layout.sources, config.layout.review];
```

This 4-folder scope caused a real, measured 29.3% row-count drift (23,722 real rows vs. 16,772 rebuilt) when dry-run against the live vault on 2026-07-17, because the real `sync-fts-index` job's full-sync path scans the entire vault root (`['.']`), not these 4 folders specifically.

- [ ] **Step 2: Write the failing test**

Read `test/maintenance/rebuild-fts-tokenizer.test.ts`'s existing tests first (it tests `rebuildFtsWithStemmer`/`swapFtsTable` directly, not the CLI wiring — this bug is specifically in `karpathy.ts`'s CLI handler, which calls those functions with the wrong `vaultDirs`). Since the bug is in a CLI script's local variable, not an exported function, write a small test against the actual `rebuildFtsWithStemmer` function directly, asserting that scanning `['.']` on a fixture vault (with files both inside and outside the 4-folder set) picks up files from outside those 4 folders, while scanning the 4-folder list misses them — proving the real behavioral difference the CLI fix must produce:

```ts
it('scanning vaultDirs=["."] (the fix) covers files outside the 4-folder set that vaultDirs=[wiki,aiSummaries,sources,review] (the bug) misses', async () => {
  // Build a fixture vault with a markdown file under a folder NOT in
  // [layout.wiki, layout.aiSummaries, layout.sources, layout.review] —
  // e.g. a folder mimicking "AI Conversations/claude/" from the real bug
  // report.
  const dir = await mkdtemp(join(tmpdir(), 'karpathy-rebuild-scope-'));
  await mkdir(join(dir, 'AI Conversations', 'claude'), { recursive: true });
  await writeFile(join(dir, 'AI Conversations', 'claude', 'session.md'), '---\ntitle: Session\n---\nBody text here.');
  const db = new Database(join(dir, 'test.sqlite'));
  db.pragma('journal_mode = WAL');

  const buggyScopeResult = await rebuildFtsWithStemmer(db, dir, [
    'wiki', 'AI Conversations/_summaries', 'Curated/sources', 'Curated/review',
  ]);
  expect(buggyScopeResult.newCount).toBe(0);

  const fixedScopeResult = await rebuildFtsWithStemmer(db, dir, ['.']);
  expect(fixedScopeResult.newCount).toBe(1);

  db.close();
  await rm(dir, { recursive: true, force: true });
});
```

(Adjust folder name literals to match this test file's own existing fixture conventions and whatever layout values its other tests already use — read the file first.)

- [ ] **Step 3: Run the test to verify it demonstrates the real gap**

Run: `npx vitest run test/maintenance/rebuild-fts-tokenizer.test.ts -t "vaultDirs"`
Expected: PASS as written (this test doesn't test the CLI's buggy line directly, it demonstrates the real underlying behavioral difference the CLI fix must produce — confirming the fix direction is correct before touching `karpathy.ts`).

- [ ] **Step 4: Fix the CLI**

In `src/bin/karpathy.ts`, change line 1634 from:

```ts
      const vaultDirs = [config.layout.wiki, config.layout.aiSummaries, config.layout.sources, config.layout.review];
```

to:

```ts
      const vaultDirs = ['.'];
```

- [ ] **Step 5: Real dry-run verification against the live vault**

Run the dry-run for real (safe — it only builds and verifies a new table, never swaps):

```bash
npx tsx src/bin/karpathy.ts maintenance --rebuild-fts-tokenizer
```

Expected: the printed row-count drift is now within the existing 5% gate (old count ~23,722, new count should be very close — expect the same ~off-by-one pattern already observed in the 2026-07-17 diagnostic run, i.e. ~23,721). If the drift is still outside 5%, STOP — do not proceed, something else is wrong and needs investigation before this task is considered done. Do NOT run `--confirm` — the actual live swap remains Tom's own action to trigger, per this project's established convention for this specific live-index-mutating operation.

- [ ] **Step 6: Commit**

```bash
git add src/bin/karpathy.ts test/maintenance/rebuild-fts-tokenizer.test.ts
git commit -m "fix(maintenance): rebuild-fts-tokenizer CLI scans the whole vault, matching real sync scope"
```

---

### Task 4: Expand fuzzy-recall and relationship eval items (bounded research)

**Files:**
- Modify: `eval/dataset/queries.json`

**Interfaces:**
- No code interfaces — this is a data-authoring task following the exact `EvalItem` schema already used by `relationship-001..004`/`fuzzy-001..005`.

- [ ] **Step 1: Bounded research pass — relationship candidates**

Read every real entity note under `Curated/wiki/entities/` (the real vault, accessed via the Carpathi MCP tools if available — `mcp__carpathi__get_entity`, `mcp__carpathi__search_entities`, `mcp__carpathi__get_related` — or direct file reads if not) for its `relationships` frontmatter field and any backlinks/cross-references in its body. For every genuine multi-hop connection between 2+ named entities that can be verified by reading the actual source note(s) directly, author a candidate query following the exact pattern of `relationship-001..004` (`category: 'entities'`, `subtype: 'relationship'`, `source: 'synthetic'`, `source_ref: 'author:relationship-authored'`). Stop when every entity note has been read once — this is the bounded scope (per Tom's explicit "as many as genuinely verifiable" choice), not an arbitrary target count. If a candidate's ground truth is ambiguous (e.g. two similarly-named entities that are plausibly but not confirmably the same person, mirroring the exact issue that limited the original set to 4 items), do not include it — document why it was excluded instead.

For every item added, record in a scratch note (not committed, just for your own drafting) which real file(s) you read and what evidence supports the query's ground truth — this becomes part of your task report.

- [ ] **Step 2: Bounded research pass — fuzzy-recall candidates**

Read every real note under `Curated/wiki/decisions/` and `Curated/wiki/concepts/` for content that can be honestly paraphrased with zero proper nouns, dates, or exact terms while still having one clear, defensible, verifiable answer — following the exact pattern of `fuzzy-001..005` (`category: 'decisions'`, `subtype: 'lookup'`, `source: 'synthetic'`, `source_ref: 'author:fuzzy-recall-verified'`, `intent` field describing what's being tested). Stop when every note in both folders has been read once.

- [ ] **Step 3: Append new items to `queries.json`**

Continue the existing numbering (`relationship-005`, `relationship-006`, ... and `fuzzy-006`, `fuzzy-007`, ...). Each item follows the exact schema:

```jsonc
{
  "id": "relationship-005",
  "query": "...",
  "category": "entities",
  "subtype": "relationship",
  "source": "synthetic",
  "source_ref": "author:relationship-authored",
  "intent": "entity-graph-walk test: ...",
  "is_regression": false,
  "query_truncated": false,
  "needs_review": false
}
```

- [ ] **Step 4: Validate the JSON and run the full suite**

```bash
node -e "JSON.parse(require('fs').readFileSync('eval/dataset/queries.json', 'utf-8')); console.log('valid JSON')"
npx vitest run
```

Expected: valid JSON confirmed, all existing tests still pass (this is a data-only change, no code paths should break).

- [ ] **Step 5: Commit**

```bash
git add eval/dataset/queries.json
git commit -m "feat(eval): expand relationship/fuzzy-recall items via bounded real-vault research"
```

Report in your task report exactly how many new items were added per category, with the evidence trail for each (matching the rigor of the original 9 items) — including a real count of "no" — items considered but excluded for insufficient ground truth, if any occurred.

---

### Task 5: Disclose the calibration limitation

**Files:**
- Modify: `eval/dataset/author-absent.ts`
- Modify: `docs/superpowers/ROADMAP.md`

**Interfaces:**
- No code logic changes — doc-comment and markdown content only.

- [ ] **Step 1: Add the disclosure paragraph to `author-absent.ts`**

Read the current doc comment above `DEFAULT_SCORE_THRESHOLD` in `eval/dataset/author-absent.ts` (already contains the recalibration history from 0.02 → 0.1 → 0.95). Append one new paragraph:

```ts
/**
 * ...(existing comment content stays as-is)...
 *
 * KNOWN, ACCEPTED METHODOLOGICAL LIMITATION: this threshold's calibration
 * history above is coupled to this same codebase's own observed scoring
 * behavior across multiple iterations, not derived from an independent
 * standard. This is a disclosed, accepted limitation specific to this
 * absent-item confirmation mechanism — it does not affect the ground truth
 * for the rest of the eval dataset (plaud/ai-session/entities/hot-topics/
 * decisions items are grounded in real usage + manual verification,
 * independent of this threshold). Anyone re-tuning this threshold in the
 * future should treat it as testing self-consistency with the current
 * system, not as an independently-verified absolute standard.
 */
```

- [ ] **Step 2: Add the same disclosure to ROADMAP.md**

Read `docs/superpowers/ROADMAP.md` to find wherever the absent-item confirmation methodology (I9-adjacent material, or the eval-fairness-topup plan's summary) is described. Add one sentence there: "Note: `author-absent.ts`'s score threshold has been recalibrated multiple times against this same system's own observed behavior — a disclosed, accepted limitation, not an independent ground-truth standard."

- [ ] **Step 3: Self-review**

Confirm both locations now state the limitation in plain language a future reader (with no session context) would understand without needing to read the full recalibration history first.

- [ ] **Step 4: Commit**

```bash
git add eval/dataset/author-absent.ts docs/superpowers/ROADMAP.md
git commit -m "docs(eval): disclose author-absent's calibration-against-self-limitation explicitly"
```

---

### Task 6: Bootstrap CIs on the fuzzy-recall/relationship comparison and the composite

**Files:**
- Modify: `eval/score/build-bakeoff.ts`
- Test: `test/eval/build-bakeoff.test.ts`

**Interfaces:**
- `buildBakeoff(input: BakeoffInput): Bakeoff` — the `Bakeoff` interface gains a new optional field: `subtypeSlices?: Array<{ label: string; idPrefix: string; byVariant: Record<string, { recall_ci: [number, number]; precision_ci: [number, number]; mrr_ci: [number, number]; composite_ci: [number, number] }> }>`.

- [ ] **Step 1: Write the failing test**

Read `test/eval/build-bakeoff.test.ts`'s existing fixture conventions (small synthetic `RunResult[]`/`Judgment[]`/`Scorecard` fixtures — read the file first to match the exact shape). Add:

```ts
describe('subtype-scoped bootstrap CIs', () => {
  it('reports recall/precision/mrr CIs for fuzzy-* items separately from the rest of the decisions category', () => {
    // Build a fixture with 5 fuzzy-* items (ids fuzzy-001..005) and 3
    // non-fuzzy decisions items, with distinct known recall values for
    // each group so the two CI computations can be told apart.
    const input = buildFixtureBakeoffInput(); // read the file's existing fixture-builder pattern
    const result = buildBakeoff(input);
    const fuzzySlice = result.subtypeSlices?.find((s) => s.idPrefix === 'fuzzy-');
    expect(fuzzySlice).toBeDefined();
    expect(fuzzySlice!.byVariant['grep-first'].recall_ci).toHaveLength(2);
    // CI bounds must bracket the point estimate.
    const [low, high] = fuzzySlice!.byVariant['grep-first'].recall_ci;
    expect(low).toBeLessThanOrEqual(high);
  });

  it('composite_ci is present and brackets the point-estimate composite for the relationship slice', () => {
    const input = buildFixtureBakeoffInput();
    const result = buildBakeoff(input);
    const relationshipSlice = result.subtypeSlices?.find((s) => s.idPrefix === 'relationship-');
    expect(relationshipSlice).toBeDefined();
    const ci = relationshipSlice!.byVariant['full-cov-hybrid'].composite_ci;
    expect(ci[0]).toBeLessThanOrEqual(ci[1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "subtype-scoped"`
Expected: FAIL — `result.subtypeSlices` is `undefined`, since `buildBakeoff` doesn't compute it yet.

- [ ] **Step 3: Implement subtype-scoped CI computation**

In `eval/score/build-bakeoff.ts`, add the import:

```ts
import { bootstrapCI } from './bootstrap.js';
```

Add a new function, placed after `pooledAccuracyCell`:

```ts
/** Bootstrap 95% CIs for recall/precision/MRR on a single id-prefix slice
 * (e.g. "fuzzy-" or "relationship-") of one contender's results, plus a
 * composite-level CI that only propagates accuracy-side resampling
 * uncertainty — latency/tokens/simplicity sub-scores are held fixed at
 * their point estimates, since they aren't naturally item-resampled
 * quantities the same way per-item recall/precision/MRR are. This is a
 * stated, documented limitation of the composite CI, not a full
 * uncertainty propagation (spec: eval-methodology-hardening-design.md §7.3). */
function subtypeSliceCIs(
  idPrefix: string,
  variantResults: RunResult[],
  relevanceIndex: ReturnType<typeof buildRelevanceIndex>,
  fixedLatSub: number,
  fixedTokSub: number,
  fixedSimSub: number,
): {
  recall_ci: [number, number];
  precision_ci: [number, number];
  mrr_ci: [number, number];
  composite_ci: [number, number];
} {
  const sliceResults = variantResults.filter((r) => r.itemId.startsWith(idPrefix));
  const recalls: number[] = [];
  const precisions: number[] = [];
  const rrs: number[] = [];
  const composites: number[] = [];

  for (const result of sliceResults) {
    const cell = computeCell(10, 'e', 'full-corpus', [result], relevanceIndex);
    recalls.push(cell.recall_at_k.mean);
    precisions.push(cell.precision_at_k.mean);
    rrs.push(cell.mrr.mean);
    const itemAccSub = 0.6 * cell.recall_at_k.mean + 0.25 * cell.precision_at_k.mean + 0.15 * cell.mrr.mean;
    composites.push(0.5 * itemAccSub + 0.2 * fixedLatSub + 0.15 * fixedTokSub + 0.15 * fixedSimSub);
  }

  return {
    recall_ci: bootstrapCI(recalls),
    precision_ci: bootstrapCI(precisions),
    mrr_ci: bootstrapCI(rrs),
    composite_ci: bootstrapCI(composites),
  };
}
```

Inside `buildBakeoff`, after the `arms` array is constructed (right before the `const [a, b] = arms;` line), add:

```ts
  const subtypeSlices = [
    { label: 'fuzzy-recall', idPrefix: 'fuzzy-' },
    { label: 'relationship', idPrefix: 'relationship-' },
  ].map(({ label, idPrefix }) => {
    const byVariant: Record<string, ReturnType<typeof subtypeSliceCIs>> = {};
    for (const name of CONTENDERS) {
      const variantResults = runsResults.filter((r) => r.variant === name);
      const arm = arms.find((a) => a.name === name)!;
      byVariant[name] = subtypeSliceCIs(
        idPrefix,
        variantResults,
        relevanceIndex,
        arm.latency.sub,
        arm.tokens.sub,
        arm.simplicity.sub,
      );
    }
    return { label, idPrefix, byVariant };
  });
```

Add `subtypeSlices` to the returned object (the `return { run: ..., backfill_ledger: ..., arms, verdict, ... }` at the end of `buildBakeoff`):

```ts
  return {
    run: { /* ...unchanged... */ },
    backfill_ledger: { /* ...unchanged... */ },
    arms,
    verdict, // ...unchanged...
    subtypeSlices,
  };
```

Add `subtypeSlices` to the `Bakeoff` interface (near the top of the file, where `Bakeoff` is currently defined):

```ts
export interface Bakeoff {
  run: { date: string; eval_set_version: string; k: number; any_degraded_runs: boolean };
  backfill_ledger: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
  arms: ArmComposite[];
  verdict: BakeoffVerdict;
  subtypeSlices: Array<{
    label: string;
    idPrefix: string;
    byVariant: Record<string, {
      recall_ci: [number, number];
      precision_ci: [number, number];
      mrr_ci: [number, number];
      composite_ci: [number, number];
    }>;
  }>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "subtype-scoped"`
Expected: PASS

- [ ] **Step 5: Extend `renderBakeoffMarkdown` to include the new sections**

Find `renderBakeoffMarkdown` in the same file. After the existing "Composite scores" table section, add:

```ts
  for (const slice of bakeoff.subtypeSlices) {
    lines.push(`## ${slice.label} (subtype-scoped, with 95% CI)`, '');
    lines.push(`| Variant | Recall@10 CI | Precision@10 CI | MRR CI | Composite CI |`);
    lines.push(`|---|---|---|---|---|`);
    for (const [variant, ci] of Object.entries(slice.byVariant)) {
      lines.push(
        `| ${variant} | [${ci.recall_ci[0].toFixed(3)}, ${ci.recall_ci[1].toFixed(3)}] | ` +
        `[${ci.precision_ci[0].toFixed(3)}, ${ci.precision_ci[1].toFixed(3)}] | ` +
        `[${ci.mrr_ci[0].toFixed(3)}, ${ci.mrr_ci[1].toFixed(3)}] | ` +
        `[${ci.composite_ci[0].toFixed(3)}, ${ci.composite_ci[1].toFixed(3)}] |`,
      );
    }
    lines.push('');
  }
  lines.push(
    `_Composite CIs only propagate accuracy-side resampling uncertainty — ` +
    `latency/tokens/simplicity sub-scores are held fixed at their point estimates ` +
    `for this computation (see spec §7.3)._`,
    '',
  );
```

- [ ] **Step 6: Run the full eval test suite**

Run: `npx vitest run test/eval/`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add eval/score/build-bakeoff.ts test/eval/build-bakeoff.test.ts
git commit -m "feat(eval): bootstrap CIs on the fuzzy-recall/relationship comparison and composite"
```

---

### Task 7: Composite-weight sensitivity check

**Files:**
- Modify: `eval/score/build-bakeoff.ts`
- Test: `test/eval/build-bakeoff.test.ts`

**Interfaces:**
- `Bakeoff` gains a new field: `weightSensitivity: Array<{ label: string; weights: { accuracy: number; latency: number; tokens: number; simplicity: number }; results: Record<string, { composite: number }>; winner: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
describe('composite-weight sensitivity', () => {
  it('reports the composite winner under 3 alternate weightings alongside the primary', () => {
    const input = buildFixtureBakeoffInput();
    const result = buildBakeoff(input);
    expect(result.weightSensitivity).toHaveLength(3);
    const labels = result.weightSensitivity.map((w) => w.label);
    expect(labels).toEqual(['equal-weight', 'zero-simplicity', 'accuracy-only']);
    // Every scheme must report a composite for both real contenders.
    for (const scheme of result.weightSensitivity) {
      expect(Object.keys(scheme.results)).toEqual(['grep-first', 'full-cov-hybrid']);
    }
  });

  it('accuracy-only weighting produces a composite equal to the accuracy sub-score alone', () => {
    const input = buildFixtureBakeoffInput();
    const result = buildBakeoff(input);
    const accuracyOnly = result.weightSensitivity.find((w) => w.label === 'accuracy-only')!;
    const grepArm = result.arms.find((a) => a.name === 'grep-first')!;
    expect(accuracyOnly.results['grep-first'].composite).toBeCloseTo(grepArm.accuracy.sub, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "weight sensitivity"`
Expected: FAIL — `result.weightSensitivity` is `undefined`.

- [ ] **Step 3: Implement the alternate-weighting computation**

In `eval/score/build-bakeoff.ts`, add a constant near `CONTENDERS`:

```ts
const WEIGHT_SCHEMES: Array<{ label: string; accuracy: number; latency: number; tokens: number; simplicity: number }> = [
  { label: 'equal-weight', accuracy: 0.25, latency: 0.25, tokens: 0.25, simplicity: 0.25 },
  { label: 'zero-simplicity', accuracy: 0.5, latency: 0.3, tokens: 0.2, simplicity: 0 },
  { label: 'accuracy-only', accuracy: 1.0, latency: 0, tokens: 0, simplicity: 0 },
];
```

Inside `buildBakeoff`, after the `subtypeSlices` computation from Task 6, add:

```ts
  const weightSensitivity = WEIGHT_SCHEMES.map((scheme) => {
    const results: Record<string, { composite: number }> = {};
    for (const arm of arms) {
      results[arm.name] = {
        composite:
          scheme.accuracy * arm.accuracy.sub +
          scheme.latency * arm.latency.sub +
          scheme.tokens * arm.tokens.sub +
          scheme.simplicity * arm.simplicity.sub,
      };
    }
    const [nameA, nameB] = CONTENDERS;
    const winner = results[nameA].composite >= results[nameB].composite ? nameA : nameB;
    return { label: scheme.label, weights: scheme, results, winner };
  });
```

Add `weightSensitivity` to the `Bakeoff` interface and the object returned by `buildBakeoff`, matching the pattern from Task 6 Step 3.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval/build-bakeoff.test.ts -t "weight sensitivity"`
Expected: PASS

- [ ] **Step 5: Extend `renderBakeoffMarkdown`**

After the subtype-slices section added in Task 6 Step 5:

```ts
  lines.push(`## Composite-weight sensitivity`, '');
  lines.push(`| Weighting | grep-first | full-cov-hybrid | Winner |`);
  lines.push(`|---|---|---|---|`);
  for (const scheme of bakeoff.weightSensitivity) {
    const [nameA, nameB] = ['grep-first', 'full-cov-hybrid'] as const;
    lines.push(
      `| ${scheme.label} | ${scheme.results[nameA].composite.toFixed(3)} | ` +
      `${scheme.results[nameB].composite.toFixed(3)} | ${scheme.winner} |`,
    );
  }
  const allGrepWins = bakeoff.weightSensitivity.every((s) => s.winner === 'grep-first');
  lines.push(
    '',
    allGrepWins
      ? '**grep-first wins under every tested weighting scheme, including the primary — the verdict is not an artifact of the specific 0.50/0.20/0.15/0.15 weights.**'
      : '**grep-first does NOT win under every tested weighting scheme — the verdict is sensitive to weighting choice; see the table above for which schemes flip it.**',
    '',
  );
```

- [ ] **Step 6: Run the full eval test suite**

Run: `npx vitest run test/eval/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add eval/score/build-bakeoff.ts test/eval/build-bakeoff.test.ts
git commit -m "feat(eval): composite-weight sensitivity check (equal/zero-simplicity/accuracy-only)"
```

---

### Task 8: Final re-verification run

**Files:**
- None modified — this is a real-execution task producing new dated output files under `eval/results/`.

- [ ] **Step 1: Pool the newly-added items**

```bash
pnpm eval:pool -- --only=relationship,fuzzy
```

Run as a genuine blocking call. Verify real completion via `eval/dataset/pool.json`'s mtime and entry count (should now include every item added in Task 4, on top of the 82 already there) — do not trust command return alone.

- [ ] **Step 2: Judge the newly-added items**

```bash
pnpm eval:judge-full -- --only=relationship,fuzzy
```

Same verification discipline — check `eval/dataset/judgments.json`'s mtime and unique `item_id` count.

- [ ] **Step 3: Re-run the full harness**

```bash
pnpm eval:run
```

This is the longest step (expect 20-40+ minutes given real Ollama/Bedrock calls across the now-larger item set × 3 variants). Verify real completion via the new `eval/results/<today>-runs.json` file's existence, mtime, and size.

- [ ] **Step 4: Re-score**

```bash
pnpm eval:score
```

Verify via the new `eval/results/<today>-scorecard.json`.

- [ ] **Step 5: Re-run the bake-off**

```bash
pnpm eval:bakeoff
```

Verify via the new `eval/results/<today>-bakeoff.json`/`.md` — confirm the new `.md` output actually contains the subtype-scoped CI sections (Task 6) and the weight-sensitivity table (Task 7), not just the original composite table, since this is the first real run exercising that new code.

- [ ] **Step 6: Report the real final numbers**

In your task report: the composite verdict (winner, margin), the fuzzy-recall/relationship CIs (do they overlap between grep-first and hybrid, or not?), the weight-sensitivity table (does grep-first win under every scheme?), and how these compare to the 2026-07-17 pre-hardening numbers. Report honestly — do not editorialize if the CIs turn out to overlap substantially or if a weighting scheme flips the verdict; that's real, important information, not a failure of this task.
