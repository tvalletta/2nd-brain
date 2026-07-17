# Downstream Answer-Quality Check — Design

**Date:** 2026-07-17
**Status:** Approved design
**Depends on:** eval-methodology-hardening (should run after that plan's eval-expansion component lands, so this check has the largest possible pool of disagreement-driving items to sample from)
**Track:** B, Stage 3 companion — closes the "retrieval accuracy is a proxy, not the real target" gap from the 2026-07-17 peer-review self-critique

## 1. Problem statement

Every eval measurement in this project so far — recall@10, precision@10, MRR, the composite bake-off score — measures whether the *right document* appears in a variant's top-K results. None of it measures whether the *final answer* a user would actually receive is any different, or any worse, when a variant's retrieval differs. This is a real construct-validity gap: retrieval accuracy is a proxy for what Tom actually asked about ("does the vector/RAG approach provide value for answering questions about my notes and finding things in transcripts"), and the proxy could diverge from the target in either direction — grep-first's lower recall on `fuzzy-recall` items might never once produce a worse real answer (if the top-1 or top-3 hit is already sufficient context), or it might matter every time (if the missing docs contained information no other retrieved doc replaces).

This check directly tests the target, not the proxy: for a defined sample of items where variants disagree on retrieval, generate a real answer from each variant's actual retrieved context, then have a blind judge compare the two answers.

## 2. Non-goals

- Not replacing recall/precision/MRR/composite scoring — this is a targeted, small-sample supplementary check, not a wholesale redesign of the eval methodology.
- Not testing every item in the 89(+)-item dataset — only items where variants meaningfully disagree on retrieval (the items where the accuracy-based comparison is actually ambiguous or contested), since those are the only cases where a downstream difference is plausible in the first place. Items where all variants retrieve the same top result don't need this check — there's nothing for it to distinguish.
- Not building a general-purpose "answer quality" framework for ongoing production monitoring — this is a one-time (or occasionally-repeated) research check to inform the current architecture decision, not a new permanent pipeline component (though the code should be reusable if a future bake-off wants to re-run it).
- Not doing this with real human review by Tom for this round (he chose the blind-LLM-judge option) — but the design should make it easy to swap in a human-review step later if a future decision needs stronger evidence.

## 3. Sample selection

### 3.1 Which items

Start with every item in `queries.json` where at least two of the three bake-off contenders (`grep-first`, `as-deployed`, `full-cov-hybrid`) disagree on their top-K retrieved document set in a way that affects the item's relevance-label-based scoring — concretely: any item where one variant's top-3 hit set and another variant's top-3 hit set have less than full overlap, AND the item's ground truth (from `judgments.json`) has at least one relevant document that only some variants actually retrieved. This is computable directly from existing `runs.json` + `judgments.json` data — no new retrieval needed to *identify* the sample, only to generate the downstream answers.

Given the eval-methodology-hardening plan will have expanded the `fuzzy-recall`/`relationship` categories by the time this runs, the disagreement-item pool should be recomputed fresh against the expanded dataset, not limited to the original 5+4 items. Report the real count of qualifying items — no fixed target, this is inherently bounded by how much real disagreement exists in the actual data.

### 3.2 Why disagreement-driven, not random sampling

A random sample would mostly hit items where every variant already retrieves the same documents (per the 2026-07-15/17 bake-off data, this is the common case for `plaud`/`ai-session`/`hot-topics` categories) — testing those tells us nothing new, since there's no retrieval difference for a downstream answer to possibly reflect. Disagreement-driven sampling concentrates the check exactly where it can produce a meaningful result.

## 4. Answer generation

### 4.1 Fixed prompt/agent, only retrieval varies

For each sampled item and each of its 2-3 contending variants, construct a fixed prompt template:

```
You are answering a question using only the provided context. Do not use
any knowledge beyond what's given below — if the context doesn't contain
enough information to answer, say so explicitly rather than guessing.

Question: {item.query}

Context (retrieved notes, in ranked order):
{for each of the variant's top-K (K=5, matching the existing eval's k=10
 pool but capped lower here since context-window cost scales with K and
 5 is enough to test whether the top results are sufficient) retrieved
 docs: doc title/path + full text or a defined truncation}

Answer:
```

Use the same LLM tier/model for every generation (reuse `createLLMForTier(config, tier)` from `eval/pool/llm.ts`, the same infrastructure already used for judging — pick the tier used for judging today, e.g. `medium`, for consistency and cost reasons, not the `heavy` tier, since this is a supplementary check not the primary ground-truth mechanism). The only variable across the 2-3 answers generated per item is which variant's retrieved docs got substituted into the context block — everything else (prompt wording, model, temperature, top-K count) is held fixed. This isolates retrieval as the sole independent variable, which is the entire point of the check.

### 4.2 Handling zero-hit variants

If a variant retrieved zero relevant-or-irrelevant documents at all for an item (a genuine "found nothing" case), generate the answer anyway with an empty context block — the model should say it can't answer, which is itself a meaningful, comparable outcome (a real answer-quality difference: "I don't know" vs. a real, useful answer is exactly the kind of gap this check exists to surface).

## 5. Blind pairwise judging

### 5.1 Blinding mechanism

For each item with N contending variants (2 or 3), generate all pairwise comparisons (N=2 → 1 comparison; N=3 → 3 comparisons, one per pair). For each pairwise comparison, randomly assign which answer is presented as "Answer A" and which as "Answer B" (seeded random assignment, so the run is reproducible, matching this project's existing `mulberry32`-seeded-PRNG convention already used in `eval/score/bootstrap.ts`) — the judge prompt must never reveal which variant produced which answer, only "Answer A" / "Answer B".

### 5.2 Judge prompt

```
You are comparing two candidate answers to the same question, to judge
which one is more helpful and accurate. You do not know which system
produced which answer — judge only on the answers' merit.

Question: {item.query}

Answer A:
{answer text}

Answer B:
{answer text}

Which answer is more helpful and accurate? Respond with exactly one of:
"A" (Answer A is meaningfully better), "B" (Answer B is meaningfully
better), or "tie" (equivalent quality, or the difference doesn't matter
for actually answering the question). Then give a one-sentence reason.
```

Use `extractStructured<T>` (already on `LLMClient`, used throughout the existing judge pipeline) with a small Zod schema: `{ verdict: 'A' | 'B' | 'tie', reason: string }`.

### 5.3 Use the heavy judge tier, matching the existing dual-judge convention

Since this is a genuinely novel, higher-stakes comparison (informing whether the architecture decision needs revisiting, not routine per-item grading), use the `heavy` tier (matching the existing dual-judge reconciliation pattern's higher-quality judge), not `medium` — cost is bounded by the small, disagreement-driven sample size (§3), so the heavier tier is affordable here in a way it wouldn't be for judging the full 89+-item pool.

### 5.4 Aggregation

Report, per pairwise comparison type (e.g. "grep-first vs full-cov-hybrid", "grep-first vs as-deployed"):
- Count of A-wins / B-wins / ties, mapped back to which variant actually won (un-blinding only at the aggregation step, never in the prompt).
- The judge's stated reasons, surfaced in the report (not just the tally) — since a single sentence of "why" per comparison is exactly the qualitative signal that distinguishes "hybrid's extra doc genuinely added a fact grep-first's answer lacked" from "the two answers were functionally identical, the judge just picked one arbitrarily."

## 6. Data model

New file: `eval/results/<date>-answer-quality.json`:

```ts
interface AnswerQualityResult {
  item_id: string;
  query: string;
  answers: Array<{ variant: string; answer: string; retrieved_doc_ids: string[] }>;
  comparisons: Array<{
    variant_a: string;
    variant_b: string;
    blinded_label_a: 'A' | 'B';   // which literal position variant_a was assigned
    verdict: 'A' | 'B' | 'tie';    // as returned by the judge, still blinded
    winner: string | 'tie';        // un-blinded — variant_a, variant_b, or 'tie'
    reason: string;
  }>;
}
```

Plus a rendered `<date>-answer-quality.md` summary (matching the existing `.json`+`.md` pairing convention used by scorecard/bake-off outputs), with an aggregate win/loss/tie table and the per-item qualitative reasons.

## 7. Testing strategy

- Unit test the sample-selection logic (disagreement detection) against small synthetic `runs.json`/`judgments.json` fixtures with known agreement/disagreement patterns.
- Unit test the blinding/un-blinding logic specifically — the seeded random A/B assignment must be reproducible given the same seed, and the aggregation step must correctly map blinded verdicts back to real variant names without ever leaking the mapping into the judge-facing prompt.
- Unit test the Zod schema validation for the judge's structured response (valid `A`/`B`/`tie`, rejects anything else).
- No automated test for "is the LLM's judgment correct" — that's inherent to using an LLM judge at all, same epistemic status as the existing dual-judge relevance grading this whole project already relies on.
- Real execution: run against the actual disagreement-item sample from the live dataset, verified via real file output (`answer-quality.json` exists, has one entry per qualifying item, comparisons count matches the expected N-choose-2 per item).

## 8. Risks & mitigations

- **LLM judge could have systematic bias toward semantically-fluent answers regardless of factual grounding** (a known general risk with LLM-as-judge setups) — mitigated by requiring the judge's one-sentence reason to be reported alongside every verdict, so a human (Tom) can spot-check whether the stated reasons are actually about factual correctness/helpfulness or about surface fluency, and discount the aggregate tally if the reasons look unreliable.
- **Small sample size** — this check is inherently bounded by how many genuine disagreement items exist; if that number turns out very small (e.g. <5), the aggregate win/loss/tie tally should be reported with that caveat explicit, same posture as the retrieval-level fuzzy-recall/relationship findings.
- **Cost** — bounded by disagreement-driven sampling (§3.2) and using the answer-generation step's cheaper tier for generation, heavier tier only for judging; report the real token/cost totals in the output, matching this project's existing practice of reporting real resource costs (see the Arm B backfill's `wall_clock_min`/`db_size_delta_gb` ledger).
- **Context-window truncation for long retrieved docs** — define a per-doc character/token cap for the context block (mirror whatever cap the existing production `search` tool or ingest pipeline already uses, rather than inventing a new one) so answer generation doesn't silently fail or truncate mid-document in a way that unfairly disadvantages one variant's longer or shorter retrieved docs.
