# Track A Phase 2 — Dataset Triage, Pooling, LLM Judge, Calibration — Design

**Date:** 2026-07-06
**Status:** Approved design, pending spec review
**Author:** Tom + Claude (brainstorming session)
**Project:** `karpathy` / Carpathi Second Memory (`/Users/valletta/dev/2nd-brain`)
**Track:** A (Evaluation harness), Phase 2 — see `docs/superpowers/ROADMAP.md`
**Refines:** `docs/superpowers/specs/2026-07-06-carpathi-retrieval-evaluation-design.md` §8 (ground truth via pooling)

---

## 1. Purpose

Track A Phase 1 shipped a reusable variant runner and produced a real latency
baseline (`eval/results/2026-07-06-runs.json`), but recall/precision are still
unmeasurable — there's no ground truth. Phase 2 builds it: clean up the draft
eval set's rough category labels, pool candidate notes per query from multiple
retrieval sources, have an LLM judge grade relevance, and gate scaling on a
human calibration check. This produces `judgments.json`, the input Phase 3's
scorecard needs.

## 2. Grounding: how this codebase already calls LLMs

Researched before designing, to follow existing convention rather than invent
a new one (`src/enrichment/llm-client.ts`, `src/intelligence/significance-gate.ts`,
`src/enrichment/concept-linker.ts`, `src/shared/budget.ts`):

- **Client interface:** `LLMClient.extractStructured<T>(prompt, zodSchema): Promise<T>` —
  the standard for structured output. Prefers the last fenced ` ```json ` block,
  falls back to outermost `{...}`. Temperature `0.1` for structured calls in the
  existing convention.
- **Array-of-judgments precedent exists already:** `concept-linker.ts`'s
  `findConceptLinks` returns `z.array(...)` for a list of candidates in one
  call; `significance-gate.ts`'s `llmGate` is a single-candidate LLM-judge
  (keep/merge/drop) with a zod verdict schema and a fail-open fallback on
  error. Phase 2's judge combines both patterns: array output, per-item batch.
- **Model tiers exist in config** (`~/.karpathy/config.json` `defaults.llm.models.{fast,medium,heavy}`)
  but **no existing call site actually constructs a client per-tier** — every
  current construction path uses the single legacy `config.llm.model` field.
  Phase 2's judge is the first caller to actually resolve `models.medium`
  directly — noted as extending, not following, an established wiring pattern.
- **Daily budget tracker** (`src/shared/budget.ts`, `.karpathy/state/budget.json`)
  caps `medium` at 50 calls/day, shared with real background enrichment jobs,
  and is opt-in per handler (`tryReserve(tier)`) — most handlers don't call it.
  **Decision: Phase 2's scripts do NOT call `tryReserve`.** A ~73-call judge
  run would exceed the medium cap in one run and would otherwise compete with
  or get throttled alongside production enrichment jobs. This is a deliberate,
  manual, one-off research task, not a routine background job — it manages its
  own cost via `--limit`/`--dry-run` flags instead.
- **Prompts are inline template functions in `src/enrichment/prompts.ts`** (role-priming
  first line, `--- BEGIN X ---`/`--- END X ---` delimited blocks, explicit
  fenced-JSON-only closing instruction). Phase 2's prompts follow this shape,
  living in `eval/pool/prompts.ts`.

## 3. Scope decisions (resolved in brainstorming)

1. **Judge granularity: batched per item**, not per candidate. One call per
   eval item grades all its pooled candidates (~30-50) together as a JSON
   array — matches the codebase's existing array-schema convention, is ~73
   total calls instead of thousands, and lets the judge grade candidates
   consistently relative to each other within a query.
2. **Model: medium tier (Sonnet)**, resolved directly from
   `config.llm.models.medium` (see §2's noted gap — this is new wiring).
   Temperature 0. Run outside the shared budget tracker.
3. **Calibration UX: async markdown report.** Not a live chat walkthrough —
   Tom reviews a generated file at his own pace and hands back annotations.
4. **Dataset triage folds into Phase 2 as Step 0**, using the same
   propose-then-spot-check pattern as judge calibration, because the
   calibration sample must be stratified across *correct* categories to mean
   anything.

## 4. Deviations from the Track A spec (§8), stated explicitly

Two changes from the original design, both driven by decisions made after §8
was written:

- **Pool source swap (§8.1 items 1-2):** the spec originally pooled from
  `search` + `search_vault`. This design pools from **`grep-first` top-20 +
  `as-deployed` top-20** instead, both via the Phase 1 variant runner.
  `search_vault` only scans 4 folders (`wiki`, `_summaries`, `sources`,
  `review`) and Track B already retired it as a real architecture contender;
  `grep-first`'s full-corpus FTS is a strict superset of its reach, so nothing
  is lost and the pool stays consistent with Track B's own framing.
- **Candidate context size (§8.2):** the spec said the judge sees "title +
  full body (or first ~2k tokens if huge)." Because judging is now **batched**
  (up to ~40 candidates in one call, not one candidate per call), full bodies
  would blow the context budget (40 × 2k tokens). The judge instead sees each
  candidate's **title + existing search excerpt** (~300 chars, already
  produced by the search tools as `RunHit.excerpt`) . This is a real
  information reduction — revisit if calibration shows candidates are being
  mis-graded for lack of context (a fallback that fetches full body only for
  candidates the judge flags low-confidence is a natural v2, not built now).

## 5. Step 0 — Dataset triage

**Category/subtype/drop triage** (`eval/dataset/triage.ts`): sends the 74 items
(query, current category, current subtype, source, source_ref, intent — no
candidate content needed) to the judge in chunks of ~25, using the array
pattern. Prompt asks for, per item: `proposed_category`, `proposed_subtype`,
`drop: boolean` (true if the query isn't genuine retrieval intent — e.g. a task
request that slipped through the Phase 0 mining filter), `reason`. Output:
`eval/dataset/triage-proposals.json`. This is NOT auto-applied — it's a
proposal set reviewed alongside judge calibration (§7).

**Absent-slice authoring** (`eval/dataset/author-absent.ts`): NOT LLM-judged —
"is this genuinely absent" is a factual check, not a relevance opinion. The
script proposes 5-8 candidate queries about topics plausibly-askable but
presumed absent from the vault, then mechanically verifies absence by running
each through **both** `grep-first` and `as-deployed` (via the variant runner)
and confirming no result clears a low relevance bar (reusing the top result's
`scores.final` threshold approach from spec §7.5). Only confirmed-absent
candidates are kept; the existing single `<ABSENT-STUB>` placeholder in
`queries.json` is replaced with the confirmed set.

**Known gap, accepted:** synthetic hot-topics items (9 items, `source:"synthetic"`)
have no recorded seed note (they were authored from themes, not tied to a
specific note at creation time) — so pooling for them relies on sources 1-3
(§6) only, never source 5 (seed notes). Methodologically fine: the judge still
grades whatever grep-first/as-deployed/keyword-sweep actually surface against
the query's stated intent.

## 6. Pooling (`eval/pool/build-pool.ts`)

For each eval item (post-triage), pool = union (dedup by `doc_id`) of:
1. Top-20 from the `grep-first` variant (`store.search(query, {topK:20})` via
   the existing `openVariantStore`/`buildVariants` from Phase 1 — direct reuse).
2. Top-20 from the `as-deployed` variant, same mechanism.
3. Top-20 from a raw keyword sweep: `SELECT doc_id, title, snippet(...) FROM notes_fts WHERE notes_fts MATCH :sanitized LIMIT 20` against the full corpus.
4. Behavioral signal: for items whose query text matches (normalized) an entry
   in `eval/dataset/behavioral-signal.json` (Phase 0 output — notes opened
   within 5 minutes of that logged search), those paths are added as
   candidates. Log-sourced items will mostly hit this; session/synthetic items
   mostly won't — expected, not a bug.
5. For synthetic items only, no seed note (per §5's accepted gap).

Each candidate records which source(s) surfaced it (`sources: string[]`),
matching spec §11.2's `pool.json` shape.

## 7. Judge + calibration flow

1. **Judge** (`eval/pool/judge.ts`): for each pooled item, one call with the
   query + `intent` + the pool's candidates (title + excerpt each). Zod schema:
   `z.array(z.object({ doc_id: z.string(), label: z.number().int().min(0).max(2), reason: z.string() }))`.
   Flattened into `eval/dataset/judgments.json` (spec §11.3 shape), with
   `label_provenance: "llm"` initially.
2. **Calibration sample** (`eval/pool/calibration-report.ts`): selects ~20
   items stratified across the (post-triage) categories and subtypes, renders
   a markdown report — query, intent, each judged candidate with its label +
   reason, and a blank line for Tom's agree/correct annotation — to
   `eval/results/<date>-calibration-sample.md`.
3. **Human gate:** Tom reviews and annotates the file. This is an async
   handoff — Phase 2's automated portion ends here; a follow-up step (not
   built until Tom hands back the annotated file) parses corrections,
   computes raw agreement, and only proceeds to full-scale judging (labeling
   the rest of the ~73-item pool, updating `label_provenance` for any item
   Tom corrected to `"llm+human"`) if agreement ≥ 0.8 per spec §8.3.

## 8. File structure (additions to spec §6's tree)

```
eval/
  dataset/
    triage.ts               # Step 0: category/subtype/drop proposals
    triage-proposals.json   # output, reviewed not auto-applied
    author-absent.ts        # Step 0: mechanically-verified absent queries
    queries.json            # (existing, updated with confirmed absent items)
  pool/
    prompts.ts              # inline template prompts, following src/enrichment/prompts.ts convention
    build-pool.ts           # §6: 4-source pooling
    judge.ts                # §7.1: batched LLM judge
    calibration-report.ts   # §7.2: stratified sample -> markdown
    pool.json               # output
    judgments.json          # output
```

## 9. Out of scope for this design (later steps)

- Applying Tom's calibration corrections and computing agreement (gated on him
  handing back the annotated file — a small follow-up task, not part of this
  plan).
- Full-scale judging of the remaining pool beyond the calibration sample
  (gated on the agreement check passing).
- Phase 3 scoring/scorecard (consumes `judgments.json`, separate plan).

## 10. Risks & mitigations

- **Judge sees excerpts, not full bodies** (§4) — may under-inform grading for
  candidates whose relevance isn't obvious from a 300-char snippet. Mitigation:
  calibration sample will surface this directly if it's a real problem (Tom's
  corrections will cluster on excerpt-starved items); a full-body fallback for
  low-confidence candidates is the natural v2.
- **Triage proposals could be wrong** — same risk as judge labels; reviewed in
  the same calibration pass, not auto-applied.
- **Behavioral-signal join is exact-normalized-string match** — will miss
  paraphrased matches. Acceptable: it's one of four pool sources, not the only
  one.
- **New LLM-tier wiring** (§2) is unprecedented in this codebase — first real
  use of `config.llm.models.medium`. Risk is purely "does this actually
  resolve/construct correctly," addressed by the implementation plan's own
  TDD tasks, not a design-level risk.

## 11. Open questions (resolved during brainstorming)
- Judge granularity = batched per item. ✔
- Model = medium/Sonnet, outside shared budget, own cost-control flags. ✔
- Calibration UX = async markdown report. ✔
- Dataset triage = folded in now as Step 0. ✔
- Pool sources = grep-first + as-deployed (not search_vault) + keyword sweep + behavioral + seed notes (synthetic only, with a known gap). ✔
- Judge candidate context = title + excerpt, not full body (necessitated by batching). ✔
