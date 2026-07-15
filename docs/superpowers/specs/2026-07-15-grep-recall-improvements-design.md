# Grep-First Recall Improvements — Design

**Date:** 2026-07-15
**Status:** Approved design
**Depends on:** Stage 1 bake-off verdict (`docs/superpowers/ROADMAP.md` — grep-first wins, composite 0.712 vs 0.221)
**Track:** B, Stage 2 (architecture-independent remediation, spec `2026-07-06-architecture-bakeoff-remediation-design.md` §5.1, issue I3)

## 1. Problem statement

The bake-off's real numbers show grep-first winning on the strength of precision (0.763) while its recall@10 (0.212) is mediocre — it misses roughly 4 in 5 relevant notes on average, and catastrophically on `entities` queries (recall 0.09, the worst cell in the entire matrix). Three concrete, root-caused levers exist to raise recall without reintroducing the complexity/latency/simplicity costs that just lost the bake-off:

1. FTS5 queries require **every** term to match (`sanitizeFtsQuery` joins tokens with implicit AND) — a 5-word query needs all 5 terms present, which is a direct recall killer for anything but a perfectly-worded query.
2. FTS5's tokenizer has no stemmer (`unicode61` default) — "decision"/"decisions", "meet"/"meeting" don't match.
3. `entities` category recall (0.09) is driven by name-form mismatches (a query says "Bryan" or "Pino," the note's canonical name is "Bryan Pino") that the vault's own `aliases: []` frontmatter field — already templated on every entity note, populated nowhere — is supposed to solve but has never been given data.

## 2. Non-goals

- Not touching the semantic/embedding path at all (that's Sub-project 3).
- Not re-running the full bake-off after these land — the goal is a targeted, re-scoreable recall lift on `eval:score`, not a new architectural decision.
- Not building a generic alias-suggestion AI (see §5 — the vault has zero alias text anywhere to mine from; this is fundamentally a human-input task).

## 3. Component 1: AND-first, OR-fallback query relaxation

### 3.1 Current behavior (confirmed by reading the code)

`src/search/fts-index.ts`'s `sanitizeFtsQuery` (referenced at `:298-308` per the architecture audit) quotes each token and joins with spaces — FTS5's implicit behavior for space-joined quoted terms is AND. There is exactly one query construction path; no fallback exists today.

### 3.2 Design

Add a second query construction mode (OR-joined) and a two-attempt search flow in `FTSIndex`'s query method:

1. Run the existing AND query exactly as today.
2. If it returns **zero** results (not "few" — zero is the unambiguous, uncontroversial signal that AND was too strict; a nonzero-but-small threshold risks discarding cases where AND correctly narrowed to the one right answer), immediately re-run with an OR-joined version of the same sanitized terms.
3. Tag which mode actually produced the returned rows (a `matchMode: 'and' | 'or'` field on the internal result, surfaced through to `HybridSearchResult` as a new optional field, analogous to the existing `degradationNote` pattern) so this is observable/debuggable and testable, not a silent behavior change.
4. BM25 ranking (already in place) handles quality ordering within the OR result set — a document matching all 5 terms still ranks above one matching 2, so OR-fallback doesn't flatten quality, it just widens the candidate pool when AND finds nothing.

### 3.3 Edge cases

- Single-term queries: AND and OR are identical for one term; the fallback path is a no-op (verify via test, not just by inspection).
- Empty query / all-stopword query: unchanged from current behavior (out of scope — not a recall regression this component introduces).
- The `keyword-only` (grep-first) variant and the hybrid variants both go through the same `FTSIndex`, so this fix applies to all arms uniformly — consistent with treating it as a keyword-layer improvement, not arm-specific.

## 4. Component 2: Porter stemmer + safe index rebuild

### 4.1 Current constraint (confirmed by reading the code)

`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(doc_id UNINDEXED, title, body)` (`fts-index.ts:81-85`) has no `tokenize=` clause. FTS5's tokenizer is fixed at table-creation time — it cannot be changed via `ALTER TABLE` or incremental sync. The only existing "clear" mechanism (`fts-index.ts:283-285`) deletes rows but doesn't drop the table, so it can't change the tokenizer either. **There is no existing rebuild path in this codebase.** One must be built.

### 4.2 Design: build-verify-swap, not in-place mutation

This runs against the **live, 23,600+-note production index** — treat it with the same care as any other production migration in this project (matching the "never mutate production carelessly" discipline established throughout Track A/B):

1. Create a new virtual table `notes_fts_v2` with `tokenize = 'porter unicode61'`, in the *same* SQLite file as the live `notes_fts`.
2. Populate `notes_fts_v2` via the existing `syncFTS`-equivalent walk over the vault (reuse the existing sync logic, parameterized by target table name rather than hardcoded to `notes_fts`).
3. **Verify before swapping:** compare `COUNT(*)` between `notes_fts` and `notes_fts_v2` (must match the on-disk markdown file count), and spot-check that a sample of known-good queries (reuse a handful of real eval queries from `eval/dataset/queries.json`) return sane, non-empty results against `notes_fts_v2` directly.
4. Atomic swap: SQLite supports `ALTER TABLE notes_fts RENAME TO notes_fts_old; ALTER TABLE notes_fts_v2 RENAME TO notes_fts;` inside a single transaction — this is the standard safe swap pattern (both renames succeed or neither does).
5. Keep `notes_fts_old` for one verification cycle (don't drop it in the same run) — a follow-up maintenance command drops it only after confirming the live path works correctly against the renamed table.
6. `fts_meta` (the sync-tracking table) needs the same treatment, or a full re-sync from empty, since its rows are keyed to the old `notes_fts` rowids implicitly via the FTS5 delete/insert pattern — the plan must specify exactly how `fts_meta` is reconciled during the swap (rebuilding it from scratch alongside `notes_fts_v2` is the simpler, safer choice over trying to preserve/rekey it).

### 4.3 New CLI surface

A new `karpathy maintenance --rebuild-fts-tokenizer` command (or similar, matching the existing `--populate-fts` naming convention in `src/bin/karpathy.ts`) that runs steps 1-4 above, prints the verification numbers, and requires an explicit `--confirm` flag before the swap step (steps 1-3 can run and report without mutating the live table; the swap is the only truly destructive-adjacent step, given the old table persists as a rollback path per §4.2 step 5).

## 5. Component 3: Entity alias population

### 5.1 Grounding facts (confirmed by direct research)

- Exactly **23 entity notes** exist under `Curated/wiki/entities/` — "vault-wide" is a small, tractable set, not hundreds of files.
- Every one has `aliases: []` — populated nowhere.
- Zero note bodies contain alias-revealing text ("also known as," "goes by," "@handle") — grepped across all 23, zero matches. **There is nothing for an LLM to extract aliases from within this vault's own content.** Any automated "suggest aliases" pass would be generating from the model's general world knowledge of a private individual it has no real information about — a hallucination risk, not a grounded extraction.
- A real, concrete, already-existing duplicate exists: `Bryan Pino.md` (`canonical_name: Bryan Pino`) and `pino.md` (`canonical_name: pino`) are two separate pages for the same person, undetected/unreconciled by the existing `reconcile_entities` tooling.
- The vault already has working alias-*consumption* machinery: `entity-resolver.ts` does Levenshtein fuzzy matching against `aliases` for resolution, and `entity-writer.ts`/`entity-merger.ts` mechanically union names into `aliases` on merge. Once real alias data exists, it is used immediately — no new consumption code is needed.

### 5.2 Design: two-part, human-in-the-loop

**Part A — immediate, zero-new-code win:** run the existing duplicate-detection (`detect-entity-dupes` / whatever backs it) now, confirm it flags `Bryan Pino.md`/`pino.md`, and run it through the existing `reconcile_entities` merge flow. This is using already-built tooling on a bug that already exists, not new work — verify it resolves correctly and `aliases` gets the union it's supposed to per `entity-merger.ts:59-88`.

**Part B — new: a lightweight alias-authoring pass.** Since aliases must come from Tom's own knowledge (real nicknames, Slack handles, shortened names), not from vault content or LLM guessing, build a small new script/command that:
1. Lists all 23 entities (canonical_name, role/context from existing frontmatter) in one place.
2. Presents them for Tom to fill in aliases in a single sitting — a plain markdown checklist/table written to `Curated/review/entity-aliases-pending.md` (matching the existing `Curated/review/` convention already used for ambiguous-match review items in `link-concepts.ts`), OR a simpler terminal-prompt-driven CLI walkthrough (`karpathy entity-aliases` interactive), whichever is less friction — **this is a UX choice worth confirming in the implementation plan's brainstorm, not decided here.**
3. Writes confirmed aliases directly into each entity note's `aliases:` frontmatter array via the existing `vault.atomicWrite` pattern (no new review-queue mechanism needed for this — Tom IS the review step, since he's the one supplying the data).

### 5.3 Success criterion

Re-run `eval:score` for the `entities` category slice after (a) the duplicate merge and (b) at least the highest-traffic aliases are populated (the ones appearing in the 20 real `entities` eval queries), and confirm grep-first's `entities` recall measurably improves from its current 0.09.

## 6. Testing strategy

- Component 1 (query relaxation): unit tests on `FTSIndex`'s query method with fixture data — AND-then-OR fallback triggers correctly on zero-hit AND queries, doesn't trigger on nonzero-hit queries, single-term queries are unaffected, `matchMode` is reported correctly.
- Component 2 (stemmer + rebuild): a dedicated test harness against a small in-memory/temp-file SQLite DB (not the live vault) exercising the full build→verify→swap→rollback-path sequence, plus a manual, explicitly-confirmed run against the real live index as part of plan execution (not part of the automated test suite — this is a real production migration, run once, deliberately).
- Component 3 (aliases): no unit-testable "correctness" per se (it's data entry), but the eval re-score in §5.3 is the real verification.

## 7. Risks & mitigations

- **Rebuilding the live FTS index risks breaking production search mid-migration.** Mitigated by the build-verify-swap pattern (§4.2) — the old table is never touched until the new one is verified, and persists as a rollback path after the swap.
- **OR-fallback could reintroduce noise/regressions on queries that work fine today.** Mitigated by only triggering on zero AND-hits (not "few"), and by the existing BM25 ranking still ordering OR results by relevance.
- **Alias data quality depends entirely on Tom's recall/effort** — mitigated by scoping Part B to a single, low-friction sitting (23 items, not hundreds) and by Part A (the duplicate merge) delivering a real win independent of Part B's completion.
