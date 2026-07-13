# Carpathi Retrieval Evaluation — Design

**Date:** 2026-07-06
**Status:** Approved design (v2, implementation-grade), pending spec review
**Author:** Tom + Claude (brainstorming session)
**Project:** `karpathy` / Carpathi Second Memory (`/Users/valletta/dev/2nd-brain`)

---

## 1. Problem statement

Carpathi's retrieval used to feel fast and expert when it was plain grep + file
access. The team then layered in a hybrid search stack (SQLite FTS5 + BM25 +
Reciprocal Rank Fusion, plus an optional semantic/embedding pool) and a weekly
hot-topic/digest curation layer on top. **Subjectively, retrieval got worse, not
better** — answers feel less accurate, miss important files, or come back slower
than they should.

There is **no evaluation set and no benchmark anywhere in the repo** (confirmed
by grep for eval/benchmark/golden/ground-truth — only unit tests with synthetic
fixtures exist). So "it got worse" is currently an unfalsifiable feeling. This
project builds the missing measurement instrument, uses it to produce a
before/after verdict grounded in real usage, and freezes it into a standing
regression suite so the system can never silently regress again.

## 2. Goals (grounded in Tom's stated objectives)

1. **G1 — Quick, efficient access.** Fast in wall clock, cheap in tokens, while
   maximizing accuracy. **Accuracy is the overriding goal; latency and token
   cost are co-equal secondary constraints.**
2. **G2 — Complete capture.** Everything Tom cares about — especially **Plaud
   recordings** and **all AI-harness (Claude Code / Cursor) sessions on this
   machine** — must reach the vault *and* the search index. Retrieval quality is
   moot for content that was never ingested.
3. **G3 — Hot/curated content is findable fast.** The curator/digest layer must
   demonstrably surface the hottest, most related material — not just exist in
   spec.
4. **G4 — Not missing important files.** The top failure mode Tom named. Recall
   on known-relevant notes is the headline metric.
5. **G5 — Right detail, efficiently.** Correct `detail` level, un-truncated
   snippets, adequate provenance, without wasting tokens.

**Overriding principle:** best accuracy overall, delivered in the most token-
and wall-clock-efficient way possible.

## 3. Grounding findings (verified against code + data, 2026-07-06)

Treated as hypotheses the eval must confirm/refute — not settled facts. All cite
real evidence.

| # | Finding | Evidence (path:line / data) | Implication |
|---|---------|------------------------------|-------------|
| F1 | **Routing failure is live & severe.** Deprecated `search_vault` called **165×** at **6.4s median / 13s max**; fast `search` only **3×** at ~110ms. | `.karpathy/logs/mcp-usage.jsonl` (349 rows) | Tool-routing accuracy is a first-class metric (§7.4). Likely the biggest driver of "feels worse." |
| F2 | **Zero-hit is encoded as absence of `result_count`, not `0`.** No zero-`result_count` rows, but several `success:true` rows with tiny `result_chars` (~30–110) and no `result_count`. | usage log | RRF almost always returns *something* → must inject known-absent queries (§7.5). Parser must treat "missing `result_count` + small `result_chars`" as zero hits. |
| F3 | **Semantic coverage gap.** FTS index = 22,856 docs; embeddings = 18,685 distinct docs (~82%). ~4,200 indexed notes are FTS-only; prior audit noted a 7,344-note enrichment backlog. | `embeddings.sqlite`; audit | Ingestion/coverage funnel is a separate deliverable (§6.1). |
| F4 | **Hot-topic digest not running.** Banner: "No weekly digest yet." Topic clustering / decay job stubbed. | intelligence-plan.md, banner | Hot-topic failures may be a *data* gap, not a *search* gap → failure taxonomy must separate them (§10). |
| F5 | **Prior silent regressions shipped.** Dead sync layer, recency bug, Unicode-stripping bug (`audit/15`); 6 operational defects (reliability plan). Fixes landed but **relevance was never verified post-fix** (Task 8 is an unrun manual checklist). | audit/15, reliability plan, git log | Regression suite (Phase 4) is a real deliverable. |
| F6 | **Sources wired.** Watch paths include `Plaud/`, `AI Conversations/claude/`. On disk: 591 Plaud, 7,591 AI-conversation files (5,005 summaries). | `~/.karpathy/config.json`, live vault | Real queries + ground truth mineable from authentic content. |
| **F7** | **Corpus asymmetry (fairness threat).** `search_vault` scans **only** `wiki`, `_summaries`, `sources`, `review` (`src/mcp/tools/search-vault.ts`, iterates `[layout.wiki, layout.aiSummaries, layout.sources, layout.review]`). The hybrid store indexes 100% of vault markdown. | code | A note outside those 4 folders is *unreachable* by `search_vault` by construction. §7.6 defines a **scope-matched comparison** so the before/after isn't rigged. |
| **F8** | **Log records counts, not paths.** `mcp-usage.jsonl` has `result_count`/`result_chars` but **no returned paths/ids**. | usage log schema | Ground truth cannot be recovered from logs → pooling protocol required (§8). Behavioral relevance signal must come from *subsequent* `get_note`/`batch_get_notes` `paths` in the same session. |
| **F9** | **`doc_id` = vault-relative path (identity, no hash).** Both FTS (`fts-index.ts:155,252`) and embedding pipeline (`embedding-index.ts:53-58`) store `path.relative(vaultRoot, abs)` verbatim as `doc_id`. | code | Path↔index joins are trivial: `doc_id === expected_note`. Coverage funnel = `WHERE doc_id LIKE 'Plaud/%'`. |
| **F10** | **Two live bugs in the log.** `search_vault` → `b.updated_at.localeCompare is not a function`; `get_note` on a directory → `EISDIR`. | usage log `error` fields | Eval must include the offending query as a regression item and the harness must survive tool exceptions (§15). |

**Live vault:** `/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes`
**Usage log:** `.karpathy/logs/mcp-usage.jsonl`
**Index DB:** `.karpathy/state/embeddings.sqlite`

## 4. Non-goals

- **Not** re-architecting search or the digest layer here — this project measures
  and diagnoses; fixes are follow-on work informed by the scorecard.
- **Not** a UI. Output is a markdown scorecard + machine-readable JSON.
- **Not** cloud-dependent for harness/scoring (local-first). The LLM judge may
  use Bedrock (the project's configured provider); harness + scoring run locally
  and deterministically.
- **Not** grading final chat prose. We grade what the MCP tools *return* (the
  retrieval substrate) plus tool/detail choice — not Claude's downstream writing.
- **Not** mutating the live index. The harness opens the DB read-only and never
  calls `syncFTS`/`upsertDoc` against the production vault.

## 5. Success criteria for THIS project

1. Reusable eval set of 60–100 items across the 4 required categories + an
   absent-query slice, with human-spot-checked, pooled ground truth.
2. A scriptable harness runs the set against **both** `search` (current) and
   `search_vault` (baseline), scope-matched (§7.6), emitting per-category recall,
   precision, MRR, latency, and token cost — plus old-vs-new deltas with
   confidence intervals.
3. An ingestion/coverage funnel quantifying the Plaud + AI-session drop-off from
   disk → FTS → embeddings.
4. A prioritized defect list where every failure is attributed to a mechanical
   root-cause category (§10).
5. `pnpm eval` re-runs the whole thing on demand and guards future changes.

## 6. System architecture & component breakdown

New code lives under `2nd-brain/eval/`. Each module has one responsibility and a
typed interface so it can be tested in isolation.

```
eval/
  dataset/
    queries.json          # eval items (§11.1), committed; the frozen set
    pool.json             # pooled candidates per query (§11.2), regenerated
    judgments.json        # relevance labels (§11.3), committed after calibration
    heldout.json          # blind items excluded from tuning (§14)
  mine/
    parse-usage-log.ts    # §9.1  usage log → candidate queries + behavioral signal
    parse-sessions.ts     # §9.2  claude/ transcripts + _summaries → verbatim queries
    build-dataset.ts      # §9.3  cluster/dedup/tag → dataset/queries.json
  pool/
    build-pool.ts         # §8.1  run both tools + keyword sweep + behavioral → pool.json
    judge.ts              # §8.2  LLM relevance labeling → judgments.json
  run/
    invoke-search.ts      # §6.2a drive hybrid store.search()
    invoke-search-vault.ts# §6.2b drive search_vault handler
    open-store.ts         # §6.2  read-only store + ctx construction
  score/
    metrics.ts            # §7    recall/precision/MRR/latency/tokens formulas
    classify.ts           # §10   mechanical failure taxonomy
    coverage.ts           # §6.1  ingestion funnel SQL
    tokens.ts             # §13   token + char measurement
  report/
    scorecard.ts          # §11.4 aggregate → results/<date>-scorecard.md + .json
  results/
    <date>-scorecard.md   # human report
    <date>-scorecard.json # machine record (per §11.4)
  README.md               # run instructions + pass bar (§14)
```

`package.json` scripts (uses `tsx`, added as devDep):
```json
"eval:mine":     "tsx eval/mine/build-dataset.ts",
"eval:pool":     "tsx eval/pool/build-pool.ts",
"eval:judge":    "tsx eval/pool/judge.ts",
"eval:run":      "tsx eval/run/run-harness.ts",
"eval:coverage": "tsx eval/score/coverage.ts",
"eval":          "tsx eval/run/run-harness.ts && tsx eval/report/scorecard.ts"
```

### 6.1 Ingestion & coverage funnel (component `coverage.ts`)

Because `doc_id` is the vault-relative path (F9), the funnel is direct SQL
against the live DB plus a disk walk. For each required prefix (`Plaud/`,
`AI Conversations/`, `AI Conversations/_summaries/`, `Curated/wiki/`, `Curated/sources/`):

```sql
-- on_disk: filesystem walk of vaultPath/<prefix> for *.md
-- in_fts:
SELECT COUNT(*) FROM fts_meta WHERE doc_id LIKE :prefix || '%';
-- in_embeddings (provider_id from config, e.g. bedrock-titan or ollama:nomic-embed-text):
SELECT COUNT(DISTINCT doc_id) FROM embeddings
  WHERE provider_id = :providerId AND doc_id LIKE :prefix || '%';
```

Emits one funnel row per prefix (§11.5). Drop-off between stages localizes G2
failures: `on_disk > in_fts` ⇒ ingestion/sync gap; `in_fts > in_embeddings` ⇒
enrichment backlog (F3).

### 6.2 Driving the two tools

The harness opens the store **once** read-only and reuses it (avoids the
per-call open/close perf nit noted in audit/15).

`open-store.ts`:
```ts
import { loadConfig } from '../../src/config/loader.js';
import { openHybridStoreFromConfig } from '../../src/search/factory.js';
// projectRoot MUST be the repo root so config.stateDir resolves to the REAL
// .karpathy/state/embeddings.sqlite (guards the F4 empty-DB-if-wrong-CWD trap).
const config = await loadConfig(REPO_ROOT);        // resolves vaultPath, projectRoot
const store  = openHybridStoreFromConfig(config, config.projectRoot!);
```

**(a) Current tool** — call the store method directly (returns `HybridHit[]`
whose id field is `docId` = path):
```ts
const res = await store.search(query, { topK: K });        // K default 10
// res: { hits: HybridHit[], searchMode: 'hybrid'|'keyword-only', degradationNote? }
// hit.docId  === vault-relative path  (compare to expected_notes directly)
// hit.scores.final  (rank key); hit.scores.semanticSim / keywordRank (liveness)
```

**(b) Baseline tool** — `search_vault` has **no store method**; it is only the
MCP handler `handle(args, ctx)` in `src/mcp/tools/search-vault.ts`, doing a
file-scan over 4 folders. `invoke-search-vault.ts` builds a minimal `ctx`
(config + `createFsAdapter(vaultPath)` vault adapter, mirroring
`test/mcp/tools/search.test.ts:makeCtx`) and calls the handler:
```ts
const out = await handleSearchVault({ query, limit: K, detail: 'summary' }, ctx);
// parse out.content[0].text → ScoredResult[]  (fields: path, title, score, excerpt, updated_at)
// NOTE: returns a bare JSON array, NOT the {search_mode, results} envelope.
```
Both adapters normalize to a common `RunResult` (§11.6) keyed on `path`.

### 6.3 Semantic-layer liveness (must be recorded per run)

`store.search()` returns `searchMode: 'hybrid' | 'keyword-only'` and optional
`degradationNote`; per-hit `scores.semanticSim`/`keywordRank` presence reveals
which pool matched. Only `provider === 'ollama'` is gated on a runtime probe;
`bedrock-titan`/`deterministic` always report `'hybrid'`. **The harness records
`searchMode`, `degradationNote`, `config.embeddings.provider`, and the DB
snapshot (doc count + newest `indexed_at`) in the scorecard header** so a
degraded run is never mistaken for a quality regression.

## 7. Evaluation dimensions & metric definitions

`k` (evaluation cutoff) **= 10** by default (matches the log's typical `limit`);
scorecard also reports `@5`. Let `E` = judged-relevant set for a query (§8),
`R_k` = tool's top-k returned paths.

### 7.1 Recall@k  (headline, G4)
`recall@k = |E ∩ R_k| / |E|`. Undefined (excluded) if `|E| = 0` except for
absent-queries (§7.5). This is why pooling matters: `E` must approximate the
*true* relevant set, not just what one tool found.

### 7.2 Precision@k  (noise, G5)
`precision@k = |E ∩ R_k| / |R_k|`. A judged-relevant candidate counts as a hit;
any returned path not in the pooled-relevant set counts as noise. Because pools
are shared across tools, precision is comparable between them.

### 7.3 MRR / rank-of-first-relevant (G5)
`RR = 1 / rank_of_first_relevant` (0 if none in top-k). Reported as mean (MRR)
and median rank. A correct note at rank 18 is nearly as useless as a miss.

### 7.4 Tool-routing accuracy (from REAL logs, F1)
Independent of the harness. For each logged search-class call, a rubric maps the
query's intent → the *appropriate* tool (fast `search` / `get_entity` /
`get_decisions` / `get_recent_sessions`) vs. the slow `search_vault`.
`routing_accuracy = correct_tool_calls / total_calls`, reported overall and by
month (to show whether the F1 routing fix changed real behavior).

### 7.5 Robustness / specificity (F2)
For `subtype:"absent"` items, correct behavior = returning nothing or only
low-`final`-score hits below a threshold. `specificity = correct_absent / total_absent`
where "correct" = top result's `scores.final` < τ (τ calibrated on the absent
set) or zero hits.

### 7.6 Scope-matched comparison (fairness, F7)
Every accuracy metric is computed **twice**:
- **Full-corpus:** raw numbers (shows real-world experience).
- **Scope-matched:** restrict `E` and `R_k` to notes under the 4 folders
  `search_vault` can see, so ranking quality is compared on equal corpora. The
  gap between the two isolates "hybrid wins only because it indexes more" from
  "hybrid ranks better."

### 7.7 Efficiency
- **Latency:** wall-clock per `store.search()` / handler call, median + p95.
- **Tokens/chars:** §13.

## 8. Ground truth via pooling (the core methodology)

Recall is unmeasurable against 22,856 docs without knowing the relevant set.
Standard IR pooling solves this: gather a candidate pool from multiple sources,
have a judge label each candidate, and treat judged-relevant as `E`.

### 8.1 Pool construction (`build-pool.ts`)
For each eval item, the pool = union (dedup by `doc_id`) of:
1. Top-20 from `store.search(query, {topK:20})`.
2. Top-20 from `search_vault(query, {limit:20})`.
3. A raw keyword sweep: `SELECT doc_id FROM notes_fts WHERE notes_fts MATCH :ftsQuery LIMIT 20` using a sanitized query (approximates the "old grep" reach across the *full* corpus, catching notes both tools rank low).
4. **Behavioral signal (F8):** any `path` opened via `get_note`/`batch_get_notes`
   in the *same session* shortly after the originating query in the usage log —
   these are notes Tom actually chose to read (strong relevance prior).
5. For synthetic items, the seed note(s) the query was generated from.

Pooling depth 20 per source (> k=10) reduces pool bias. Each candidate records
which sources surfaced it (for pool-bias analysis).

### 8.2 LLM judge (`judge.ts`)
Per candidate, the judge sees **only**: the query, the candidate note's title +
`full` body (or first ~2k tokens if huge), and the item's `intent`. It never
sees the whole vault. Output is a graded label:

- `2` = directly answers / is the primary target.
- `1` = relevant supporting context.
- `0` = not relevant.

`E` (relevant set) = candidates with label ≥ 1; a stricter `E_primary` (label 2)
is also recorded for a "did it find THE note" variant. Judge prompt is a fixed
template (committed in `judge.ts`), uses the project's Bedrock config, temperature
0, and emits `{doc_id, label, reason}` JSON per candidate.

### 8.3 Calibration gate (human, blocks scaling)
Tom reviews a **~20-item stratified sample** (spread across all categories +
subtypes) of the judge's labels *before* the judge labels the rest. Agreement is
measured (Cohen's κ or raw agreement). **Gate:** proceed only if raw agreement
≥ 0.8; otherwise revise the judge prompt and re-sample. Every judgment carries
`label_provenance: llm | human | llm+human` so any scored failure is traceable.

### 8.4 Handling pool incompleteness
Recall is "pooled recall" (relative to the judged pool), not absolute — stated
explicitly in the scorecard. Because both tools + a full-corpus keyword sweep +
behavioral signal feed the pool, systematic bias against either tool is bounded.

## 9. Query mining pipeline (Phase 0)

Real data first; synthetic only to fill sparse categories. Join key across all
sources = the 8-char hex session id.

### 9.1 Usage-log queries (`parse-usage-log.ts`)
Parse `.karpathy/logs/mcp-usage.jsonl` (schema fully mapped: top-level
`ts, tool, args, duration_ms, success, result_chars, result_count?, error?`).
- Extract `args.query` from `search` / `search_vault` / `search_entities`.
- Detect zero-hit calls via F2 rule (missing `result_count` + small `result_chars`).
- Build the **behavioral relevance map**: for each search call, collect `path`
  (and `paths[]`) args of `get_note`/`batch_get_notes` calls that follow it in
  time within the same working session → feeds §8.1(4).
- Capture the two F10 error queries as mandatory regression items.

### 9.2 Session-transcript queries (`parse-sessions.ts`)
- **Primary (verbatim, untruncated):** `AI Conversations/claude/<project>/<date>-<hex>.md`
  → parse `### Turn N — User (time)` blocks. These are full user prompts.
- **Secondary (truncated `...`):** `_summaries/session-*.md` → `## Prompts` →
  `### Prompt N (time)` blocks. **Handle both protected-region dialects**:
  `%% begin:prompts %%…%% end:prompts %%` (newer) and
  `<!-- PROTECTED:prompts -->…<!-- /PROTECTED:prompts -->` (older).
- **Filters:** drop entries whose body starts with `<task-notification>`; drop
  trivial acks (`yes`, `#1234567`, one-word); drop prompts with no retrieval
  intent (pure coding requests unrelated to the vault). Prefer transcript
  versions over truncated summary versions when the hex id matches.
- **Implicit-failure mining (consideration #6):** within a session, order
  prompts by timestamp; flag reformulation/correction chains (e.g. "the spec is
  missing detail", "I might have been premature… go check") as high-value hard
  items — no LLM judgment needed to know retrieval/answer fell short there.

### 9.3 Dataset assembly (`build-dataset.ts`)
- Cluster near-duplicate queries (normalized token Jaccard ≥ 0.7) → keep one
  representative, record frequency.
- Tag each item with `category` (Plaud/AI-session / entities / hot-topics /
  decisions) and `subtype` (`lookup` / `synthesis` / `relationship` / `absent`).
- **Backfill** sparse categories (likely hot-topics — that tool is auto-invoked,
  rarely typed) with synthetic queries built from the vault's real taxonomy
  (existing entities/projects/decisions), marked `source:"synthetic"`.
- **Absent slice (§7.5):** author 5–8 queries about topics verified absent
  (`notes_fts MATCH` returns nothing + manual confirm).
- Targets: Plaud/AI-session 20–25, entities 15–20, hot-topics 15–20, decisions
  15–20, absent 5–8. Hold back ~10% into `heldout.json` (§14).

**Plaud note (F6/F8):** Plaud files contain no user prompts — they are retrieval
*targets*. "Plaud" category queries come from sessions where Tom asked about a
meeting; the expected notes are the `Curated/sources/p-*` / `Plaud/*` pages.

## 10. Failure taxonomy — mechanical decision procedure (`classify.ts`)

Every missed/degraded eval result is classified by executable checks (not
opinion), in order. For a query whose expected note `e ∈ E` was NOT in top-k:

1. **`not_ingested`** — `e` not present on disk under `vaultPath` **and** not in
   `fts_meta`. (Rare for expected notes since they came from the vault, but
   possible for deleted/moved notes; ties to G2.)
2. **`not_indexed`** — `e` exists on disk but `SELECT 1 FROM fts_meta WHERE
   doc_id = e` returns nothing (sync gap), **or** for a semantically-dependent
   miss, absent from `embeddings` (enrichment backlog, F3).
3. **`ranked_poorly`** — `e` is in `fts_meta`/`embeddings` and appears in the
   depth-20 pool but at rank > k. A genuine ranking/fusion bug (β/recency/RRF).
4. **`unusable`** — `e` *was* in top-k but the returned payload was defective:
   truncated excerpt, wrong `detail` for the query type, or missing frontmatter
   the query needed (G5). Detected by inspecting the returned `RunResult`.
5. **`wrong_tool`** — for routing items (§7.4), a better tool existed. Applies to
   the real-log analysis, not the head-to-head harness.

Each failure row in the scorecard carries its cause + the evidence check that
fired, so the defect list is directly actionable ("hot-topics: 4× `not_indexed`,
3× `ranked_poorly`").

## 11. Data models

### 11.1 Eval item (`dataset/queries.json`)
```jsonc
{
  "id": "decisions-007",
  "query": "what did the May 18 leadership calibration meeting decide about P50/P55/P60",
  "category": "decisions",               // plaud-ai-session | entities | hot-topics | decisions
  "subtype": "synthesis",                // lookup | synthesis | relationship | absent
  "source": "session",                   // log | session | synthetic
  "source_ref": "session-2026-05-18-xxxxxxxx",  // provenance (hex id / log ts / seed note)
  "intent": "surface the calibration decision + rationale",
  "is_regression": false,                // true for the two F10 error queries
  "scope_note": "target under Curated/wiki/meetings (visible to search_vault)"
}
```

### 11.2 Pooled candidate (`dataset/pool.json`)
```jsonc
{ "item_id": "decisions-007",
  "candidates": [
    { "doc_id": "Curated/wiki/meetings/2026-05-18-...calibration.md",
      "sources": ["search", "search_vault", "keyword", "behavioral"] },
    { "doc_id": "Curated/sources/p-2026-05-18-...md", "sources": ["keyword"] }
  ] }
```

### 11.3 Judgment (`dataset/judgments.json`)
```jsonc
{ "item_id": "decisions-007", "doc_id": "Curated/wiki/meetings/...calibration.md",
  "label": 2, "reason": "states the P50/P55/P60 moves explicitly",
  "label_provenance": "llm+human" }
```

### 11.4 Scorecard aggregate (`results/<date>-scorecard.json`)
```jsonc
{
  "run": { "date": "2026-07-06", "provider": "bedrock-titan",
           "db_doc_count": 22856, "db_newest_indexed_at": "2026-07-06T10:35:00Z",
           "k": 10, "any_degraded_runs": false },
  "by_category_tool": [
    { "category": "hot-topics", "tool": "search", "scope": "full",
      "n": 18, "recall_at_k": 0.55, "recall_at_k_ci": [0.34, 0.74],
      "precision_at_k": 0.60, "mrr": 0.48, "median_first_rank": 3,
      "latency_ms_median": 118, "latency_ms_p95": 190,
      "response_tokens_median": 1600,
      "delta_vs_search_vault": { "recall_at_k": -0.12, "latency_ms_median": -6200 },
      "failure_breakdown": { "not_ingested":0,"not_indexed":3,"ranked_poorly":4,"unusable":1 } }
  ],
  "routing": { "overall_accuracy": 0.31, "by_month": { "2026-05": 0.10, "2026-07": 0.55 } },
  "coverage": [ /* §11.5 rows */ ]
}
```

### 11.5 Coverage funnel row
```jsonc
{ "prefix": "Plaud/", "on_disk": 591, "in_fts": 0, "in_embeddings": 0,
  "drop_disk_to_fts": 591, "drop_fts_to_emb": 0 }
```

### 11.6 Per-run result (internal, `RunResult`)
```jsonc
{ "item_id": "decisions-007", "tool": "search",
  "returned": [ { "path": "...", "rank": 0, "final": 0.42, "excerpt": "...",
                  "semantic_sim": 0.71, "keyword_rank": 2 } ],
  "search_mode": "hybrid", "degradation_note": null,
  "latency_ms": 112, "response_chars": 1840, "response_tokens": 470,
  "recall_at_k": 1.0, "precision_at_k": 0.4, "rr": 1.0,
  "failures": [ { "doc_id": "...", "cause": "ranked_poorly", "evidence": "in pool at rank 14" } ] }
```

## 12. Harness execution model & determinism

- **Read-only, single store instance.** Open once via factory against
  `REPO_ROOT`; never sync/upsert. Snapshot `fts_meta` count + max `indexed_at`
  at start and end; abort the run if they differ (index changed mid-run).
- **Ordering:** iterate items deterministically (sorted by id); for each, call
  `search` then `search_vault`, both with `topK/limit = 20` (score at k=10/5 from
  the 20). Isolate latency: run each tool call 3× and take the median (cold-cache
  effects; SQLite page cache warms after first call — report warm median).
- **Provider:** record `config.embeddings.provider`. If `ollama` and the probe is
  down, the run is flagged degraded and excluded from the headline before/after
  (still reported). For a controlled comparison, the run can be repeated with the
  provider forced (env override) to measure hybrid-with-semantic vs keyword-only.

## 13. Token & latency measurement (`tokens.ts`)

- **Chars:** exact `JSON.stringify(payload).length` (mirrors the log's
  `result_chars`, enabling comparison to historical entries).
- **Tokens:** primary metric via the Anthropic tokenizer for the configured
  model (Bedrock Claude); if unavailable offline, fall back to a `cl100k`-class
  local tokenizer and label the column as an estimate. Because the goal is
  *relative* old-vs-new comparison, tokenizer consistency across tools matters
  more than absolute accuracy — the same tokenizer is applied to both tools'
  payloads at the same `detail` level.
- Report tokens at each `detail` level for the current tool (`summary` default,
  plus `metadata`/`full`) to quantify the G5 cost/benefit of richer detail.

## 14. Statistical validity & pass bar

- **Small-n honesty.** 15–25 items/category yields noisy point estimates. Every
  reported recall/precision carries a **bootstrap 95% CI** (1000 resamples over
  items). Deltas vs. baseline are reported with CIs; a delta whose CI crosses 0
  is labeled "not significant."
- **Held-out set.** ~10% of mined items go to `heldout.json`, excluded from any
  prompt/threshold tuning, for an occasional blind check against overfitting.
- **Regression pass bar** (`eval/README.md`, Phase 4): a change **fails** if any
  category's `recall_at_k` point estimate drops > 5% **and** the drop's CI
  excludes 0 vs. the committed baseline, or if median latency regresses > 2×.
  Absent-query specificity must not fall below its baseline.

## 15. Edge cases & failure modes

- **Tool throws** (F10: `localeCompare` bug, `EISDIR`): harness catches per-call,
  records `error`, scores as a total miss for that item, and surfaces it as a
  correctness defect — it must not abort the run.
- **Non-ASCII queries** (the Unicode-stripping bug in `sanitizeFtsQuery`): include
  ≥ 3 accented/non-ASCII items to regression-test that fix.
- **Note deleted/moved since labeling:** `not_ingested` classification; scorer
  skips it from `E` with a warning rather than crashing.
- **Ties in `final` score:** stable sort by (`final` desc, `doc_id` asc) so ranks
  are deterministic across runs.
- **Degraded semantic layer:** never silently averaged into headline numbers
  (§12).
- **Truncated summary prompts (`...`):** prefer the untruncated `claude/`
  transcript; if only the truncated form exists, mark `query_truncated: true` and
  exclude from precision (the query itself is incomplete).
- **Empty `E` after judging** (nothing relevant exists): convert the item to an
  `absent` item or drop it, logged in the mining report.

## 16. Phased delivery

| Phase | Deliverable | Acceptance |
|-------|-------------|-----------|
| **0 — Mining** (start now) | `queries.json` draft + coverage funnel numbers + routing analysis from real log | ≥ 60 items across 4 categories + absent slice; funnel + routing tables printed; implicit-failure items flagged |
| **1 — Harness** | `open-store`, `invoke-*`, `metrics`, `classify`, `coverage`, `tokens`; `pnpm eval:run` produces `RunResult`s | Runs end-to-end against live DB read-only, no index mutation, survives tool exceptions |
| **2 — Pool + judge + calibrate** | `pool.json`, `judgments.json`; **Tom calibration gate** (≥0.8 agreement) | Gate passed and recorded; `label_provenance` on every judgment |
| **3 — Score + report** | `results/<date>-scorecard.{md,json}` + prioritized root-caused defect list | Full-corpus AND scope-matched metrics, CIs, before/after deltas, coverage, routing all present |
| **4 — Regression suite** | Frozen `queries.json`/`judgments.json`, `heldout.json`, pass bar in `eval/README.md` | `pnpm eval` reproducible; documented pass/fail criteria |

## 17. Risks & mitigations

- **Judge unreliability** → calibration gate (§8.3) + provenance + held-out set.
- **Pool incompleteness biases recall** → 4-source pool incl. full-corpus keyword
  sweep + behavioral signal; recall labeled "pooled" (§8.4).
- **Corpus asymmetry rigs the comparison** → scope-matched metrics (§7.6).
- **Harness ≠ real chat behavior** → routing measured from the *real* log (§7.4),
  not the harness.
- **Index moves mid-run** → start/end snapshot guard (§12).
- **Overfitting fixes to the set** → held-out blind items (§14).
- **Degraded semantic layer misread as regression** → liveness recorded, degraded
  runs excluded from headline (§6.3/§12).

## 18. Open questions (resolved during brainstorming)
- Deliverable = plan **and** start executing (Phase 0 now). ✔
- Ground truth = real queries + LLM-assisted labeling, Tom spot-checks → formalized as pooling + calibration gate. ✔
- Baseline = run **both** tools, now scope-matched for fairness (F7). ✔
- Coverage = all four categories + absent slice; Plaud + AI sessions mandatory. ✔
- All seven additional considerations folded in: coverage funnel (§6.1), failure
  taxonomy (§10), routing metric (§7.4), subtype scoring (§7/§9.3),
  robustness/false-success (§7.5), implicit-failure mining (§9.2), standing
  regression suite (§16 Phase 4). ✔

## 19. Phase 3 addendum (2026-07-13) — scoring architecture & concrete resolutions

Phase 2 shipped 2026-07-08 with a materially different ground-truth mechanism
than §8.3 describes: the human calibration gate was retired and replaced by
dual-judge (medium+heavy tier) reconciliation + a behavioral-usage shortcut —
see `2026-07-07-eval-judging-v2-design.md`. Every judgment in
`judgments.json`, regardless of `label_provenance` (`llm` | `behavioral`),
is treated as trusted ground truth for scoring; provenance is a diagnostic
field, not a scoring filter. `judgments.json` has full 73/73 item coverage
(2,278 judgments) as of the I13 fix (2026-07-08, ROADMAP issues log).

Confirmed compatible without re-running anything: `eval/results/2026-07-06-runs.json`
(146 `RunResult`s, variants `grep-first`/`as-deployed` per `eval/run/variants.ts`
— this plan uses that variant naming, not the `search`/`search_vault` tool
naming in §7's original prose) already has ranked hit lists
(`RunHit[]: {path, rank, final}`) for the exact same 73 item ids now in
`queries.json`. No staleness gap.

**Confirmed scope for this phase** (resolves the open questions from §7.6,
§8.2, §14 — all three answered "yes, include now"): report recall/precision/
MRR at k=10 and k=5, for both `E` (label≥1) and `E_primary` (label==2),
for both full-corpus and scope-matched restriction, each with a bootstrap
95% CI (1000 resamples, seeded for determinism).

**The 4 scope-matched folders** (§7.6's "folders `search_vault` can see"),
resolved concretely from `search-vault.ts`'s default folder list
(`[layout.wiki, layout.aiSummaries, layout.sources, layout.review]`) against
the live global config: `Curated/wiki`, `AI Conversations/_summaries`,
`Curated/sources`, `Curated/review`. Scope-matched restriction filters both
`R_k` and `E` to paths under these 4 prefixes before computing metrics.

**Component breakdown** (new `eval/score/` directory, mirrors the existing
`eval/run/` and `eval/pool/` module boundaries):
- `metrics.ts` — pure functions `recallAtK`, `precisionAtK`, `reciprocalRank`,
  each `(returned: RunHit[], relevantDocIds: Set<string>, k: number)`. No I/O.
- `bootstrap.ts` — `bootstrapCI(values, resamples=1000, seed)`, seeded PRNG
  for deterministic, testable output.
- `scope.ts` — the 4-prefix constant above + `restrictToScope(hits,
  relevantIds)`.
- `build-scorecard.ts` — orchestrator (`pnpm eval:score`): reads
  `runs.json` + `judgments.json` + `queries.json` (for category/subtype),
  plus the already-computed `routing-analysis.json` + `coverage-funnel.json`
  (assembled verbatim, not recomputed), and writes
  `eval/results/<date>-scorecard.json` per §11.4.

**Edge cases** — no new decisions, just confirming §15's rules apply as
written: empty `E` excluded from recall (not a divide-by-zero silent zero);
`RunResult.error` scored as a total miss, not skipped; ties trusted via the
harness's already-stable `rank` ordering; a degraded run (`indexChangedDuringRun`
from §12) excluded from headline numbers, flagged in output.
