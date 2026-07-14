# Carpathi Second Memory — Program Roadmap

**Single source of truth** for two interlocking efforts. Update this file at the
end of every working session so no thread is lost across sessions. If you are
resuming work, **start here.**

Last updated: 2026-07-07

---

## Why two tracks

Tom's goal: retrieval that is fast, accurate, token-efficient, and captures all
his content (Plaud + AI sessions). Phase 0 of the eval revealed the current
hybrid-search + RAG architecture underperforms for concrete, architectural
reasons. So we run two tracks that **zipper together**:

- **Track A — Evaluation (the ruler).** Builds the measurement instrument that
  tells us, objectively, whether retrieval is good and whether a change helped.
- **Track B — Architecture remediation (the fixes).** A thoughtful, holistic
  redesign of the retrieval/ingestion/curation architecture, designed against
  measured reality — not vibes, not reactive patches.

**The dependency:** Track B is designed against a *baseline* produced by Track A,
and every Track B change is *validated* by re-running Track A. The eval is the
test harness for the architecture work. Neither track is "done" alone.

---

## Track A — Evaluation harness

Spec: `docs/superpowers/specs/2026-07-06-carpathi-retrieval-evaluation-design.md`

| Phase | Status | Deliverable |
|-------|--------|-------------|
| 0 — Mining & diagnostics | ✅ **DONE** (2026-07-06, commit e772d4f) | `eval/` pipeline, 74-item draft set, findings report |
| 1 — Harness (**variant runner**) | ✅ **DONE** (2026-07-06) | `eval/run/` = pluggable variant runner (grep-first / as-deployed, full-cov hybrid deferred to Track B §4.2); serves Track A *and* the Track B bake-off. Captures hits/latency/tokens per item×variant; wired via `eval:run` |
| 2 — Pool + judge + calibrate | ✅ **DONE** (2026-07-08, full 73/73 coverage after I13 fix) | Triage proposals (`eval/dataset/triage-proposals.json`); pooled ground truth (`eval/dataset/pool.json`); dual-judge + behavioral-shortcut grading (`eval/pool/judge.ts`, `judge-full.ts`, `behavioral-shortcut.ts`) run for real against the live production index: **2,278 judgments across all 73 items** — `label_provenance`: 2,193 `llm` (dual-judge reconciled) / 85 `behavioral` (shortcut fired); 2 disagreements (0.1%). I13 (4 items initially skipped on output-token truncation) root-caused and fixed 2026-07-08; backfilled to full coverage. Supersedes the retired 20-item human-calibration sample; the human calibration gate itself is retired per `2026-07-07-eval-judging-v2-design.md` §3. `eval/results/2026-07-07-calibration-sample.md` remains only as a historical record of Tom's initial (abandoned) review attempt. |
| 3 — Score + report | ✅ **DONE** (2026-07-13, re-scored clean) | `eval/score/{metrics,bootstrap,scope,build-scorecard}.ts` + `pnpm eval:score` → `eval/results/2026-07-13-scorecard.json`: recall/precision/MRR (k=10/k=5, E/E_primary, full-corpus/scope-matched, bootstrap 95% CI) for all 5 categories × 2 variants, plus routing + coverage embedded verbatim. First real accuracy numbers for the whole project — see "You are here" below. Re-scored against a clean `eval:run` (`any_degraded_runs: false`) — numbers matched the earlier degraded run closely, now authoritative for the bake-off. |
| 4 — Regression suite | ⬜ pending | Frozen set + pass bar; guards Track B changes |

**Draft set needed a triage/refinement pass** (categories were heuristic; see
Phase-0 findings §"Known limitations"). Done via the real `eval:triage` run
(2026-07-07): 74 items triaged, 21 flagged `drop` (20 of them `source: session`
— imperative task requests mined from real Claude Code sessions, not genuine
retrieval questions; a coherent, explainable pattern, not a prompt problem).
Corrected categories/subtypes are a **preview** in the triage-proposals file —
not yet applied back to `queries.json`; that's part of the still-open human
gate below.

---

## Track B — Architecture remediation

Status: 🟡 **Arm B backfill done (2026-07-14); bake-off run itself not yet built.**
`docs/superpowers/specs/2026-07-06-architecture-bakeoff-remediation-design.md`
(§10 addendum, 2026-07-14, has the concrete backfill architecture + a known
metadata-parity limitation, documented below).
Structure: **Stage 1 bake-off** (measure grep-first vs full-coverage hybrid on a
weighted scorecard — accuracy 0.50 / latency 0.20 / tokens 0.15 / simplicity 0.15,
simplicity breaks a ≤0.03 tie) → **Stage 2 holistic remediation** toward the
winner (architecture-dependent scope deferred until the verdict). The bake-off
runs on Track A Phase 1's variant runner, so the two tracks share the harness.

**Arm B embedding backfill shipped 2026-07-14**, merged to
`fix/carpathi-mcp-reliability` (commit `c796dcd`), via subagent-driven-development.
`eval/state/backfill-arm-b.ts` (`pnpm eval:arm-b-backfill`) copies the live index
to a disposable `eval/state/bakeoff-fullcov.sqlite` and backfills embeddings for
`Plaud/`, `Curated/sources/`, `AI Conversations/` (confirmed scope with Tom —
`raw/`'s ~3,590 pre-ingestion-staging docs excluded). Real result:
**19,638 of 19,641 in-scope docs embedded** (3 permanent failures, all
pre-ingestion `AI Conversations/_legacy` content), 37.2 min wall-clock, 1.3GB
DB size delta — recorded in `eval/results/2026-07-14-arm-b-backfill.json`
matching spec §6.2's `backfill_ledger` shape exactly. Production's live index
independently re-verified unchanged (7,851 distinct embedded docs) throughout.

**Real incident during this task, worth remembering:** the real ~20-37 min
Ollama-backed backfill run died mid-flight twice during execution — once when
a dispatched subagent's process got silently backgrounded and killed when its
turn ended (see I13/Task-7's earlier precedent this session), and the recovery
attempt surfaced a second, compounding bug (the script unconditionally
re-copied the live DB on every run, which would have destroyed partial resume
progress). Both are fixed: a persisted `eval/state/bakeoff-fullcov.progress.json`
ledger makes cost/baseline-size correctly cumulative across invocations, a
stale-file guard throws if the DB copy exists without a matching ledger, and
the ledger is now written immediately on a fresh copy (not just at run end) so
a genuine mid-run crash can actually resume — this last fix was itself a
final-whole-branch-review catch (the first version only wrote the ledger at
the end, which meant crash-resume didn't really work despite being the whole
point of the mechanism).

**Known limitation, not fixed (§10 addendum):** backfilled docs carry thinner
metadata (`{type, title}`) than natively-embedded docs (`{type, title,
project_slug, tags, updated_at}`) — confirmed the actual Track A/B harness
never filters by `project_slug`, so this doesn't affect the imminent bake-off,
but any future consumer of `bakeoff-fullcov.sqlite` must not rely on
project-scoped filtering or the `updated_at` recency fallback against it.

**Next, still unbuilt:** the actual bake-off run itself (spec §4.3-§4.7) — add
a third `Variant` (`full-cov-hybrid`, pointed at `bakeoff-fullcov.sqlite`) to
the variant runner, run `eval:run` with all 3 arms, then build the weighted-
scorecard assembly (§4.5/§6.2) that combines Track A's real accuracy numbers
(already in hand from Phase 3), the new latency/token numbers for the
full-cov-hybrid arm, and the simplicity rubric (§4.6, now has real backfill-cost
inputs to compute Arm B's penalty) into a verdict.

Design must address the whole retrieval architecture, informed by the issues log
below and the Track A baseline. Candidate scope (to be refined in brainstorm):
- Embedding/enrichment coverage (Plaud + Curated/sources are ~0% embedded).
- Tool routing (fast `search` used only ~10%; instructions/description layer).
- Entity/people recall.
- Ingestion completeness + sync reliability.
- Curator/digest (hot-topics) layer — currently not producing output.
- Correctness bugs.

---

## Issues log (captured as we encounter them — triage into Track B)

Every problem we hit goes here immediately, so "fix holistically later" never
means "forget." Severity: 🔴 high / 🟡 med / 🟢 low.

| # | Issue | Evidence | Severity | Track B disposition |
|---|-------|----------|----------|---------------------|
| I1 | Semantic layer covers only 34% of vault; **Plaud 0/591, Curated/sources 1/10,860 embedded** — RAG doesn't cover Tom's key content | `eval/results/coverage-funnel.json` | 🔴 | enrichment/embedding coverage redesign |
| I2 | Fast-tool routing ~10% and **declining** (May 15.8%→Jun 7.9%→Jul 0%); search_vault 6.4s median vs search 110ms | `eval/results/routing-analysis.json` | 🔴 | routing / tool-description / deprecation strategy |
| I3 | People/entity searches return **zero hits** in production (Araik Kutunian, Haik Asatrian, Hovannis, Eric Kubicki) | `routing-analysis.json` zero_hits | 🔴 | entity index + recall |
| I4 | `search_vault` crashes: `b.updated_at.localeCompare is not a function` | log error | 🟡 | correctness fix (also: is search_vault even kept?) |
| I5 | `get_note` on a directory path throws `EISDIR` | log error | 🟢 | input validation |
| I6 | Hot-topic/digest curator not producing output ("No weekly digest yet") | intelligence-plan, banner | 🟡 | curation/digest layer |
| I7 | `search_vault` scans only 4 folders while hybrid indexes all — corpus asymmetry | `src/mcp/tools/search-vault.ts` | 🟢 | deprecation / consistency |
| I8 | Variant-runner smoke run (Task 5) initially executed against the `.worktrees/feat-eval-variant-runner` copy of `.karpathy/state/embeddings.sqlite`, which was empty (0 rows in `fts_meta`/`notes_fts`/`embeddings`, untracked/gitignored worktree-local state) — unlike the main checkout's index (23,372 docs / 18,685 embeddings). Fixed by symlinking the worktree's `.karpathy` to the main checkout's shared state. Re-running against the real index then surfaced a second issue: the harness's before/after read-only guard threw on any index delta, but the live vault has continuously-running background jobs (intel tick, embedding-index, enrichment) that legitimately mutate `fts_meta` mid-run — so the guard was too eager. Fixed by changing throw→warn and adding an `indexChangedDuringRun` field to the written `HarnessRun` JSON so a genuine mid-run change is recorded, not fatal. Both fixes landed; the re-run then completed cleanly with real baseline numbers (see "You are here"). Keeping this row for institutional memory: worktrees don't share gitignored local state, and the live vault is never static. | `eval/results/2026-07-06-runs.json` (final run: `dbSnapshot.docCount: 23372`, `indexChangedDuringRun` present) | 🟡 | resolved — worktree hygiene fixed via symlink; harness guard fixed via throw→warn |
| I9 | Real `eval:author-absent` run (Task 7, 2026-07-07) confirmed **0 of 10** candidate absent-queries against the live production index — every candidate's `as-deployed` top-1 score landed in a suspiciously narrow 0.08–0.16 band regardless of topic (e.g. "sourdough bread starter maintenance schedule" scored 0.161), all above `DEFAULT_SCORE_THRESHOLD = 0.02`. `grep-first` scored 0 for most, consistent with genuine irrelevance — only `as-deployed` (hybrid) is affected. Pattern (near-identical scores for wildly unrelated queries) looks like a scoring-floor/normalization artifact in the hybrid variant's fusion, not real topical relevance. Not fixed here — deliberately not guessing at a threshold/scoring change without Tom's input. Net effect: `queries.json` now has **zero** `subtype: absent` items (the old `<ABSENT-STUB>` placeholder was removed and nothing replaced it). | `pnpm eval:author-absent` console output, 2026-07-07 | 🔴 | needs investigation: is `as-deployed`'s hybrid score genuinely floor-clamped for top-1 regardless of relevance? If so, this also undermines any future score-threshold-based decisions using that variant, not just absent-query authoring. |
| I10 | Real `eval:calibration` run (Task 7, 2026-07-07): 2 of 20 sampled items (`decisions-001`, 48 pooled candidates; `hot-topics-005`, 53 pooled candidates) failed structured-output extraction with `Unexpected non-whitespace character after JSON`, deterministically (same error on retry). Root cause: several pooled candidate excerpts contain literal double-quote characters (e.g. quoted terms in meeting-note titles under `Curated/wiki/meetings/`); when the judge model echoes them back unescaped inside a `reason` string, `extractJSON`'s regex-based extraction in `src/enrichment/llm-client.ts` breaks. **RESOLVED** (this plan's Tasks 1-2, real fix landed 2026-07-07, not the skip-and-log workaround): `extractJSON` in `src/enrichment/llm-client.ts` now tries every bracket candidate (not just the first) and is string/bracket-aware so embedded quotes/brackets inside string values don't break extraction; `eval/pool/prompts.ts`'s judge/triage prompts additionally instruct the model to escape quotes in `reason` strings. Verified by the real full-pool run (Task 7, 2026-07-07, `judge-full.ts`): **zero** JSON-parse/escaping failures across all 69 successfully-judged items (2,075 judgments, ~146 real calls) — the original error signature did not recur. Two of the 4 items that did fail in the full run hit a *different* bug (see I13), and one hit a transient infra error — neither is a recurrence of I10. | `pnpm eval:calibration` console output, 2026-07-07 (original bug); `src/enrichment/llm-client.ts` (fix, Task 1-2 commits); `eval/dataset/judgments.json` + `task-7-report.md` (verification, 0 recurrences in real full run) | 🟢 | resolved. |
| I12 | Tom caught during calibration review (2026-07-07): the `plaud-ai-session` category conflated two genuinely different sources — Plaud meeting recordings and Claude Code/Cursor AI coding sessions. Beyond being semantically distinct, they have wildly different data health (Phase 0 coverage funnel: Plaud 0% embedded vs AI Conversations 98.5% embedded), so scoring them as one category was averaging away exactly the signal that matters most for diagnosing the RAG layer's gaps. **Fixed**: split into `plaud` and `ai-session` categories across `eval/dataset/types.ts`, `eval/dataset/triage.ts`, `eval/pool/prompts.ts`; re-tagged 28 affected items in `queries.json`/`triage-proposals.json` by reading each query's actual content (19 plaud, 9 ai-session — 3 of the 9 were items the triage judge had proposed moving out of `decisions` into the old combined category, e.g. "are my Claude Code sessions being pulled into the vault" — all clearly ai-session, reinforcing the original catch). Existing item ids were left unchanged (only the `category` field) to avoid breaking cross-references in already-generated `pool.json`/`judgments.json`. The live calibration report's category text was patched surgically (not regenerated) to preserve Tom's in-progress checkmarks. | `eval/dataset/types.ts`, `eval/dataset/triage.ts`, `eval/pool/prompts.ts`, `eval/dataset/queries.json`, `eval/dataset/triage-proposals.json`, `eval/results/2026-07-07-calibration-sample.md` | 🟢 | resolved. Note for later: the split is imbalanced (19 plaud / 9 ai-session) since most mined log queries were meeting-related — worth authoring more ai-session queries when the dataset gets its next refinement pass. |
| I13 | Real full-pool `eval:judge-full` run (Task 7, 2026-07-07) skipped 4 of 73 items with Zod validation errors (`invalid_type: expected "array", received "object"` from `JudgeResponseSchema`). Original triage guessed an object-wrapper response shape; **root cause investigated via systematic-debugging and confirmed by reproduction (2026-07-08), not guessed**: `config.llm.maxTokens` (4096, shared by every LLM tier) is tuned for single-note extraction, not grading a whole candidate pool in one call. Re-running the exact failing prompts directly against Bedrock showed `stop_reason: max_tokens` on 5/6 calls for pools above ~40 candidates — the response is truncated mid-array, and `extractJSON`'s balanced-bracket fallback (the I10 fix) correctly finds the first *complete* value in the truncated stream, which is the first inner candidate object, not the (never-closed) outer array. Not a recurrence of I10 (that was a parse error from unescaped quotes; this is a schema-shape mismatch from truncation), and not the wrapper-object or transient-500 theories originally logged here. | `pnpm eval:judge-full` console output, 2026-07-07; reproduction script capturing `stop_reason`/`usage` against the real endpoint, 2026-07-08 | 🟢 | **RESOLVED (2026-07-08)**: added optional `maxTokensOverride` to `createLLMForTier` (`eval/pool/llm.ts`, eval-only helper — no change to the shared `LLMClient` interface or other call sites) and set it to 8192 for both judge tiers in `judge-full.ts` (covers the largest observed pool, 61 candidates, with headroom). Verified against the real endpoint: all 6 previously-truncated calls now complete with `stop_reason: end_turn`. Backfilled the 4 items with zero ground truth using the fixed code — `judgments.json` now has full 73/73 coverage (2,278 judgments, 2 disagreements, unchanged). Tests: `test/eval/llm.test.ts` asserts the override reaches the outgoing request body. |
| I14 | `eval/score/build-scorecard.ts`'s `main()` hardcoded `eval/results/2026-07-06-runs.json` — re-running `eval:run` for a clean baseline (2026-07-13) produced a new dated file that would have been silently ignored, scoring forever against the stale, degraded run. Not caught in Phase 3's task review because only one `runs.json` file existed in `eval/results/` at review time. | `eval/score/build-scorecard.ts` (pre-fix); `eval/results/2026-07-13-runs.json` (the file that would have been ignored) | 🟢 | **RESOLVED (2026-07-13)**: added `findLatestRunsFile()`, exported and unit-tested, globbing `eval/results/` for `<date>-runs.json` and picking the most recent by filename sort. Verified: re-running `pnpm eval:score` printed `Scoring against eval/results/2026-07-13-runs.json` and picked the new file correctly. |
| I11 | Final whole-branch review of Phase 2 (2026-07-07) found real credential values — a Confluence/Jira Personal Access Token and a Bedrock API key fragment — copied verbatim from three vault session-summary notes (`AI Conversations/_summaries/session-2026-06-01-61078aad.md`, `session-2026-06-05-31c44501.md`, `session-2026-06-11-92b16b0f.md`) into `PoolCandidate.excerpt` and committed to git in `eval/dataset/pool.json` (items `hot-topics-001`, `decisions-014`, `decisions-015`). **Deeper root cause, more important than the eval pipeline's own copy**: these secret values exist in plaintext inside session-summary notes already living in the vault — almost certainly from a past Claude Code conversation where a rotated token/key was pasted into the session and then captured verbatim by the session-summary writer. That means the production search/excerpt system (the same `store.search()`/`fts.query()` this eval pipeline calls read-only) already surfaces this secret material to any matching search query today, entirely independent of this eval work — this plan didn't create that exposure, it just made one instance of it more visible and permanent by committing it to git history. **Fixed**: `eval/pool/redact.ts` adds best-effort regex redaction (KEY=value-style secret assignments by suspicious key name, and long token-like strings after a colon) applied to every excerpt in `buildPoolForItem` before it's stored in a `PoolCandidate`; `eval/dataset/pool.json` was regenerated against the live index and verified to contain zero occurrences of the leaked patterns. **Not fixed / needs human decision**: (a) the underlying vault notes still contain the plaintext secrets and remain searchable/retrievable via the production MCP tools — Tom is rotating the actual credential values separately, but the historical notes themselves have not been scrubbed or redacted at the source; (b) the redaction in `redact.ts` is best-effort regex matching, not a comprehensive secret scanner — it should not be treated as a guarantee for any future committed artifact, and a real secret-scanning tool (e.g. gitleaks/trufflehog in CI, or pre-commit) is the actual fix for "don't commit secrets," this is a stopgap for this one pipeline. | `eval/dataset/pool.json` (pre-fix commit history), `eval/pool/redact.ts`, `test/eval/redact.test.ts`, `test/eval/build-pool.test.ts` | 🔴 | needs human decision: scrub/redact the source vault notes and confirm credential rotation is complete; separately, evaluate adding a real secret-scanning gate (gitleaks/trufflehog) for any future committed eval artifact, since regex-based redaction here is best-effort only. |

---

## You are here

Phase 1 (variant runner) shipped: `eval/run/run-harness.ts` + `pnpm eval:run`
wire `buildVariants` → `executeRun` → `eval/results/<date>-runs.json`, guarded
read-only (warns rather than throws on a live-vault index delta — see issue
I8). After fixing the worktree-local-state and guard issues in I8, a real run
against the live, populated production index (23,372 docs) produced the
first empirical Phase-1 baseline (latency only — accuracy scoring awaits
Phase 2's pooled ground truth): **grep-first** median latency ~27.20ms
(n=73), **as-deployed** median latency ~198.41ms (n=73), **as-deployed**
searchMode 100% hybrid (Ollama was up throughout, no degradation). Hybrid
search costs roughly 7x grep-first's latency in this run — a real cost worth
tracking as Track B's bake-off proceeds.

Phase 2 (pooling + judge + calibration) shipped in two stages. The first
stage (2026-07-07, retired plan) produced triage proposals for all 74 draft
items (21 flagged drop, mostly session-mined imperative task requests — see
the Phase 2 note above), a full candidate pool (`eval/dataset/pool.json`: 73
items, 2280 candidates), and a stratified ~20-item calibration sample judged
by a single LLM judge and rendered to markdown for human review
(`eval/results/2026-07-07-calibration-sample.md`). That human calibration
gate was **retired**, not completed — see
`docs/superpowers/specs/2026-07-07-eval-judging-v2-design.md` §3 for the
rationale (single-judge grading + a human-agreement gate was replaced by
dual-judge reconciliation + a behavioral-usage shortcut, which doesn't need a
human calibration step to trust). `eval/results/2026-07-07-calibration-sample.md`
remains on disk only as a historical record of Tom's initial, abandoned
review attempt — it is not authoritative and was not resumed.

**This plan (feat/eval-judging-v2) then re-ran Phase 2 for real, end to end
(Task 7, 2026-07-07), and it is now DONE.** Fixed I10 for real (Tasks 1-2:
`extractJSON` bracket/string-aware fix + judge-prompt quote-escaping
instructions — see I10's row above for verification). Added dual-judge
reconciliation (`judge.ts`'s `reconcileJudgments`) and a behavioral-usage
shortcut (`behavioral-shortcut.ts`) that trusts real usage signal
(`eval/dataset/behavioral-signal.json`, 119 entries) to skip LLM judging
where it's already confirmed, plus a non-blocking disagreement diagnostic
(`disagreement-report.ts`). Orchestrated by `eval/pool/judge-full.ts`
(`pnpm eval:judge-full`). The real run against the live production index
(~146 real Bedrock calls, medium + heavy tier, per the dry-run estimate)
produced the full-pool `eval/dataset/judgments.json`, **superseding the
20-item calibration-sample file**. Initially: 2,075 judgments across 69 of
73 items (4 skipped — see I13). **Update 2026-07-08:** I13 root-caused
(output-token truncation on large candidate pools, not the originally-
guessed object-wrapper/transient-500 theories) and fixed; backfilled the 4
missing items. Final: **2,278 judgments across all 73 items**. Provenance:
2,193 `llm` (dual-judge reconciled) + 85 `behavioral` (shortcut fired,
proving it works end to end). Disagreements: 2 out of 2,278 (0.1%) —
written to `eval/results/2026-07-08-disagreements.md`, a small fraction
well under the 20% flag-worthy threshold. I9 (author-absent, 0/10
candidates — `queries.json` has zero `absent`-subtype items) remains open
and is out of scope for this plan.

**Phase 3 (scoring/scorecard) shipped 2026-07-13**, merged to
`fix/carpathi-mcp-reliability` (commit `27db644`), via subagent-driven-
development in an isolated worktree (`.worktrees/feat-eval-phase3-scorecard`,
cleaned up after merge). Design addendum: spec §19 (2026-07-13). Plan:
`docs/superpowers/plans/2026-07-13-eval-phase3-scorecard.md`. New
`eval/score/{metrics,bootstrap,scope,build-scorecard}.ts` + `pnpm eval:score`
computed recall/precision/MRR (k=10/k=5, both `E` label≥1 and `E_primary`
label==2, both full-corpus and scope-matched, each with bootstrap 95% CI)
by joining the existing `2026-07-06-runs.json` (146 RunResults, no re-run
needed — item ids matched the finalized 73-item `queries.json` exactly) with
the now-complete `judgments.json`, plus routing/coverage embedded verbatim.
One real Important finding fixed before merge: `any_degraded_runs` was
passing the raw `{before,after}` snapshot object (or silently vanishing via
`undefined`) instead of a real boolean — root cause was the plan's own type
not matching `eval/run/types.ts`'s actual optional-object field; fixed to
`!!runsFile.indexChangedDuringRun` and verified against the real artifact.

**First real accuracy numbers for the whole project** (recall@10, full-corpus,
E label≥1) — `as-deployed` (hybrid) beats `grep-first` in every category
except a near-tie on hot-topics, most dramatically on entities (0.09 →
0.62) and decisions (0.26 → 0.44), but at large latency cost (7x-500x
depending on category, e.g. entities 0.4ms → 145ms, hot-topics 675ms →
807ms). **Re-scored 2026-07-13 against a clean `eval:run`** (see I14 below
for why the first pass was degraded) — `any_degraded_runs: false`, real
`db_doc_count: 23556` (vault grew from 23,376 in the interim). Numbers
barely moved from the degraded first pass (entities 0.63→0.62, decisions
0.45→0.44) — the index drift didn't materially distort the headline
numbers, but this clean scorecard (`2026-07-13-scorecard.json`, same
filename, overwritten) is now the one to treat as authoritative for the
bake-off, not a preliminary read.

**I14 (fixed 2026-07-13, found while re-running for a clean baseline):**
`build-scorecard.ts`'s `main()` hardcoded the exact filename
`eval/results/2026-07-06-runs.json` — re-running `eval:run` produces a new
dated file (`2026-07-13-runs.json`) that would have been silently ignored,
scoring forever against the stale, degraded run. Fixed with
`findLatestRunsFile()`, which globs `eval/results/` for `<date>-runs.json`
and picks the most recent by filename sort — verified with a real re-run
(picked `2026-07-13-runs.json` correctly, printed which file it scored
against). Not caught in Phase 3's review because only one `runs.json`
existed at review time.

**Next, still unbuilt:** (1) I9 (absent-query scoring); (2) document the
passive-telemetry refresh cadence per the design's §6 (re-run `eval:mine`'s
behavioral-signal extraction before any future full-pool judging run, to
pick up new usage since the last run); (3) consider adding incremental
checkpointing to `judge-full.ts` and a retry-once-on-5xx wrapper for
transient Bedrock errors before any larger future run; (4) a human-readable
`.md` companion to the `.json` scorecard (spec §16 Phase 3 row calls for
both; only `.json` was built). See task-7-brief.md "Notes for the next
plan" for the fuller Phase 2 breakdown. Arm-B embedding backfill (was item
(4) here) shipped 2026-07-14 — see Track B's section above.

## Update protocol
- End of each session: update the phase status table, the issues log, and "You
  are here."
- Mirror the one-line status in the memory note `carpathi-retrieval-eval`.
