# Carpathi Second Memory — Program Roadmap

**Single source of truth** for two interlocking efforts. Update this file at the
end of every working session so no thread is lost across sessions. If you are
resuming work, **start here.**

Last updated: 2026-07-06

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
| 2 — Pool + judge + calibrate | ⏳ **NEXT** | Pooled ground truth; LLM judge; **Tom calibration gate**; refined `queries.json` |
| 3 — Score + report | ⬜ pending | Baseline scorecard (before/after ruler ready) |
| 4 — Regression suite | ⬜ pending | Frozen set + pass bar; guards Track B changes |

**Draft set needs a triage/refinement pass** (categories are heuristic; see
Phase-0 findings §"Known limitations"). This is folded into Phase 2 calibration.

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
tracking as Track B's bake-off proceeds. **Next:** Track A Phase 2 — pooling + LLM judge + Tom calibration
gate (builds `pool.json`/`judgments.json` from `eval/results/*-runs.json` +
`eval/dataset/behavioral-signal.json` + a keyword sweep; also triages the
74-item draft set's categories). See task-5-brief.md "Notes for the next plan."

## Update protocol
- End of each session: update the phase status table, the issues log, and "You
  are here."
- Mirror the one-line status in the memory note `carpathi-retrieval-eval`.
