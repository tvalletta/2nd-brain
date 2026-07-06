# Carpathi Retrieval Evaluation — Design

**Date:** 2026-07-06
**Status:** Approved design, pending spec review
**Author:** Tom + Claude (brainstorming session)
**Project:** `karpathy` / Carpathi Second Memory (`/Users/valletta/dev/2nd-brain`)

---

## 1. Problem statement

Carpathi's retrieval used to feel fast and expert when it was plain grep + file
access. The team then layered in a hybrid search stack (SQLite FTS5 + BM25 +
Reciprocal Rank Fusion, plus an optional Ollama semantic/embedding pool) and a
weekly hot-topic/digest curation layer on top. **Subjectively, retrieval got
worse, not better** — answers feel less accurate, miss important files, or come
back slower than they should.

There is **no evaluation set and no benchmark anywhere in the repo** (confirmed
by grep for eval/benchmark/golden/ground-truth — only unit tests with synthetic
fixtures exist). So "it got worse" is currently an unfalsifiable feeling. This
project builds the missing measurement instrument, uses it to produce a
before/after verdict, and turns it into a standing regression suite so the
system can never silently regress again.

## 2. Goals (grounded in Tom's stated objectives)

The system Tom wants, restated as measurable objectives:

1. **G1 — Quick, efficient access to notes.** Retrieval must be fast in wall
   clock and cheap in tokens, while maximizing accuracy. Accuracy is the
   overriding goal; speed and token cost are co-equal secondary constraints.
2. **G2 — Complete capture.** Everything Tom cares about — especially **Plaud
   recordings** and **all AI-harness (Claude Code / Cursor) sessions on this
   machine** — must actually make it into the vault *and* into the search index.
   Retrieval quality is meaningless for content that was never ingested.
3. **G3 — Hot/curated content is findable fast.** The curator/digest layer is
   supposed to surface the hottest, most important, most related material
   quickly. This must demonstrably work, not just exist in spec.
4. **G4 — Not missing important files.** The top failure mode Tom named is the
   system omitting files that should have surfaced. Recall on
   known-relevant notes is the headline metric.
5. **G5 — Right detail, efficiently.** Answers should carry the right amount of
   detail (correct `detail` level, un-truncated snippets) without wasting tokens.

**Overriding principle (Tom's words):** best accuracy overall, delivered in the
most token- and wall-clock-efficient way possible.

## 3. What we already know (grounding audit findings, 2026-07-06)

These findings shape the design and are treated as hypotheses the eval must
confirm or refute — not settled facts.

| # | Finding | Evidence | Implication for eval |
|---|---------|----------|----------------------|
| F1 | **Routing failure is live and severe.** The slow deprecated `search_vault` was called **165×** at a **6.4s median / 13s max**; the fast `search` only **3×** at ~110ms. | `.karpathy/logs/mcp-usage.jsonl` (349 entries) | Tool-routing accuracy must be a first-class metric (§7.3). This alone may explain most of "it feels worse." |
| F2 | **Zero zero-result calls in 349.** | usage log | RRF nearly always returns *something*. Must inject known-absent queries to test false-success (§6.5). |
| F3 | **Semantic layer coverage gap.** FTS index = 22,856 docs; embeddings = 18,685 (~82%). ~4,200 indexed notes are FTS-only. Prior audit noted a 7,344-note enrichment backlog. | `.karpathy/state/embeddings.sqlite` | Ingestion/coverage check is a separate deliverable from retrieval scoring (§6). |
| F4 | **Hot-topic digest not running.** System banner: "No weekly digest yet — run `karpathy intel digest`." Topic clustering / decay job are stubbed per `specs/intelligence-plan.md`. | intelligence-plan.md, session banner | Hot-topic category failures may be a *data* gap (layer not run), not a *search* gap. Failure taxonomy must distinguish these (§7.2). |
| F5 | **Recent silent regressions already happened.** `audit/15-omniplan-run-audit.md` found a dead sync layer, a recency bug, and a Unicode-stripping bug that shipped; the 2026-06-26 reliability plan found 6 operational defects (stale index, launchd not firing, empty-DB CWD bug). Fix commits exist but **relevance was never verified post-fix** (Task 8 of that plan is an unrun manual checklist). | audit/15, reliability plan, git log | The regression suite (Phase 4) is a real deliverable, not a stretch goal. |
| F6 | **Sources are wired.** Watch paths include `Plaud/`, `AI Conversations/claude/`, `AI Conversations/cursor/`. On disk: 591 Plaud files, 7,591 AI-conversation files (5,005 summaries). | `~/.karpathy/config.json`, live vault | Real queries and ground truth can be mined from authentic content. |

**Live vault:** `/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Obsidian Notes`
**Usage log:** `/Users/valletta/dev/2nd-brain/.karpathy/logs/mcp-usage.jsonl`
**Index DB:** `/Users/valletta/dev/2nd-brain/.karpathy/state/embeddings.sqlite`

## 4. Non-goals

- **Not** re-architecting search or the digest layer in this project. This
  project *measures* and *diagnoses*; fixes are follow-on work informed by the
  scorecard.
- **Not** building a UI. Output is a markdown scorecard + a machine-readable
  results file.
- **Not** depending on a cloud service or vector DB for the eval itself
  (consistent with the system's local-first non-goals). The LLM judge may use
  Bedrock (already the project's configured provider) but the harness and
  scoring run locally and deterministically.
- **Not** grading the *prose quality* of a final chat answer. We grade what the
  MCP tools return (the retrieval substrate), plus how well the right tool/detail
  was chosen — not Claude's downstream writing.

## 5. Success criteria for THIS project

This project succeeds when:

1. A reusable eval set of 60–100 items exists, covering all 4 required
   categories, with human-spot-checked ground truth.
2. A scriptable harness runs the full set against **both** `search` (current)
   and `search_vault` (old baseline) and emits per-category recall, precision,
   latency, and token cost — plus old-vs-new deltas.
3. An ingestion/coverage report quantifies the Plaud + AI-session gap between
   disk → vault → FTS index → embeddings.
4. A prioritized defect list attributes every failure to a **root-cause
   category** (§7.2), so the reader knows what to fix, not just the score.
5. The harness is wired to re-run on demand (`pnpm eval`) so it can guard future
   changes (Phase 4).

## 6. Evaluation dimensions (what we measure)

Retrieval quality decomposes into four independent surfaces. Scoring them
separately is required — a single blended number hides the actual problem.

### 6.1 Ingestion & index coverage (precedes retrieval)
For each required source (`Plaud/`, `AI Conversations/**`), compute the funnel:
**files on disk → notes in vault → rows in FTS → rows in embeddings.** Report
absolute counts and drop-off at each stage. A note that never reached the index
cannot be retrieved; this isolates capture failures (G2) from ranking failures.

### 6.2 Retrieval accuracy
- **Recall@k** — fraction of an item's `expected_notes` present in the top-k
  results (headline metric for G4; "not missing important files").
- **Precision@k / noise ratio** — fraction of returned results that are
  irrelevant (guards against dumping 20 loosely-related notes).
- **MRR / rank-of-first-relevant** — how near the top the first correct note is
  (a correct note at rank 18 is nearly as useless as a miss for G5).

### 6.3 Efficiency
- **Wall-clock latency** per call (median + p95), captured by the harness.
- **Token cost** — token count of the tool response payload at the `detail`
  level used (proxy for G1/G5 cost).

### 6.4 Tool-routing accuracy (from real logs, F1)
For real logged queries, what fraction were served by the *appropriate* tool
(fast `search` / `get_entity` / `get_decisions`) vs. the deprecated slow path
(`search_vault`)? Measured against a rubric mapping query intent → correct tool.

### 6.5 Robustness / false-success (F2)
A dedicated slice of queries about things **known to be absent** from the vault.
Correct behavior = returning nothing / low-confidence, not confidently returning
irrelevant top-k. Scored as a specificity metric.

## 7. Method

### 7.1 Query mining & the eval set (Phase 0)

Real data first; synthetic only to fill gaps.

**Sources of authentic queries:**
1. `.karpathy/logs/mcp-usage.jsonl` — extract `query` args from `search`,
   `search_vault`, `get_related`, and the intent behind `get_entity` /
   `get_decisions` / `get_hot_cache` calls.
2. `AI Conversations/_summaries/` (5,005 files) — mine the questions Tom
   actually asked that triggered vault lookups.

**Implicit failure signal (consideration #6):** during session mining, flag
retry/reformulation/correction patterns (Tom re-asking a question differently,
or expressing that an answer missed something). These are free, authentic
"retrieval failed here" labels requiring no LLM judgment, and seed the hardest
eval items.

**Categories & coverage (all four required):**

| Category | Target items | Query subtype tags (consideration #4) |
|----------|-------------|----------------------------------------|
| Plaud recordings & AI-session history | 20–25 | lookup / synthesis / relationship |
| Entities & relationships | 15–20 | lookup / relationship |
| Hot/curated topics & digests | 15–20 | synthesis |
| Decisions & meeting notes | 15–20 | lookup / synthesis |
| *(cross-cutting)* Known-absent robustness | 5–8 | absent |

Every item is tagged with a **query subtype** — `lookup` (single-fact),
`synthesis` (spans many notes), `relationship` (entity graph walk), or `absent`
— because these stress different subsystems and must be scored separately.

Backfill sparse categories (likely hot-topics, since that tool is auto-invoked
rather than explicitly asked) with synthetic queries built from the vault's own
taxonomy (real entities/projects/decisions), clearly marked `source:"synthetic"`.

### 7.2 Ground truth (hybrid, human-spot-checked)

Per the chosen approach: an LLM judge (Bedrock, the project's configured
provider) reads the relevant vault content and proposes each item's
`expected_notes` + a one-line justification. **Calibration gate:** Tom reviews a
~20-item sample spread across categories *before* the judge labels the rest. Only
after calibration confirms the judge is trustworthy does it label unsupervised.
Miscalibration is caught before it taints the set.

**Failure taxonomy (consideration #2).** Every eval failure is attributed to
exactly one root cause, so the scorecard drives fixes:
- **(a) Not ingested** — the target note isn't in the vault at all.
- **(b) Ingested but not indexed** — in vault, missing from FTS/embeddings
  (sync lag / coverage gap; ties to F3, F5).
- **(c) Indexed but ranked poorly** — present in index, absent from top-k or
  buried (a genuine ranking/search-quality bug).
- **(d) Retrieved but unusable** — in top-k, but wrong `detail`, truncated
  snippet, or missing provenance (G5).
- **(e) Wrong tool** — a better tool existed and wasn't used (ties to F1, §6.4).

### 7.3 The harness (Phase 1)

New code in `2nd-brain/eval/`:
- `eval/dataset/*.json` — the eval set (schema §8.1), committed.
- `eval/run-harness.ts` — for each item, invokes **both** `search_vault` and
  `search` against the live index (calling the store/tool layer directly, not
  through a chat loop — reproducible and cheap over 60–100 items × 2 tools).
  Captures results, latency, and response token count.
- `eval/coverage.ts` — computes the §6.1 ingestion funnel.
- `eval/score.ts` — computes all §6 metrics, applies the §7.2 taxonomy (using
  the judge only for the (c)-vs-(d) distinction where needed), aggregates by
  category and subtype, and diffs new-vs-old.
- `eval/report.ts` — emits the markdown scorecard.
- `package.json` script: `"eval": "tsx eval/run-harness.ts && tsx eval/score.ts && tsx eval/report.ts"`.

### 7.4 Run, calibrate, score, report (Phases 2–3)
Run coverage → run harness → calibration gate → score → generate scorecard +
prioritized defect list to `eval/results/2026-07-06-scorecard.md`.

### 7.5 Regression suite (Phase 4 — real deliverable, consideration #7)
Freeze the calibrated eval set as a versioned fixture. `pnpm eval` becomes the
gate to re-run after any change to search, indexing, enrichment, or the digest
layer. Document a pass bar (e.g., "no category's recall regresses >5% vs. the
committed baseline") in `eval/README.md`.

## 8. Data models

### 8.1 Eval item
```jsonc
{
  "id": "plaud-003",
  "query": "what did the May 18 leadership calibration meeting decide about P50/P55/P60",
  "category": "decisions",              // plaud|entities|hot-topics|decisions
  "subtype": "synthesis",               // lookup|synthesis|relationship|absent
  "source": "session",                  // log|session|synthetic
  "expected_notes": [                   // ground truth (paths, relative to vault)
    "Curated/wiki/meetings/2026-05-18-...calibration.md"
  ],
  "must_not_return": [],                // optional: known distractors
  "intent": "surface the calibration decision + rationale",
  "label_provenance": "llm+human",      // llm|human|llm+human
  "notes": ""
}
```

### 8.2 Per-run result
```jsonc
{
  "item_id": "plaud-003",
  "tool": "search",                     // search|search_vault
  "returned_paths": ["...", "..."],
  "latency_ms": 112,
  "response_tokens": 1840,
  "recall_at_k": 1.0,
  "precision_at_k": 0.4,
  "mrr": 1.0,
  "failure_cause": null                 // null|not_ingested|not_indexed|ranked_poorly|unusable|wrong_tool
}
```

### 8.3 Coverage funnel row
```jsonc
{ "source": "Plaud/", "on_disk": 591, "in_vault": 0, "in_fts": 0, "in_embeddings": 0 }
```

### 8.4 Scorecard aggregate (per category × tool)
```jsonc
{
  "category": "hot-topics", "tool": "search",
  "n": 18, "recall_at_k": 0.55, "precision_at_k": 0.6,
  "mrr": 0.48, "latency_ms_median": 118, "latency_ms_p95": 190,
  "response_tokens_median": 1600,
  "delta_vs_search_vault": { "recall_at_k": -0.12, "latency_ms_median": -6200 },
  "failure_breakdown": { "not_indexed": 3, "ranked_poorly": 4, "wrong_tool": 0 }
}
```

## 9. Phased delivery

| Phase | Deliverable | Notes |
|-------|-------------|-------|
| **0** | Query mining + draft eval set + coverage funnel numbers | Uses real log + sessions; no new runtime code, just analysis scripts |
| **1** | Harness scripts (`run-harness`, `coverage`, `score`, `report`) + `pnpm eval` | Calls store/tool layer directly |
| **2** | Judge labels ground truth; **Tom calibration gate**; full run of both tools | Gate blocks Phase 3 until labels trusted |
| **3** | Scorecard + prioritized, root-caused defect list | The answer to "did it get worse, and why" |
| **4** | Frozen regression suite + pass bar in `eval/README.md` | Guards against future silent regressions (F5) |

## 10. Risks & mitigations

- **Judge unreliability** → calibration gate before scaling (§7.2); every scored
  failure re-checkable against `label_provenance`.
- **Harness-vs-reality gap** (calling tools directly ≠ how Claude calls them in
  chat) → §6.4 routing metric is computed from the *real* usage log, not the
  harness, so the "wrong tool" failure mode is measured against actual behavior.
- **Index moves under us** during a run → snapshot index doc-count + mtime at run
  start; record in the scorecard header for reproducibility.
- **Overfitting fixes to the eval set** → keep a held-back handful of session
  queries out of the committed set for occasional blind checks.

## 11. Open questions (resolved during brainstorming)
- Deliverable = plan **and** start executing now. ✔
- Ground truth = real queries + LLM-assisted labeling, Tom spot-checks. ✔
- Baseline = run **both** old and new tools for a true before/after. ✔
- Coverage = all four categories, Plaud + AI sessions mandatory. ✔
- All seven additional considerations folded in (coverage funnel, failure
  taxonomy, routing metric, subtype tagging, robustness/false-success,
  implicit-failure mining, standing regression suite). ✔
