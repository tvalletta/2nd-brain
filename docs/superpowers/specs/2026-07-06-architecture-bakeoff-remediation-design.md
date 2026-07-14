# Carpathi Architecture — Bake-Off & Holistic Remediation — Design

**Date:** 2026-07-06
**Status:** Approved design, pending spec review
**Author:** Tom + Claude (brainstorming session)
**Project:** `karpathy` / Carpathi Second Memory (`/Users/valletta/dev/2nd-brain`)
**Track:** B (Architecture remediation) — see `docs/superpowers/ROADMAP.md`
**Depends on:** Track A eval harness (`docs/superpowers/specs/2026-07-06-carpathi-retrieval-evaluation-design.md`)

---

## 1. Purpose

Phase 0 of the evaluation (see `eval/results/2026-07-06-phase0-findings.md`)
showed the current hybrid-search + RAG architecture underperforms for concrete,
measurable reasons — and that the plain keyword approach Tom originally liked may
be competitive or better. Rather than redesign on opinion, this project **decides
the retrieval architecture empirically** (a measured bake-off), then **remediates
the whole architecture holistically** toward the winner.

**Decision, not preference.** No architectural commitment is made until the
bake-off scores are in. The harness — not intuition — picks the direction.

## 2. Goals (inherited from Track A / Tom's north star)

- **G1** fast + token-efficient retrieval, accuracy overriding.
- **G2** complete capture of Plaud + AI-harness sessions, reaching the index.
- **G3** hot/curated content findable fast.
- **G4** not missing important files (recall).
- **G5** right detail, efficiently.
- **New for Track B — G6 simplicity:** prefer the architecture with the smallest
  operational/maintenance surface that meets the accuracy bar. The simple version
  felt better; the design must give simplicity real weight.

## 3. Structure — two stages

```
Stage 1: BAKE-OFF (decide)                Stage 2: REMEDIATE (build toward winner)
  ┌───────────────────────────┐            ┌──────────────────────────────────┐
  │ variant runner (Track A P1)│            │ architecture-independent fixes    │
  │  arms: grep-first,         │  verdict   │  routing, entity recall, bugs,    │
  │        full-cov hybrid,    │ ─────────► │  ingestion completeness           │
  │        as-deployed (ref)   │            │ architecture-dependent fixes      │
  │ weighted scorecard         │            │  (embedding pipeline / curation)  │
  └───────────────────────────┘            │  ONLY if hybrid wins              │
                                            └──────────────────────────────────┘
```

Stage 2's architecture-dependent scope is **deliberately deferred** until Stage 1
returns a verdict, so we never build machinery the bake-off would tell us to
delete.

## 4. Stage 1 — The bake-off

### 4.1 Arms (contenders + reference)

| Arm | Definition | Setup cost | Runtime deps |
|-----|-----------|-----------|--------------|
| **A. Grep-first (done right)** | Hybrid store in **keyword-only** mode: FTS5 BM25 + recency fusion, full corpus, embeddings ignored. Approximates "expert grep" but indexed (~110 ms) and covering 100% of notes. | ~zero (already built) | none |
| **B. Full-coverage hybrid** | FTS5 + semantic + RRF + recency, with **embeddings backfilled for the entire corpus** so RAG competes fairly. | high (embed ~15k notes) | Ollama |
| **C. Current as-deployed** *(reference, not a contender)* | Store exactly as it runs today (embeddings at 34% coverage). Establishes the honest "before." | zero | Ollama |

**Implementation of arms (grounded in code):**
- A "variant" = a `HybridStore` instance configured a specific way + an index
  state. All arms reuse `openHybridStoreFromConfig` / `createHybridStore`
  (`src/search/factory.ts`, `src/search/hybrid-store.ts`).
- **Arm A (grep-first):** construct the store with `isProviderAvailable: async () => false`
  (the documented keyword-only switch, `hybrid-store.ts:92`). It ignores
  embeddings entirely → `searchMode: 'keyword-only'`. Runs against the *same*
  index file as C; no index mutation.
- **Arm C (as-deployed):** store opened normally against the live
  `.karpathy/state/embeddings.sqlite` (34% embed coverage). Read-only.
- **Arm B (full-coverage hybrid):** requires embeddings for all docs. To keep the
  experiment controlled and **not mutate production**, backfill into a *dedicated
  eval index copy* (§4.2), then open the store against that copy.

### 4.2 Fair-shot prep for Arm B (embedding backfill)

- Copy the live DB to `eval/state/bakeoff-fullcov.sqlite` (fresh, disposable).
- Run the embedding-index job (`src/jobs/handlers/embedding-index.ts`) over the
  currently-unembedded folders (`Plaud/`, `Curated/sources/`, any residual) until
  `COUNT(DISTINCT doc_id) FROM embeddings` ≈ `COUNT(*) FROM fts_meta`.
- Record: notes embedded, wall-clock + token cost of the backfill, resulting DB
  size delta. **These backfill costs feed Arm B's simplicity score** — RAG must
  "pay" for the machinery it needs.
- Provider = configured `ollama-nomic-embed-text-768`; Ollama must be up.
- This is a controlled/eval copy. If Arm B wins, Stage 2 backfills production as a
  real fix (I1); if it loses, the copy is deleted and I1 becomes moot.

### 4.3 Variant runner (this is Track A Phase 1, generalized)

`eval/run/run-harness.ts` takes a list of `Variant` descriptors and runs the full
eval set against each, emitting per-(item, variant) `RunResult`s (Track A §11.6).
A `Variant` is:
```ts
interface Variant {
  name: 'grep-first' | 'full-cov-hybrid' | 'as-deployed';
  openStore(): HybridStore;   // configured per §4.1
  topK: number;               // default 10 (score @5/@10 from top-20)
  describe: VariantProfile;    // static facts for the simplicity score (§4.5)
}
```
The runner is read-only against production; only Arm B touches its own eval copy.
Latency measured warm-median over 3 calls per item (Track A §12).

### 4.4 Accuracy (from Track A pooling + judge)

Recall@k, precision@k, MRR computed against the pooled, judge-labeled,
Tom-calibrated ground truth (Track A Phases 2–3). Pools are shared across arms
(same queries), so accuracy is directly comparable. Reported full-corpus and
scope-matched (Track A §7.6) — though with search_vault dropped as a contender,
scope-matching matters less; retained for the reference line.

### 4.5 The weighted scorecard (decision rule)

Composite score per arm = weighted sum of four normalized sub-scores in [0,1].
**Weights (approved, tunable):** accuracy **0.50**, latency **0.20**, tokens
**0.15**, simplicity **0.15**.

| Axis | Sub-score derivation |
|------|----------------------|
| **Accuracy** | `0.6·recall@10 + 0.25·precision@10 + 0.15·MRR`, averaged over items (weights within accuracy fixed here; revisit only if degenerate). |
| **Latency** | Normalize warm-median latency across arms: `score = min_latency / arm_latency` (best arm = 1.0). p95 reported but not scored. |
| **Tokens** | `score = min_tokens / arm_tokens` on median response tokens at working `detail`. |
| **Simplicity** | Rubric §4.6, normalized to [0,1]. |

Composite reported per arm overall **and per category** (a mixed verdict — e.g.
"grep wins except hybrid wins hot-topics" — is a legitimate, valuable outcome and
may lead to a *routed* architecture in Stage 2).

**Verdict rule:** highest composite wins. If within 0.03 of each other overall,
**simplicity breaks the tie** (prefer grep-first) — encodes G6 and Tom's stated
lean without overriding a clear accuracy win.

### 4.6 Simplicity rubric (operationalized)

Each arm scored on 5 factors; simplicity sub-score = `1 − (penalty / max_penalty)`.

| Factor | Penalty basis | Grep-first | Full-cov hybrid |
|--------|---------------|-----------|-----------------|
| External runtime dependency | Ollama (or any embed provider) required at query time | 0 | 2 |
| Storage footprint | GB of embeddings/index beyond FTS | 0 | ~1 (GB-scale) |
| Background maintenance jobs | # of jobs needed to stay correct (embedding sync, enrichment, re-embed) | 0 | 2 |
| Failure modes | # of ways retrieval silently degrades (e.g. provider down → keyword-only) | 0 | 1 |
| Code/config surface | relative modules/LOC the arm strictly requires | low | high |

Penalties are recorded as concrete facts from §4.2 (deps, GB, jobs), not guesses.
Max penalty normalizes to [0,1].

### 4.7 Bake-off output

`eval/results/<date>-bakeoff.md` + `.json`: per-arm composite + per-axis + per-
category breakdown, the backfill cost ledger, and an explicit **verdict + one-
paragraph rationale**. This is the input to Stage 2.

## 5. Stage 2 — Holistic remediation

Scoped after the verdict. Two buckets:

### 5.1 Architecture-independent (do regardless of winner)
- **I2 routing** — the 🔴 headline. If grep-first wins, `search_vault` and the
  slow path are deleted and `search` is the sole/obvious tool (routing problem
  largely evaporates). If hybrid wins, fix the tool-description/instructions layer
  so the fast tool is actually chosen. Either way, measured by re-running the
  harness + re-checking the real usage log routing rate.
- **I3 entity/people recall** — solved inside the winner: a real entity/alias
  index and/or metadata-filtered lookup so colleague-name queries stop returning
  zero. Regression-tested by the zero-hit eval items.
- **I4/I5 bugs** — `localeCompare` crash and `EISDIR` on directory reads: fix +
  add the offending queries as permanent regression items.
- **Ingestion completeness (G2)** — confirm Plaud + AI sessions reach the index
  (Phase 0 showed FTS at 100%; keep the coverage funnel as a standing check).

### 5.2 Architecture-dependent (only if hybrid wins)
- Production embedding backfill (I1) + a reliable re-embed/sync job to prevent the
  coverage from decaying again.
- Digest/curation (hot-topics) layer (I6) — invest only if hot-topics accuracy in
  the bake-off justifies it, and only in the winning architecture's terms.
- Ollama operational hardening (probe, restart, graceful degradation UX).

If grep-first wins, §5.2 largely becomes **deletion work** (remove the embedding
pipeline, Ollama dependency, enrichment backlog) — a simplification, tracked as
its own plan.

## 6. Data models

### 6.1 VariantProfile (simplicity inputs)
```jsonc
{ "name": "full-cov-hybrid",
  "runtime_deps": ["ollama"],
  "storage_gb_beyond_fts": 1.0,
  "maintenance_jobs": ["embedding-index", "embedding-sync"],
  "silent_degradation_modes": ["provider-down->keyword-only"],
  "code_surface": "high" }
```

### 6.2 Bake-off scorecard
```jsonc
{
  "run": { "date": "2026-07-06", "eval_set_version": "…", "k": 10 },
  "backfill_ledger": { "notes_embedded": 15000, "wall_clock_min": 40, "db_size_delta_gb": 1.0 },
  "arms": [
    { "name": "grep-first",
      "accuracy": { "recall_at_10": 0.71, "precision_at_10": 0.55, "mrr": 0.62, "sub": 0.66 },
      "latency": { "median_ms": 110, "p95_ms": 190, "sub": 1.0 },
      "tokens": { "median": 1400, "sub": 1.0 },
      "simplicity": { "penalty": 0, "sub": 1.0 },
      "composite": 0.80,
      "by_category": { "hot-topics": { "composite": 0.62 }, "entities": { "composite": 0.74 } } }
  ],
  "verdict": { "winner": "grep-first", "margin": 0.06, "rationale": "…", "mixed": false }
}
```

## 7. Dependencies & sequencing

1. **Track A Phase 1 (variant runner)** — first build; serves both tracks. *This
   is the immediate next action.*
2. **Track A Phase 2–3** (pooling, judge, calibration, scorecard) — produces the
   accuracy numbers the bake-off consumes. The calibration gate also does the
   draft-set triage flagged in Phase 0.
3. **Arm B backfill prep** (§4.2) — can run in parallel with Phase 2 labeling.
4. **Run bake-off** (§4.7) → verdict.
5. **Stage 2 remediation** — scoped from the verdict; its own spec + plan.
6. **Track A Phase 4** (regression suite) — freezes the eval set so Stage 2 fixes
   are guarded and re-provable.

## 8. Risks & mitigations

- **Unfair Arm B** if backfill incomplete → gate the run on `emb ≈ fts` count.
- **Backfill mutates production** → dedicated eval copy (§4.2).
- **Small-n noisy composite** → carry Track A bootstrap CIs into the composite;
  the 0.03 tie-band prevents over-reading noise as a winner.
- **Simplicity scoring subjectivity** → rubric uses recorded facts (deps, GB,
  jobs), not opinion; weights are explicit and tunable.
- **Mixed verdict ignored** → per-category composite is a first-class output; a
  routed/hybrid-of-approaches architecture is an allowed Stage-2 outcome.
- **Ollama down during Arm B/C** → runner records `searchMode`; a degraded run is
  flagged and re-run, never scored as the arm's true result (Track A §6.3).

## 9. Open questions (resolved during brainstorming)
- North star = **prove empirically then decide** (not fix-in-place, not opinion). ✔
- Arms = **grep-first** + **full-coverage hybrid**; as-deployed kept as free
  reference; structured/entity-aware folded into the winner as a capability, not a
  separate arm (entity recall stays I3). ✔
- Decision rule = **weighted scorecard**, accuracy 0.50 / latency 0.20 / tokens
  0.15 / simplicity 0.15, simplicity breaks a ≤0.03 tie. ✔
- Harness generalized to a **variant runner** = Track A Phase 1, serving both
  tracks. ✔
- Stage 2 architecture-dependent scope deferred until the verdict. ✔

## 10. Arm B backfill addendum (2026-07-14) — scope + concrete architecture

**Real backfill scope, resolved with Tom (2026-07-14):** the live index has
15,705 unembedded docs as of 2026-07-13, close to §4.2's ~15k estimate —
but ~3,590 of them are under `raw/<date>/` folders, which are pre-ingestion
staging content, not curated/retrievable target material (curated content
already has a canonical home under `Curated/sources/` or `Plaud/`). Backfill
scope is the folders §4.2 actually named: `Plaud/`, `Curated/sources/`,
`AI Conversations/` — **~12,115 docs**, `raw/` explicitly excluded.

**Real throughput, measured against the live Ollama instance (nomic-embed-text,
already running) before committing to an implementation approach:** a single
cold-start embedding call took ~667ms (one-time model load), but warm,
realistic ~4000-char chunks at concurrency 6 sustained ~21 calls/sec. At that
rate the full ~12,115-doc backfill (with most notes producing 1 chunk, some
producing more) is a **~15-20 minute operation**, not the multi-hour one the
raw estimate implied — so this does not need persistent cross-session
checkpointing, just crash-safety (idempotent target re-selection) and
progress logging.

**Concrete architecture:** new `eval/state/backfill-arm-b.ts`, standalone
(not wired into the job queue, mirroring `eval/pool/`'s and `eval/score/`'s
orchestrator pattern):
1. Copy the live `.karpathy/state/embeddings.sqlite` to
   `eval/state/bakeoff-fullcov.sqlite` (fresh each run — reflects current
   production state, never mutates it).
2. Open a `HybridStore` against the copy via the existing
   `openVariantStore(config, dbPath, opts)` (`eval/run/open-store.ts` —
   already supports an arbitrary db path; no changes needed there, this is
   the first non-Track-A-harness caller).
3. Select targets: doc_ids in the copy's `fts_meta` under `Plaud/`,
   `Curated/sources/`, `AI Conversations/` with zero rows in `embeddings`.
4. Backfill: mirror `src/jobs/handlers/embedding-index.ts`'s exact chunking
   (`chunkText(body, 1200, 4000)`) and `store.upsertDoc(path, title, body,
   chunks)` call, run with a bounded concurrency pool (default 6, matching
   the measured real throughput).
5. Progress: log every 500 docs (count, elapsed, rate). A per-doc failure is
   caught, logged, and skipped — never aborts the run (same discipline as
   `judge-full.ts`'s per-item try/catch) — failed doc_ids go in the report.
6. Report: `eval/results/<date>-arm-b-backfill.json`, field names matching
   §6.2's `backfill_ledger` shape exactly so the eventual bake-off assembly
   step can consume it without reshaping:
   ```jsonc
   { "notes_embedded": 12000, "notes_failed": 3, "wall_clock_min": 12.4,
     "token_cost_estimate": 8200000,
     "db_size_before_bytes": 41000000, "db_size_after_bytes": 1100000000,
     "db_size_delta_gb": 1.02, "failed_doc_ids": ["Plaud/2026-03/x.md"] }
   ```
   `token_cost_estimate` uses chars/4, matching `eval/score/tokens.ts`'s
   `measurePayload` convention. This feeds Arm B's simplicity sub-score
   (§4.6/§6.1) — RAG must "pay" for the machinery it needs, and this report
   is that receipt.

**Known limitation (found in final review, 2026-07-14): backfilled docs
carry thinner chunk metadata than natively-indexed docs.** The reference
indexer (`embedding-index.ts`) writes `{ type, title, project_slug, tags,
updated_at }` per chunk; the backfill script writes only `{ type, title }`
— so `eval/state/bakeoff-fullcov.sqlite` is metadata-heterogeneous: the
~7,851 docs already embedded in production carry full metadata, the
~19,638 backfilled docs carry two fields. `hybrid-store.ts` reads
`metadata.project_slug` for its project-scoped filter and
`metadata.updated_at` for its recency fallback — a project-scoped query
against Arm B would silently exclude every backfilled doc. **Not fixed**:
re-embedding ~19,638 docs solely to enrich metadata would cost another
~37 minutes for a currently-inert risk — confirmed by direct check that
neither `eval/run/*.ts` nor `eval/score/*.ts` (the actual bake-off harness)
ever constructs a `projectSlug`-filtered query, so this gap does not affect
the imminent Track A/B bake-off's real numbers. **Constraint for any future
consumer of `eval/state/bakeoff-fullcov.sqlite`:** do not rely on
project-slug filtering or the `updated_at` recency fallback against this
disposable index without first enriching the backfilled docs' metadata to
match `embedding-index.ts`.
