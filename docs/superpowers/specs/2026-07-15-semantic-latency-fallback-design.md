# Semantic Search Latency Fix + Confidence-Gated Fallback — Design

**Date:** 2026-07-15
**Status:** Approved design
**Depends on:** Stage 1 bake-off verdict; architecture audit findings (this session)
**Track:** B, Stage 2 — this is the one piece of §5.2 ("architecture-dependent, only if hybrid wins") being pursued anyway, in a deliberately narrower shape than a full backfill, per Tom's explicit choice to wire semantic search back in as a fallback rather than delete it outright.

## 1. Problem statement

The bake-off found full-cov-hybrid's pooled median query latency at 3.8 seconds (vs. grep-first's 31ms — 122x), traced by the architecture audit to `EmbeddingStore.search()` doing a true brute-force scan: every query pulls **every** row for the provider (`selectAllStmt.all()`), converts each BLOB to a `Float32Array`, `JSON.parse`s each row's metadata, computes cosine similarity, then sorts — for ~20k rows, every query, regardless of `topK`. This is real, fixable implementation cost, not an inherent property of semantic search at this scale.

Separately, this session's own re-verification found **issue I9 is still live and unresolved**: the hybrid variants' `final` score clusters in a narrow ~0.11-0.16 band for queries that should score near-zero (confirmed today against both `as-deployed` and the freshly-rebuilt `full-cov-hybrid`), while grep-first correctly discriminates. This matters directly here: a confidence-gated fallback design lives or dies on whether the semantic path's own output can be trusted once triggered — if I9 isn't at least understood, a "helpful" fallback could confidently return noise.

## 2. Non-goals

- Not re-running the Stage 1 bake-off, not revisiting the grep-first verdict.
- Not backfilling production's embedding coverage to 100% (that's the exact cost/complexity tradeoff the bake-off weighed against; production stays at its current ~34% coverage — see §6).
- Not implementing true ANN (ambitious future work if the corpus ever grows past what exact search handles quickly — see §3.3 for why that's not needed at this scale, today).

## 3. Component 1: sqlite-vec integration

### 3.1 What sqlite-vec actually is (verified, not assumed)

Real, cited facts, not marketing: `sqlite-vec` (npm package, current stable `0.1.9`, prebuilt binaries for `darwin-arm64` — no local compile step) loads as a `better-sqlite3` extension via `sqliteVec.load(db)`, and provides a `vec0` virtual table type supporting `float[N]` columns with `distance_metric=cosine` (native cosine support — no manual normalization needed) and `MATCH ... ORDER BY distance LIMIT k` KNN queries.

**Important expectation-setting: as of the current released version, sqlite-vec's KNN search is still brute-force internally** (confirmed via the project's own open tracking issue for ANN support — HNSW/IVF are pre-1.0 roadmap items, not implemented today). The speedup this component delivers comes from doing that brute-force scan in native, SIMD-accelerated C instead of a JS loop that also pays BLOB-decode and `JSON.parse` costs per row — **not** from approximating the search. This is actually a good property for a knowledge-base search tool: results stay exact (no ANN recall loss), and the corpus is small enough (~20k vectors, could grow to low hundreds of thousands before brute-force becomes the bottleneck again) that this isn't a near-term ceiling.

No independent benchmark exists at exactly this project's scale (~20k vectors, 768-dim) — published sqlite-vec benchmarks are at different corpus sizes/dimensions (e.g., ~33-41ms at 500k-1M vectors/128-960-dim). A rough extrapolation suggests single-digit milliseconds at our scale, but **this must be verified with a real benchmark against real data (§3.4), not assumed from the extrapolation.**

### 3.2 Schema design

Add a new `vec0` virtual table alongside the existing `embeddings` table (not replacing it — the existing table keeps its role as the source of truth for text/metadata/chunk-hash caching):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
  vector float[768] distance_metric=cosine
);
```

The `vec_embeddings` table's implicit `rowid` is used as the join key back to `embeddings`' own implicit `rowid` (SQLite tables have an integer rowid even with a declared composite primary key like `embeddings`' `(provider_id, doc_id, chunk_index)`, unless declared `WITHOUT ROWID` — confirm this holds for the real `embeddings` table's actual `CREATE TABLE` statement before relying on it, since it's a real assumption worth a direct check, not a guess). Query pattern:

```sql
WITH knn AS (
  SELECT rowid, distance FROM vec_embeddings
  WHERE vector MATCH :queryVec ORDER BY distance LIMIT :k
)
SELECT e.provider_id, e.doc_id, e.chunk_index, e.text, e.metadata, knn.distance
FROM knn JOIN embeddings e ON e.rowid = knn.rowid;
```

### 3.3 Write-path changes

`EmbeddingStore`'s existing upsert path (`replaceDoc`, `store.ts` — used by both the live `embedding-index` job and this project's eval backfill scripts) must insert into `vec_embeddings` alongside its existing writes to `embeddings`, keeping the two tables' rowids in lockstep. Deletes (`deleteDoc`) must remove from both. This is the one place where "brute-force but fast" (§3.1) matters for write cost too: unlike some real ANN structures, a vec0 insert/delete is cheap (no index rebalancing), so this dual-write doesn't meaningfully slow down the existing indexing job.

### 3.4 Migration + real benchmark

1. One-time backfill: for every existing row in `embeddings` (production's current ~7,851+ embedded docs, and separately the disposable `bakeoff-fullcov.sqlite` if kept around for a follow-up comparison), insert the corresponding vector into `vec_embeddings`.
2. Rewrite `EmbeddingStore.search()` to use the `vec0` KNN query (§3.2) instead of the brute-force JS loop.
3. **Real benchmark, not an assumption:** run the exact same latency measurement the bake-off used (warm-median over repeated calls, same query set) against the migrated index, and report the real number. Success criterion: comfortably under 100ms (the "milliseconds" framing from the request), ideally much lower per the extrapolation in §3.1 — but report whatever the real number is.

## 4. Component 2: confidence-gated fallback in the live search path

### 4.1 Design

Change the live default from "always run hybrid" to "keyword-first, semantic only as a fallback":

1. Run FTS5/BM25 search first (now with Component 1's OR-fallback from the grep-recall-improvements spec, if that's landed first — these two specs compose).
2. Compute a confidence signal from the keyword results: **zero hits**, OR **fewer than 3 hits**, OR **top hit's BM25-derived score below a calibrated cutoff** (the exact cutoff must be derived from real score distributions — pull a sample from the live `mcp-usage.jsonl` log or a fresh sampling run, not guessed in the abstract; today's log has no `result_count`/score field recorded for `search` calls, so this may require a small logging addition first to gather the calibration data before picking a number).
3. If confidence is low, **also** run the semantic path (now sub-100ms per Component 1) and fuse via the existing RRF logic — this is exactly the existing hybrid fusion code, just gated on a condition instead of running unconditionally.
4. Tag the response with which path(s) actually fired (extends the existing `degradationNote`/`searchMode` pattern already in `HybridSearchResult` — this becomes a third state alongside `'hybrid'`/`'keyword-only'`, e.g. `'keyword-with-semantic-fallback'`) so this is observable in the existing `mcp-usage.jsonl` audit log, not a silent behavior change.

### 4.2 I9 as a real, flagged risk

Before trusting the semantic path's *own* relevance ranking when it does fire, at least investigate I9's root cause (the design doc's original suspicion: "a scoring-floor artifact in hybrid-store's recency/RRF blend") enough to confirm the fallback won't confidently surface noise. This doesn't have to be a full fix before the fallback ships, but it needs a documented finding (root cause identified, and either fixed or explicitly deemed low-risk for the fallback's specific usage pattern) — shipping a fallback on top of a known-broken confidence signal without at least understanding it would repeat the mistake the bake-off's own rigor was built to avoid.

### 4.3 Rollout care

This changes behavior for the live MCP `search` tool that Claude Code sessions (including this project's own development sessions) actively use today. Land it behind a config flag defaulting to **off** initially, verify the fallback's real trigger rate and behavior against a sampling window of real usage (via the tagging in §4.1 step 4), then flip the default once that's confirmed sane — not a silent flip on merge.

## 5. Testing strategy

- `vec_embeddings` schema/join correctness: unit tests against a small in-memory SQLite DB with `sqlite-vec` loaded, confirming insert/delete/KNN-query/join all behave correctly, including the rowid-join assumption from §3.2.
- Dual-write correctness: a test confirming `replaceDoc`/`deleteDoc` keep `embeddings` and `vec_embeddings` in lockstep (no orphaned rows in either direction).
- Confidence-gating logic: unit tests with fake FTS results at each threshold boundary (zero hits, exactly 3 hits, below/above the score cutoff), confirming the semantic path fires exactly when expected and not otherwise.
- Real benchmark (§3.4 step 3) and real rollout monitoring (§4.3) are verification steps, not automated tests — they need to run against real data and real usage.

## 6. Explicit scope boundary: production embedding coverage stays as-is

This spec does **not** backfill production's embedding coverage beyond its current ~34% (the same gap documented as issue I1, unchanged). Re-investing in full coverage now would reintroduce exactly the cost/complexity the bake-off weighed against paying for the *primary* path — the fallback's value proposition here is "cheap, occasional use of whatever's already embedded," not "make semantic search complete." If the fallback proves valuable enough in practice to justify closing I1 later, that's a real, separate, data-driven follow-up decision, not a default in this plan.

## 7. Risks & mitigations

- **sqlite-vec is a new native production dependency.** Mitigated by prebuilt-binary distribution (no new compile-step risk) and by keeping the existing `embeddings` table as the source of truth (if `vec_embeddings` ever needs to be dropped/rebuilt, it can be regenerated from `embeddings` alone).
- **The rowid-join assumption (§3.2) could be wrong for a composite-PK table.** Mitigated by a direct, explicit verification step before building on it, not an assumption carried into the plan.
- **I9 could undermine the whole fallback's value if left unaddressed.** Mitigated by requiring a documented root-cause finding (§4.2) as a gate before rollout, not an afterthought.
- **A confidence threshold picked without real score-distribution data would be a guess.** Mitigated by requiring real calibration data (§4.1 step 2) before finalizing the cutoff, adding minimal logging first if today's audit log doesn't already have it.
- **Silently changing live search behavior risks disrupting active usage (including this project's own dev sessions).** Mitigated by the feature-flag-gated rollout in §4.3.
