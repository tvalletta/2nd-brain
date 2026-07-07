# Track A Phase 2.5 — Dual-Judge, Behavioral-First, No-Human-Gate Judging — Design

**Date:** 2026-07-07
**Status:** Approved design, pending spec review
**Author:** Tom + Claude (brainstorming session)
**Project:** `karpathy` / Carpathi Second Memory (`/Users/valletta/dev/2nd-brain`)
**Track:** A (Evaluation harness) — supersedes the human-calibration-gate portion of
`docs/superpowers/specs/2026-07-06-eval-phase2-pooling-judge-design.md` §7

---

## 1. Why this exists

The Phase 2 calibration report (`eval/results/2026-07-07-calibration-sample.md`)
asked Tom to manually verify 553 LLM-assigned relevance labels across 20 items —
an unreasonable ask. Worse, the task was structurally backwards: verifying "is
this candidate relevant to this query" requires either already knowing the
answer, or re-doing the retrieval yourself by reading the candidate note — which
is the exact task being evaluated, in reverse. Manual line-by-line verification
doesn't scale and doesn't actually leverage anything a human is better at than
the judge.

This design replaces the human calibration gate with three things that don't
require a human in the loop: **real behavioral evidence** (already collected,
zero cost), **cross-judge agreement** (an automated trust signal, not a human
one), and **a proper fix to a JSON-extraction bug** that becomes more costly to
leave unfixed once nothing is around to notice a silently-skipped item.

## 2. Decisions (resolved in brainstorming)

1. **No human review step**, at least for this pass. Revisit only if downstream
   bake-off results look suspicious.
2. **Cross-judge = a stronger model, not a re-run of the same one.** Primary
   judge stays medium tier (`us.anthropic.claude-sonnet-4-6`, existing
   `judgeItem`); a new heavy-tier (`us.anthropic.claude-opus-4-7`) judge grades
   independently. A second opinion from a stronger model catches systematic
   blind spots a self-consistency re-run of the same model wouldn't.
3. **Behavioral signal is authoritative, not advisory.** For a (query,
   `doc_id`) pair where `doc_id` appears in that query's real
   `behavioral-signal.json` entry, the candidate is marked relevant directly —
   no LLM call spent on it, from either judge.
4. **Full pool, not the 20-item sample.** Judge all 73 pool items (2,280
   candidates) now that "must fit in a human review" no longer constrains
   scope. Real cost: ~73 items × 2 judges ≈ 140-ish real Bedrock calls, net of
   whatever candidates get behaviorally shortcut — a real, acknowledged
   increase from the ~23 calls spent so far.
5. **Fix issue I10 for real**, not just skip-and-log. More items judged
   unsupervised means more silent gaps if it recurs; see §4 for the grounded
   root cause and fix.
6. **Passive telemetry only.** No new instrumentation. Re-mine the existing
   `.karpathy/logs/mcp-usage.jsonl` periodically (documented cadence, not a new
   system) so behavioral ground truth keeps growing for free as Tom uses the
   tool normally.

## 3. What gets retired vs. kept

- **Retired as a required step:** `calibration-report.ts`'s stratified-sample
  selection and the human-facing markdown report generation (`renderCalibrationReport`,
  `writeCalibrationReport`, `stratifiedSample`'s use for gating). The 20-item
  sample and its judgments (`decisions-001` through the rest) are superseded by
  the full-pool run — not reused, since the new run applies behavioral-shortcut
  + dual-judge logic the old sample never had.
- **Kept, repurposed:** `stratifiedSample` itself (a pure, useful function) is
  kept and reused to build a small **diagnostic disagreement log** — not a
  gate, an optional artifact for whenever Tom wants to spot-check something
  specific. No checkboxes, no "Tom's call" — just the flagged items, for human
  eyes only if and when someone chooses to look.
- **Kept, extended:** `judge.ts`'s `judgeItem` (Task 6), `build-pool.ts` (Task
  5), `llm.ts`'s `createLLMForTier` (Task 1) — all unchanged in their existing
  contracts, extended with new capability (§5).
- **Fixed:** `src/enrichment/llm-client.ts`'s `extractJSON` (shared, used well
  beyond eval) and `eval/pool/prompts.ts`'s `judgePrompt`/`triagePrompt` (§4).

## 4. Root cause and fix for issue I10

Read directly (not assumed) from `src/enrichment/llm-client.ts`:

```ts
export function extractJSON(raw: string): unknown {
  const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
  // ... collects fenced ```json blocks, tries JSON.parse on each, last-to-first
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i].trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* try next match */ }
  }
  // Fallback: naive greedy match from the FIRST { to the LAST } in the ENTIRE raw text
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  return JSON.parse(raw);
}
```

Two distinct problems, confirmed against the actual failure
(`Unexpected non-whitespace character after JSON at position 246`):

1. **The model's own JSON is sometimes invalid.** A candidate's title or
   excerpt containing a literal quote character (e.g. a quoted meeting-note
   title) gets echoed by the judge inside a `reason` string without escaping,
   producing genuinely malformed JSON inside the fenced block. `JSON.parse`
   correctly rejects it — this isn't an extraction bug, it's bad model output.
2. **The fallback makes it worse.** When every fenced-block parse fails, the
   code falls through to `raw.match(/\{[\s\S]*\}/)` — a *greedy* regex from the
   first `{` to the *last* `}` anywhere in the raw response. If any trailing
   prose after the intended JSON contains a stray `}` (plausible in a long
   response with many `reason` strings), the match balloons past the real JSON
   end, producing exactly "valid JSON, then trailing garbage" — the observed
   error.

**Fix, two parts:**
- **Prompt-level** (`eval/pool/prompts.ts`): add an explicit instruction to
  `judgePrompt` and `triagePrompt` telling the model to escape any quote
  characters within string values, reducing how often malformed JSON is
  produced in the first place.
- **Parser-level** (`src/enrichment/llm-client.ts`): replace the greedy
  `braceMatch` fallback with a proper scanner that walks the string tracking
  brace depth *and* string/escape state (only counts `{`/`}` when not inside a
  string literal, and correctly skips escaped characters), returning the exact
  substring from the first `{` to its true matching `}`. This is shared code —
  the fix benefits every other `extractStructured` caller in the codebase, not
  just eval, and is purely additive (a correctly-bounded match is a strict
  improvement over a greedy one; it cannot break a case that already worked).

## 5. Judging pipeline changes

### 5.1 Behavioral shortcut
Before calling either judge for an item, partition its pooled candidates:
- Candidates whose `doc_id` appears in the query's matched `behavioral-signal.json`
  entry (join by normalized query text, per Phase 2's existing convention) are
  assigned `label: 2, label_provenance: 'behavioral'` directly.
- Remaining candidates go to the dual-judge path (§5.2). If ALL of an item's
  candidates are behaviorally covered, no LLM call is made for that item at all.

### 5.2 Dual-judge grading and reconciliation
For each item's non-behaviorally-covered candidates, call `judgeItem` twice —
once with the existing medium-tier client, once with a heavy-tier client
(`createLLMForTier(config, 'heavy')`, already supported by Task 1's factory,
just not previously invoked with that tier). Reconcile per candidate:

```ts
const diff = Math.abs(labelA - labelB);
if (diff <= 1) {
  final_label = Math.round((labelA + labelB) / 2);
  disagreement = false;
} else {
  final_label = Math.min(labelA, labelB);  // conservative: don't inflate recall
  disagreement = true;
}
```

`disagreement: true` items are never blocking — they're recorded for the
optional diagnostic log (§3) and nothing else.

### 5.3 Data model (extends Task 6's `Judgment`)
```ts
export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;                                    // final, reconciled label
  reason: string;                                    // primary (medium) judge's reason, or a
                                                       // fixed string for behavioral-provenance items
  label_provenance: 'llm' | 'behavioral' | 'human' | 'llm+human';
  judge_a_label?: number;                             // medium tier, when dual-judged
  judge_b_label?: number;                             // heavy tier, when dual-judged
  disagreement?: boolean;                             // true if |judge_a - judge_b| >= 2
}
```
`label_provenance: 'llm'` now specifically means "dual-judge reconciled," not
single-judge as before — a real, intentional semantic change from Task 6's
original meaning, since single-judge grading is retired for the full-pool run.

### 5.4 Full-pool orchestration
A new script (`eval/pool/judge-full.ts` or similar — exact name decided at
plan-writing time) reads `pool.json` (all 73 items), applies §5.1's behavioral
shortcut, dual-judges the rest per §5.2, and writes the complete
`eval/dataset/judgments.json` — superseding the 20-item partial file from the
retired calibration run. Supports `--dry-run` (prints call-count estimate,
makes zero LLM calls) consistent with every other real-LLM-calling script in
this codebase.

### 5.5 Diagnostic disagreement log (optional, non-blocking)
After the full run, a small report — reusing `stratifiedSample`'s grouping
logic only insofar as it's convenient, not required — lists every candidate
where `disagreement: true`, with both judges' labels and reasons, to
`eval/results/<date>-disagreements.md`. No checkboxes, no gate. Purely for
whenever a human wants to look at *why* something was flagged.

## 6. Ongoing telemetry (passive)

No new logging or instrumentation. `.karpathy/logs/mcp-usage.jsonl` already
captures every real search and any `get_note`/`batch_get_notes` call that
follows it — exactly the signal `eval/mine/parse-usage-log.ts`'s behavioral
extraction already mines (Phase 0). The only change: **document a recurring
cadence** (e.g., re-run `eval:mine`'s behavioral-signal step before any future
full-pool judging run) so `behavioral-signal.json` reflects real usage since
the last run, not a one-time April/May/June/July 2026 snapshot. This is a
process note in `eval/README.md` (or the ROADMAP), not new code.

## 7. Risks

- **Real cost.** ~140 real Bedrock calls at heavy+medium tier, a meaningful
  increase — explicitly acknowledged, not hidden in a "just try it" framing.
- **`label_provenance: 'llm'` semantic change.** Anything downstream (Phase 3
  scoring) reading this field must know it now means dual-judge-reconciled.
  Called out here so it isn't a silent surprise later.
- **Heavy tier availability.** `us.anthropic.claude-opus-4-7` was confirmed
  working with this environment's bearer-token credential during Phase 2's
  security-fix verification — not a new unknown, but worth a real (not just
  dry-run) small-batch check before the full 140-call run.
- **extractJSON fix touches shared code.** Mitigated by the fix being strictly
  more-correct (a properly-bounded match can't be a regression versus a greedy
  one) and by adding real test coverage for the quote-escaping case
  specifically, at plan-writing time.
- **Behavioral-shortcut correctness.** A behaviorally-opened note being marked
  `label: 2` assumes "Tom opened it" implies "it was relevant" — usually true,
  but not guaranteed (people open the wrong note sometimes). Accepted as a
  reasonable approximation; far more reliable than an LLM's guess, not
  infallible.

## 8. Out of scope for this design

- Actually applying this to Phase 3 scoring (consumes `judgments.json`,
  unaffected by *how* judgments.json was produced, per Track A's original
  spec).
- Building any active/interactive telemetry prompt (explicitly declined —
  passive re-mining only, per decision 6).
- Re-litigating the bake-off's own arms or weights (Track B, untouched).
