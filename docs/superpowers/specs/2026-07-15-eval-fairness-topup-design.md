# Eval Set Fairness Top-Up — Design

**Date:** 2026-07-15
**Status:** Approved design
**Depends on:** Stage 1 bake-off verdict; query-taxonomy research findings (this session)
**Track:** A, Phase 3.5 (pre-freeze top-up, before Phase 4's regression suite)

## 1. Problem statement

Real-usage-mined query taxonomy analysis (this session) found the 73-item eval set has a genuine coverage gap relative to the original design's own stated intent (`2026-07-06-carpathi-retrieval-evaluation-design.md` §7, §9.3): `subtype: relationship` and `subtype: absent` are both defined in the schema but appear **zero times** in the real dataset, and zero queries resemble the classic "I don't remember what I called it" fuzzy-recall archetype that the retrieval literature says favors semantic search. This isn't fabricated concern — it's a direct count from reading all 73 real query texts.

Separately: `eval/dataset/author-absent.ts` already exists as working tooling for authoring `absent` items, but its last real run (documented as issue I9) found 0/10 candidates confirmed absent, because the hybrid variants' `final` score clustered in a narrow ~0.11-0.16 band regardless of topic — a scoring-floor artifact, not a real match. **Re-running it today (this session) reproduces the exact same bug on the current, freshly-rebuilt indexes** — both `as-deployed` and `full-cov-hybrid` score all 10 deliberately-irrelevant candidates (kubernetes tuning, chess openings, sourdough starters, marathon training — nothing this professional vault should contain) in that same narrow band, while `grep-first` correctly scores 0 or near-0 for 7 of the 10 and low-but-nonzero for the other 3. I9 is real, current, and unresolved — but it's specific to the hybrid scoring path, not grep-first.

## 1.1 Cross-spec sequencing dependency

`grep-recall-improvements-design.md`'s AND-first/OR-fallback change (its §3) will change grep-first's scoring behavior on some of the exact candidate queries this spec's §3.1 confirms as absent — OR-fallback is strictly more permissive than today's AND-only matching, so some borderline candidates could newly surface a low-confidence false-positive hit under OR that AND correctly excluded. Since the eval set should reflect the *actual* production behavior going forward, **the grep-recall-improvements plan should land and be verified before this spec's absent-item authoring runs**, so `author-absent.ts` is confirming absence against the real, final grep-first behavior, not a soon-to-change intermediate state.

## 2. Non-goals

- Not re-litigating the Stage 1 verdict — this is instrumentation for the *next* bake-off (if one ever happens) and for freezing a fair Phase 4 regression baseline, not a request to re-run this one.
- Not fixing I9 (the hybrid scoring-floor bug) as part of this spec — noted as a real, separate, still-open issue (flagged for Sub-project 3's attention, since it affects trust in any future semantic-path confidence signal), but out of scope here. This spec routes around it (§3.1).
- Not re-authoring or re-triaging the existing 73 items — purely additive.

## 3. Design

### 3.1 `absent` items: use `author-absent.ts`, gated on grep-first alone

Given I9 makes the hybrid variants' scores meaningless for this purpose, change `isConfirmedAbsent`'s gating from "all variants must score low" to "grep-first alone must score at or near zero." This is a legitimate, not-a-workaround choice: grep-first is now the actual production-bound architecture per the Stage 1 verdict, so confirming absence against it specifically is confirming exactly what matters going forward. Concretely:

- Change the confirmation logic to check only the `grep-first` variant's top-1 `final` score against a threshold (reuse the existing `DEFAULT_SCORE_THRESHOLD = 0.02`, recalibrated if needed once real scores are visible — grep-first's real scores for the 10 existing candidates ranged from `0` to `0.065`, so the threshold may need a small bump, e.g. to `0.07`, to correctly admit the borderline cases — verify against real output before finalizing, don't guess a number in the abstract).
- Re-run against the current 10 candidate queries first (cheap, already written) to see how many now pass under the grep-first-only gate.
- Author 2-4 additional candidate queries if fewer than 5-8 pass, to reach the design's originally-intended 5-8 item absent slice (§9.3 of the original design).
- This produces real `subtype: absent`, `category: decisions` items (matching the existing script's category choice) appended to `queries.json`.

### 3.2 `relationship` items: 3-5 new, hand-authored

Genuine entity-graph-walk queries — e.g. "who on the architecture council also works on GenStudio," "which of Tom's direct reports are also involved in the AI curriculum project" — require:
1. Reading real entity notes and their existing `relationships` field (already extracted by `entity-extractor-rich.ts` per the architecture research) to find genuine, verifiable multi-hop connections in the actual vault content — not inventing plausible-sounding but unverifiable questions.
2. For each candidate query, manually confirming (by reading the relevant notes directly) what the correct answer set actually is, so these items have a clear, defensible ground truth before they ever reach the LLM judge — this is the same rigor the original mining pipeline used for real queries, just applied to hand-authored ones.
3. `category: entities`, `subtype: relationship`, `source: synthetic`, `source_ref: author:relationship-authored`.

### 3.3 Fuzzy-recall items: 3-5 new, hand-authored

Genuine paraphrase-only queries with no proper nouns/dates/exact terms — modeled on the `decisions` category's real query style (the one category where hybrid already showed relative strength in the bake-off), but deliberately stripped of any named entity, e.g. instead of `decisions-001`'s literal "AI code review production readiness trust," something like "that time we talked about whether we can actually trust AI-written code without a human checking it first" with no tool/person/project name at all. Each needs the same manual ground-truth-confirmation step as §3.2.

- `category: decisions` (matching where the taxonomy analysis found the closest real precedent) or a new lightweight tag if that misrepresents them — **resolve this naming choice during plan-writing by checking whether the existing `EvalItem.category` enum needs a 6th value or whether shoehorning into `decisions` is honest enough; don't decide it here without checking the schema's downstream consumers** (the scorecard/bake-off code groups by whatever category string appears — adding a 6th category value is mechanically free per Track A Phase 3's design, since `build-scorecard.ts` groups dynamically).

### 3.4 Pipeline integration

`eval/pool/build-pool.ts` and `eval/pool/judge-full.ts` both process every item currently in `queries.json` — this is not selectively scoped to "new" items today. Appending the ~15 new items directly to `queries.json` (via each authoring step in §3.1-§3.3) and then re-running the existing `pnpm eval:pool` + `pnpm eval:judge-full` will naturally re-pool and re-judge **everything**, including the already-judged 73 items — wasteful (real LLM cost) but not incorrect, since `judge-full.ts`'s target-selection is idempotent per-item (matches the same "resume, don't restart" discipline established in the Arm B backfill work). **The plan should add an item-ID filter option to `build-pool.ts`/`judge-full.ts` (e.g. `--only <id-prefix>`) so only the new items are pooled/judged**, avoiding an unnecessary re-spend on the 69-73 already-settled items — this is a small, well-scoped addition to already-existing scripts, not a rewrite.

### 3.5 Re-scoring

After the new items are pooled, judged, and merged into `judgments.json`, re-run `pnpm eval:run` (harness pass, now against 73+~15 items), `pnpm eval:score`, to get updated per-category numbers including the new `absent`/`relationship`/fuzzy-recall slices. This does **not** require re-running `pnpm eval:bakeoff` unless Tom specifically wants to see whether the top-up changes the composite verdict (it plausibly could nudge accuracy numbers slightly, given more items, but the margin (0.491) is large enough that a ~15-item addition is very unlikely to flip it — worth checking, not worth assuming either way).

## 4. Data model

New `EvalItem`s follow the existing schema exactly (`eval/dataset/types.ts`):
```jsonc
{ "id": "absent-004", "query": "...", "category": "decisions", "subtype": "absent",
  "source": "synthetic", "source_ref": "author:absent-verified",
  "intent": "robustness: system should return nothing / low-confidence",
  "is_regression": false, "query_truncated": false, "needs_review": false }
```
No schema changes needed unless §3.3's category-naming question resolves toward a 6th category value.

## 5. Testing strategy

- `author-absent.ts`'s changed gating logic gets a direct unit test (fake `Variant`/store returning controlled scores, confirming grep-first-only gating behaves as intended, matching this codebase's existing DI-testable convention for eval scripts).
- The new `--only` filter on `build-pool.ts`/`judge-full.ts` gets a unit test confirming it correctly scopes to matching item IDs and leaves existing pool/judgment entries for other items untouched.
- The manually-authored `relationship`/fuzzy-recall items' ground truth is verified by direct note-reading before authoring (§3.2, §3.3) — this is a process discipline, not an automated test.

## 6. Risks & mitigations

- **Re-judging already-settled items wastes real LLM spend.** Mitigated by §3.4's `--only` filter — must be built before running the real pooling/judging pass, not after.
- **I9 (hybrid scoring floor) could resurface if this spec's absent-gating logic is ever generalized to include hybrid variants.** Mitigated by explicitly gating on grep-first alone (§3.1) and documenting why, rather than silently working around it.
- **Hand-authored relationship/fuzzy-recall items could be unfair/unverifiable if ground truth isn't confirmed carefully.** Mitigated by the explicit manual-verification step in §3.2/§3.3 before any item is added.
