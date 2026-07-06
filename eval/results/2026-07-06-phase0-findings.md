# Phase 0 — Mining & Diagnostic Findings

**Date:** 2026-07-06
**Scope:** Coverage funnel, real-log routing analysis, query mining, draft eval set.
**Spec:** `docs/superpowers/specs/2026-07-06-carpathi-retrieval-evaluation-design.md`

Phase 0 produced the measurement inputs *and* surfaced three concrete root
causes for "it got worse" — before a single head-to-head eval query has run.
These are diagnostic findings, not yet scored verdicts.

---

## Headline findings

### 1. The semantic/RAG layer does not cover your most important content (G2, F3)
Coverage funnel (`coverage-funnel.json`): FTS indexing is 100% everywhere, but
embeddings are wildly uneven.

| Folder | On disk | In FTS | Embedded | Semantic coverage |
|---|---:|---:|---:|---:|
| **`Plaud/`** | 591 | 591 | **0** | **0%** |
| **`Curated/sources/`** (ingested Plaud + meeting notes) | 10,860 | 10,860 | **1** | **0%** |
| `AI Conversations/` | 7,594 | 7,594 | 7,478 | 98.5% |
| `Curated/wiki/**` | 372 | 372 | 370 | ~100% |
| **Vault total** | — | 22,864 | **7,849** | **34.3%** |

**~11,450 notes — every Plaud recording and every ingested source/meeting note —
have no embeddings at all.** Conceptual/semantic queries about meetings or
recordings can only be answered by BM25 keyword matching; the RAG layer added to
improve things literally doesn't touch your #1 content type. This is an
ingestion/enrichment gap, not a search-algorithm gap. Provider is `ollama`
(`ollama-nomic-embed-text-768`), gated on a runtime probe — if Ollama is down,
semantic search silently disables vault-wide.

### 2. Routing to the fast tool is failing, and got worse over time (G1, F1)
Real-log routing (`routing-analysis.json`), search-class calls:

| Month | Used fast `search` | Rate |
|---|---|---|
| 2026-05 | 9 / 57 | 15.8% |
| 2026-06 | 10 / 126 | 7.9% |
| 2026-07 | 0 / 1 | 0.0% |
| **Overall** | **19 / 184** | **10.3%** |

Latency cost of the miss: `search_vault` median **6,389 ms** (p95 9,893, max
13,149) vs. `search` median **110 ms** — a ~58× penalty on ~90% of searches. The
late-June routing fix did not change real behavior. **This is the most likely
single driver of the "feels slower/worse" experience** and is fixable at the
tool-description / instructions layer, independent of search quality.

### 3. People/entity recall is failing in production (G4)
31 zero-hit searches captured. A cluster are colleague names returning nothing
from **both** `search_entities` and `search_vault`: "Araik Kutunian", "Haik
Asatrian", "Hovannis", "Eric Kubicki". Searching for people you work with and
getting zero results is a concrete recall failure — now seeded as eval items.

### 4. Two live tool bugs (F10)
- `search_vault` crashes on some queries: `b.updated_at.localeCompare is not a function` (sort comparator assumes string `updated_at`; some notes violate it).
- `get_note` on a directory path (`Curated/wiki/digests`) throws `EISDIR`.
Both captured as regression items.

### 5. The hot-topic/digest curator layer is not producing output (G3, F4)
No weekly digest exists ("No weekly digest yet"); `Curated/wiki/digests/` has 8
files, 6 embedded. Hot-topic queries had to be authored synthetically — there is
no organic "what's hot" query in the logs because the surface that would answer
them isn't being generated.

---

## Artifacts produced

| File | Contents |
|---|---|
| `eval/results/coverage-funnel.json` | Full ingestion→FTS→embeddings funnel per prefix |
| `eval/results/routing-analysis.json` | Tool distribution, latency, routing accuracy by month, zero-hits, errors |
| `eval/dataset/mined-log-queries.json` | 172 distinct real search queries from the usage log |
| `eval/dataset/mined-session-queries.json` | 4,799 verbatim user prompts (2,394 full transcript + 2,405 summary) |
| `eval/dataset/behavioral-signal.json` | 119 searches → notes opened ≤5 min after (pooling input, spec §8.1.4) |
| `eval/dataset/queries.json` | **74-item draft eval set** (all `needs_review: true`) |

Draft eval set composition: plaud-ai-session 25 · entities 20 · hot-topics 8 ·
decisions 21. Sources: log 37 · session 28 · synthetic 9. Includes 1 regression
item, 22 known zero-hit recall items, 1 absent stub.

---

## Known limitations of the draft (require the human/LLM refinement pass)

1. **Category labels are heuristic and partly wrong.** Several "entities" items
   are infrastructure keyword-dumps (K8s/cluster/namespace), not people; the
   clean person-name failures were crowded out by a length tiebreaker. Category
   + subtype tagging is the first thing the Phase-2 calibration pass fixes.
2. **Subtypes skew all-`lookup`** (64/9/0/1). No `relationship` items yet; the
   authored absent slice is a single stub. Both need deliberate authoring.
3. **hot-topics is under target** (8 vs 18) — synthetic only, since no organic
   hot-topic queries exist (finding #5). Tom should confirm/expand these.
4. **Some session queries are task requests, not retrieval** (e.g. "find and
   install the Outlook MCP") — slipped past the filter; human triage needed.

None of these block the pipeline; they are exactly what `needs_review: true` and
the calibration gate exist to resolve.

---

## Recommended next step

Before Phase 1 (harness build), a short **LLM-assisted categorization + triage
pass** over `queries.json` would clean up categories/subtypes, drop non-retrieval
task prompts, promote the clean person-name failures into `entities`, and author
`relationship` + real `absent` items — turning the 74-item draft into a
review-ready set for Tom's calibration gate. This pulls a slice of Phase 2
forward and is the highest-leverage next action.
