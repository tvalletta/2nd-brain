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
| 2 — Pool + judge + calibrate | 🟡 **CALIBRATION GATE OPEN** (2026-07-07) | Triage proposals (`eval/dataset/triage-proposals.json`); pooled ground truth (`eval/dataset/pool.json`); LLM judge (`eval/pool/judge.ts`); **20-item stratified calibration sample judged and rendered for Tom's review** at `eval/results/2026-07-07-calibration-sample.md`; partial `eval/dataset/judgments.json` (calibration sample only) |
| 3 — Score + report | ⬜ pending | Baseline scorecard (before/after ruler ready) — blocked on Phase 2's gate closing (Tom's corrections + agreement check) and full-scale judging |
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

Status: 🟡 **spec written** (2026-07-06) — `docs/superpowers/specs/2026-07-06-architecture-bakeoff-remediation-design.md`.
Structure: **Stage 1 bake-off** (measure grep-first vs full-coverage hybrid on a
weighted scorecard — accuracy 0.50 / latency 0.20 / tokens 0.15 / simplicity 0.15,
simplicity breaks a ≤0.03 tie) → **Stage 2 holistic remediation** toward the
winner (architecture-dependent scope deferred until the verdict). The bake-off
runs on Track A Phase 1's variant runner, so the two tracks share the harness.
Next: writing-plans for Stage 1 (first step = build the variant runner).

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
| I10 | Real `eval:calibration` run (Task 7, 2026-07-07): 2 of 20 sampled items (`decisions-001`, 48 pooled candidates; `hot-topics-005`, 53 pooled candidates) failed structured-output extraction with `Unexpected non-whitespace character after JSON`, deterministically (same error on retry). Root cause: several pooled candidate excerpts contain literal double-quote characters (e.g. quoted terms in meeting-note titles under `Curated/wiki/meetings/`); when the judge model echoes them back unescaped inside a `reason` string, `extractJSON`'s regex-based extraction in `src/enrichment/llm-client.ts` breaks. Worked around (not fixed) by catching per-item failures in `eval/pool/calibration-report.ts`'s `main()` and skipping — the run completed with 553 judgments across the other 18 items instead of crashing. The 2 skipped items render as `_(no pooled candidates)_` in the calibration markdown, which is misleading (they had 48 and 53 real candidates) — flagged explicitly in `task-7-report.md`, not silently fixed. | `pnpm eval:calibration` console output, 2026-07-07; `eval/results/2026-07-07-calibration-sample.md` §decisions-001, §hot-topics-005 | 🟡 | needs a real fix in shared `extractJSON`/judge prompt (e.g. instruct stricter quote-escaping, or a more forgiving JSON repair step) before full-scale judging — at full scale (~80 items, more candidates) more items are likely to hit this. |
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

Phase 2 (pooling + judge + calibration, Task 7, 2026-07-07) shipped and ran
for real against the live production index: triage proposals for all 74
draft items (21 flagged drop, mostly session-mined imperative task requests —
see the Phase 2 note above), a full candidate pool (`eval/dataset/pool.json`:
73 items, 2280 candidates), and a stratified ~20-item calibration sample
judged by the LLM judge and rendered to markdown for human review.
**The human gate is now open — Tom's calibration review is the next step,
at `eval/results/2026-07-07-calibration-sample.md`.** Two real issues
surfaced during this run and are logged rather than silently patched: I9
(author-absent confirmed 0/10 candidates — `queries.json` currently has zero
`absent`-subtype items) and I10 (2 of the 20 calibration items failed judging
on a JSON-escaping edge case and are skipped, not scored). **Next, still
unbuilt:** (1) Tom reviews the calibration markdown and returns corrections;
(2) parse his corrections and compute raw agreement against spec §8.3's ≥0.8
gate, updating `label_provenance` to `"llm+human"` for corrected items; (3)
resolve I9 (absent-query scoring) and I10 (JSON-escaping) — I10 especially
before running the judge at full scale, since more candidates means more
chances to hit it; (4) gated on the agreement check passing, run `judgeItem`
over the remaining ~53 pool items beyond the calibration sample; (5) Phase 3
scoring/scorecard once `judgments.json` is complete. See task-7-brief.md
"Notes for the next plan" for the fuller breakdown.

## Update protocol
- End of each session: update the phase status table, the issues log, and "You
  are here."
- Mirror the one-line status in the memory note `carpathi-retrieval-eval`.
