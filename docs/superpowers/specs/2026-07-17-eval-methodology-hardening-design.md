# Eval Methodology Hardening — Design

**Date:** 2026-07-17
**Status:** Approved design
**Depends on:** grep-recall-improvements, eval-fairness-topup, semantic-latency-fallback (all merged to `main`); the 2026-07-17 real re-verification bake-off
**Track:** B, Stage 3 — closing the methodological gaps a peer-review self-critique surfaced in the 2026-07-17 re-run

## 1. Problem statement

The 2026-07-17 real bake-off re-run confirmed grep-first still wins (composite 0.705 vs full-cov-hybrid's 0.330, margin 0.375, all 5 categories), and found a genuine capability signal favoring semantic search specifically on `fuzzy-recall` (n=5) and `relationship` (n=4) items. A subsequent self-critique — treated as a real peer-review pass, not a formality — surfaced concrete, fixable weaknesses that should be closed before this comparison is called conclusive:

1. **Two real, unrelated code bugs**, found as side effects of the re-run, neither yet fixed:
   - The AND-first/OR-fallback FTS5 query relaxation (grep-recall-improvements) has no stopword filtering in its OR path. A long, natural-language query (exactly the style `fuzzy-recall` items are designed to use) OR-joins every token including common words, generating a pathological posting-list union — `fuzzy-003` took ~58-61 seconds across all three bake-off variants identically, confirmed as an FTS-layer cost shared by every variant, not a semantic-search cost. This inflated p95 latency for every variant in the 2026-07-17 run.
   - `mergeCommand` (`src/bin/karpathy.ts:1022`) calls `buildEntityIndex(vault)` without its optional second `layout` argument, silently falling back to `DEFAULT_LAYOUT` instead of the vault's real configured layout — this caused the real Bryan Pino/pino merge to fail to find "pino" via the CLI, requiring a direct function-call workaround. Separately, `entity-merger.ts`'s `rewriteWikilinks` (line 178) uses the hardcoded `WIKI_CONTENT_FOLDERS` constant (`src/vault/paths.ts:40`) instead of the already-existing, layout-aware `wikiContentFolders(layout)` function (`paths.ts:48`) — meaning a real merge's wikilink-rewrite step silently scans the wrong folders too. And `rebuild-fts-tokenizer`'s CLI wiring (`karpathy.ts:1634`) hardcodes a 4-folder `vaultDirs` list (`[wiki, aiSummaries, sources, review]`) instead of matching the full-vault scope (`['.']`) the real `sync-fts-index` job actually uses — this caused a real 29.3% row-count drift that correctly blocked the live rebuild swap.

2. **Sample size**: the two categories carrying the entire "does semantic search help" finding have n=4-5. 2 of 5 `fuzzy-recall` items drive the whole gap, and the two hybrid variants (`as-deployed`, `full-cov-hybrid`) don't agree with each other on which items they solve — a signature of noise, not yet a robust, generalizable capability difference.

3. **No confidence intervals on the load-bearing comparison**: `eval/score/bootstrap.ts`'s `bootstrapCI()` is already used for per-category-cell recall/precision/MRR in `build-scorecard.ts`, but the bake-off's arm-level composite score (`build-bakeoff.ts`) has no CI at all — a point estimate only. The margin between grep-first and full-cov-hybrid on `fuzzy-recall`/`relationship` specifically has never been reported with any uncertainty bound.

4. **Composite-weight sensitivity is untested**: the 0.50/0.20/0.15/0.15 (accuracy/latency/tokens/simplicity) weighting was fixed before ever seeing results (a real methodological strength — no post-hoc metric shopping), but nobody has checked whether "grep-first wins" survives under alternate, equally-defensible weightings. Given `simplicity` is a near-fixed 1.000-vs-0.000 penalty against hybrid (structural, not empirical — sqlite-vec doesn't change it), 15% of the composite is close to a foregone conclusion regardless of the accuracy/latency data. If the verdict flips under a lighter or zero simplicity weighting, that's important context for how confident to be in "grep-first wins" as a durable, not weighting-artifact, conclusion.

5. **The `author-absent.ts` calibration was iteratively tuned against the same system it tests** (`DEFAULT_SCORE_THRESHOLD` moved 0.02 → 0.1 → 0.95 across this project, each time reactively recalibrated against newly-observed scores from the current code). Each step was transparent and well-reasoned, but statistically this is a known overfitting risk for eval ground-truth calibration. Per Tom's explicit decision, the fix here is disclosure, not a redesign: the limitation must be clearly documented everywhere this logic's results are used or reported, not silently left implicit.

## 2. Non-goals

- Not re-litigating the composite weighting decision itself (0.50/0.20/0.15/0.15 stays as the primary, headline weighting) — the sensitivity check is an additional reported comparison, not a replacement.
- Not building a fully independent (non-`ftsMatchMode`-based) absence-confirmation mechanism — Tom explicitly chose documentation over a structural redesign for this round.
- Not investigating the as-deployed-beats-full-cov-hybrid anomaly — that's a research/debugging task tracked separately, not part of this build-oriented plan.
- Not building the downstream answer-quality check — that's `2026-07-17-downstream-answer-quality-check-design.md`, a separate spec.
- Not fixing any other stopword-adjacent search-quality concern beyond the specific OR-fallback pathological-cost bug (e.g., not adding stopword filtering to the AND path, which doesn't have this problem — AND already requires every term, so a stopword rarely changes AND's cost profile the same way).

## 3. Component 1: OR-fallback stopword filtering

### 3.1 Root cause (confirmed, not assumed)

`sanitizeFtsQueryOr` (`src/search/fts-index.ts:331-338`) tokenizes a query and OR-joins every resulting token with no filtering:

```ts
export function sanitizeFtsQueryOr(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
```

For a 30+ word natural-language `fuzzy-recall` query, this produces a query with 20+ OR-joined terms including "the", "that", "with", "when", etc. — FTS5 must union the posting lists for every one of those terms, and common words have enormous posting lists in a 23,000+ document vault. This is why `fuzzy-003` took ~58-61 seconds identically across all three bake-off variants (grep-first, as-deployed, full-cov-hybrid all share this same FTS layer).

### 3.2 Fix

Add a small, hardcoded English stopword list (no external dependency — this project's existing convention throughout, e.g. `sanitizeFtsQuery`/`sanitizeFtsQueryOr` already avoid dependencies) and filter tokens against it before OR-joining, in `sanitizeFtsQueryOr` specifically (not the AND path — AND's cost profile isn't pathological the same way, since AND doesn't union posting lists, it intersects them, so extra common-word terms don't blow up its cost the way OR does).

```ts
// A short, standard English stopword list — filtering these out of the
// OR-fallback path avoids unioning enormous posting lists for common words
// on long natural-language queries (see issue: OR-fallback latency cliff,
// found 2026-07-17 bake-off re-run — a 30+ word query took ~60s identically
// across all variants sharing this FTS layer).
const OR_FALLBACK_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or',
  'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);
```

**Fallback safety rule**: if filtering stopwords would leave zero tokens (e.g., a query that happens to be entirely stopwords — pathological but possible), fall back to the unfiltered token list rather than returning an empty query, so `querySnippet`'s existing "return `{ hits: [], matchMode: 'and' }` when the OR query is empty" behavior isn't accidentally triggered for a query that has real (if all-common) words.

### 3.3 Verification

Real, measurable success criterion: re-run the 5 `fuzzy-recall` items' latency directly after the fix and confirm `fuzzy-003` (or whichever item was slowest) drops from ~58-61s to a latency comparable to the rest of the dataset (the re-run found p95 across all variants was 1.8-3.0s once the 9 new items were excluded — that's the real target range). Also re-confirm hit rates are unchanged (stopword filtering must not change which documents match — it only prunes near-useless terms from the OR union, which by construction can only ever narrow the result set if it changes it at all in a harmful way; verify this isn't happening by comparing top-K results before/after on all 5 fuzzy-recall items).

## 4. Component 2: layout-scope bugs

### 4.1 `mergeCommand` doesn't pass `config.layout`

`buildEntityIndex(vault, layout: VaultLayout = DEFAULT_LAYOUT)` (`src/ingest/entity-resolver.ts:42-45`) already accepts a layout parameter — `mergeCommand` (`src/bin/karpathy.ts:1022`) simply never passes it: `const index = await buildEntityIndex(vault);`. Fix: `const index = await buildEntityIndex(vault, config.layout);`, matching the convention every other real call site in this codebase already uses when it has a `config` in scope.

### 4.2 `entity-merger.ts`'s wikilink rewriter uses a hardcoded folder list

`rewriteWikilinks` (`src/compilation/entity-merger.ts:171-183`) uses `WIKI_CONTENT_FOLDERS` (`src/vault/paths.ts:40`, a hardcoded constant using `DEFAULT_LAYOUT` baked in at module-load time) instead of the already-existing `wikiContentFolders(layout: VaultLayout): string[]` function (`paths.ts:48-51`), which correctly derives folders from a real layout. Fix: thread `layout` as a parameter through `mergeEntities` → `rewriteWikilinks` (both currently take no `layout` parameter — check their real current signatures directly before writing the plan's exact diff, since this spec is describing the fix's shape, not its literal line-by-line code) and call `wikiContentFolders(layout)` instead of the module-level constant. The real caller (`mergeCommand`) already has `config.layout` in scope from its own `loadConfig()` call, so wiring this through is a pure plumbing fix, not a design change.

### 4.3 `rebuild-fts-tokenizer`'s CLI scope doesn't match the real sync scope

`karpathy.ts:1634`: `const vaultDirs = [config.layout.wiki, config.layout.aiSummaries, config.layout.sources, config.layout.review];` — this 4-folder list was the plan's original assumption when `grep-recall-improvements` was written, but the real `sync-fts-index` job handler's full-sync path scans the entire vault root (`['.']`) by its own design ("FTS5 covers ALL vault markdown" — confirmed via the 2026-07-17 re-run's direct diagnostic: rebuilding with `vaultDirs=['.']` produced `newCount: 23721` vs the live table's `23722`, an off-by-one match confirming full-vault scope is correct, while the 4-folder scope produced only `16772` rows — a 29.3% miss). Fix: change `vaultDirs` to `['.']` to match the real, currently-deployed indexing scope.

### 4.4 Verification

For 4.1/4.2: re-attempt the real `Bryan Pino`/`pino` scenario is not repeatable (already merged) — instead, write a test that constructs a vault with a non-default layout (e.g. a custom `wiki` subfolder name) and confirms `mergeCommand`'s underlying `mergeEntities()` call correctly finds and merges entities under that custom layout, and correctly rewrites wikilinks found in a non-default content folder. For 4.3: re-run the dry-run rebuild for real (`npx tsx src/bin/karpathy.ts maintenance --rebuild-fts-tokenizer`, no `--confirm`) against the live vault and confirm the row-count drift is now within the existing 5% gate (expect ~23,722 old vs a new count within ~5% given only the tokenizer changed, not the indexed scope) — only then is the real `--confirm` swap (deferred to Tom, per the existing convention for this specific live-index-mutating action) actually safe to attempt.

## 5. Component 3: eval sample expansion (fuzzy-recall, relationship)

### 5.1 Bounded research process (not an arbitrary count, not unbounded either)

Per Tom's explicit choice ("as many as genuinely verifiable"), this is a defined, exhaustive research pass over a bounded real scope — not a fixed target count, and not an open-ended fishing expedition:

- **relationship candidates**: read every real entity note under `Curated/wiki/entities/` (23 files as of the last count in this project, may have grown slightly via the entity-alias/merge work) for its `relationships` frontmatter field and any backlinks/cross-references in its body — for every genuine multi-hop connection between 2+ named entities that can be verified by reading the actual source note(s), author a candidate query. Stop when every entity note has been read once — this is the bounded scope, not an arbitrary count.
- **fuzzy-recall candidates**: read every real note under `Curated/wiki/decisions/` and `Curated/wiki/concepts/` (the two folders the existing fuzzy-recall items are modeled on) for content that can be honestly paraphrased with zero proper nouns/dates/exact terms while still having a single, defensible, verifiable answer. Stop when every note in both folders has been read once.

Every candidate must pass the same bar the original 9 items used: manually confirmed by reading the real note(s), with the evidence documented (quote or close paraphrase of the real content) in the authoring report — no invented-but-plausible items, no LLM-guessed ground truth.

### 5.2 Data model

Identical to the existing `relationship-*`/`fuzzy-*` items — no schema changes. New items continue `relationship-005`, `relationship-006`, ... and `fuzzy-006`, `fuzzy-007`, ... from the existing numbering.

### 5.3 Sensitive-data handling

Per the already-resolved decision (`[[carpathi-eval-sensitive-data]]`), it's fine for these items to reference real named colleagues/content if that's genuinely what the vault contains — no new sensitivity review needed for this expansion, since the precedent is already set. If a candidate touches a *different* sensitivity tier than what's already been approved (e.g., something that reads as health information, legal matters, or credentials rather than performance/calibration commentary), flag it explicitly before including it rather than assuming the existing approval covers it.

## 6. Component 4: disclosed calibration limitation

Add explicit, visible caveat language (not a code-logic change) in three places:

1. `eval/dataset/author-absent.ts`'s existing doc comment — add a paragraph explicitly stating the threshold's calibration history is coupled to this same codebase's own observed behavior across multiple iterations, not an independently-derived standard, and that this is a disclosed, accepted methodological limitation for this specific check (not a general problem with the whole eval set — the 89-item dataset's ground truth for `plaud`/`ai-session`/`entities`/`hot-topics`/`decisions` items comes from real usage + manual verification, independent of this specific absent-item mechanism).
2. `docs/superpowers/ROADMAP.md` — wherever the absent-item confirmation methodology is described, add the same caveat.
3. The `[[carpathi-retrieval-eval]]` memory file — already partially covers this via the recalibration history notes; add one explicit "known limitation, accepted" line so a future session reading memory doesn't need to re-derive this from the code comment.

## 7. Component 5: bootstrap CIs on the load-bearing comparison

### 7.1 What already exists

`bootstrapCI(values: number[], resamples=1000, seed=42): [number, number]` (`eval/score/bootstrap.ts:23-38`) is already implemented and already used for per-category recall/precision/MRR cells in `build-scorecard.ts:146-148`. The `fuzzy-recall`/`relationship` items are tagged `category: decisions`/`category: entities` respectively in `queries.json` (confirmed — they fold into existing categories, not new ones), so their per-item recall/precision/MRR values are already inside the existing category cells' bootstrap resampling — but pooled together with the OTHER `decisions`/`entities` items, which dilutes the specific fuzzy-recall/relationship signal into a broader category average.

### 7.2 What's needed: subtype-scoped CI, not just category-scoped

Add a subtype-filtered cell computation (`computeCell`, already exported from `build-scorecard.ts`, accepts a pre-filtered `RunResult[]` — confirm its real signature before writing the plan's exact diff) that isolates the fuzzy-recall and relationship items. Confirmed directly against real `queries.json` data: `subtype: 'lookup'` is NOT unique to fuzzy items (all 5 `fuzzy-*` items use `category: 'decisions'`, `subtype: 'lookup'`, but so do other, non-fuzzy `decisions` items — subtype alone can't discriminate them). The reliable filter is `id.startsWith('fuzzy-')` and `id.startsWith('relationship-')`, matching how the 2026-07-17 re-run's own per-category breakdown was actually computed. Report `bootstrapCI()` on recall@10/precision@10/MRR for both slices, per contender (grep-first, as-deployed, full-cov-hybrid) — this is a new, additional report section, not a replacement for the existing category-level scorecard.

### 7.3 Composite-level CI (new capability)

The arm-level composite score (`build-bakeoff.ts`'s `composite = 0.5*accSub + 0.2*latSub + 0.15*tokSub + 0.15*simSub`) currently has no CI — it's a deterministic function of already-averaged inputs. Bootstrapping the composite itself requires resampling at the *item* level (not the pre-aggregated metric level): for each of N resamples, resample the pool of `fuzzy-recall`/`relationship` items with replacement, recompute `accuracySub` from that resampled pool's recall/precision/MRR, recompute the composite formula using the resampled accuracy sub-score (holding latency/tokens/simplicity sub-scores fixed, since those aren't naturally item-resampled quantities in the same way — document this as an explicit, stated limitation of the composite-level CI: it only propagates accuracy-side uncertainty, not latency/tokens variance), and report the resulting composite's 95% CI alongside the point estimate specifically for the fuzzy-recall/relationship-only slice.

### 7.4 Output

Extend `eval/results/<date>-bakeoff.md`'s existing per-category table with a new "fuzzy-recall (subtype-scoped, with 95% CI)" and "relationship (subtype-scoped, with 95% CI)" section, reporting recall@10/precision@10/MRR with `[low, high]` CI per contender, plus the composite-level CI described above. If the CIs for grep-first and the hybrid variants overlap substantially, that must be stated plainly as "not statistically distinguishable at this sample size" — the report must not claim a confident winner if the CI says otherwise, even if the point estimates differ.

## 8. Component 6: composite-weight sensitivity check

### 8.1 Alternate weightings

Extend `build-bakeoff.ts` (or a new sibling script/CLI flag, following whichever is more consistent with the existing `pnpm eval:bakeoff` convention — decide during plan-writing after reading the real current CLI wiring) to recompute the full composite under 2-3 alternate, clearly-labeled weightings, run alongside (not instead of) the primary 0.50/0.20/0.15/0.15 weighting:

1. **Equal weight**: 0.25/0.25/0.25/0.25 — no metric privileged.
2. **Zero-simplicity**: 0.5/0.3/0.2/0 (redistributing simplicity's 0.15 proportionally to accuracy/latency/tokens) — tests whether the verdict depends on the structural, non-empirical simplicity penalty at all.
3. **Accuracy-only**: 1.0/0/0/0 — the purest "which one finds the right documents" comparison, stripped of all cost considerations.

### 8.2 Output

A new small table in the bake-off markdown report: one row per weighting scheme, columns for grep-first composite / full-cov-hybrid composite / winner / margin. State explicitly whether grep-first wins under all schemes, some, or none — this is the headline finding of this component. If grep-first wins under all 4 (primary + 3 alternates), that's a materially stronger claim ("robust to reasonable weighting choices") than the current single-weighting verdict; if it doesn't, that's equally important to report honestly.

## 9. Component 7: final re-verification run

Once Components 1-6 have landed (code fixes verified, new eval items authored and ground-truth-verified, disclosure language added, CI/sensitivity reporting built), re-run the full real pipeline one more time: `eval:pool` (`--only=` the newly-added item IDs) → `eval:judge-full` (same filter) → `eval:run` (full harness, all items, all 3 variants) → `eval:score` → `eval:bakeoff` (now emitting the CI and sensitivity sections). This produces the actual, final, scrutiny-ready numbers this whole hardening round exists to produce — following the exact same real-file-state-verification discipline established across every prior real run in this project (never trust a command's return alone; verify against actual output file mtimes/content, since long-running eval commands have repeatedly been silently auto-backgrounded in this project — see `[[karpathy-long-running-eval-commands]]`).

## 10. Testing strategy

- Component 1: unit test for `sanitizeFtsQueryOr`'s stopword filtering (stopwords removed, non-stopwords preserved, all-stopword-query fallback), plus a real before/after latency measurement on the 5 fuzzy-recall items.
- Component 2: unit tests for `mergeCommand`/`mergeEntities`/`rewriteWikilinks` against a non-default-layout fixture vault (this is the only way to actually prove the layout-scope bug is fixed, since the default-layout case never exposed it).
- Component 3: no automated test — this is a manual research-and-authoring task with the same ground-truth-verification discipline as the original 9 items; the "test" is the documented evidence trail in the authoring report.
- Component 4: no test — doc-only change; self-review confirms the caveat language is present in all 3 locations.
- Component 5: unit tests for the new subtype-scoped cell computation and composite-level bootstrap CI function, using small synthetic fixtures with known resampling behavior (verify against hand-computed expected CI bounds for a trivial case, e.g. all-identical values should produce a zero-width CI).
- Component 6: unit tests for the alternate-weighting composite computation, confirming the primary weighting's output is unchanged (regression guard) and the alternate weightings produce the expected different composite values for a fixed fixture.
- Component 7: real execution, verified via file state per the established discipline — no unit test, this is an operational run.

## 11. Risks & mitigations

- **Stopword list could be incomplete or wrong for this vault's real vocabulary** (e.g., domain-specific short words that function as stopwords in this context but aren't in a generic English list). Mitigated by verifying against the real 5+ fuzzy-recall items' actual latency and hit-rate before/after, not just trusting the list is "good enough" in the abstract.
- **Layout-scope fixes could have other, not-yet-discovered call sites with the same bug class** (any `buildEntityIndex(vault)` call without a layout argument, or any hardcoded-folder-list pattern). Mitigated by a repo-wide grep for `buildEntityIndex(vault)` (no second arg) and `WIKI_CONTENT_FOLDERS`/similar hardcoded-folder-list usage during the plan-writing/implementation phase, not just fixing the 3 specifically-found instances.
- **Bounded research for Component 3 could still turn up very few genuine candidates** (if the vault's entity/decision/concept notes don't have much more genuinely mineable relationship/paraphrase content beyond what the original 9 items already captured) — this is an acceptable, honest outcome per Tom's own "as many as genuinely verifiable" framing, not a failure requiring padding with weaker items.
- **Composite-level bootstrap CI's accuracy-only resampling (§7.3) could be seen as an incomplete uncertainty measure** since it doesn't propagate latency/token variance. Mitigated by stating this limitation explicitly in the report output, not presenting it as a full-composite CI when it isn't one.
