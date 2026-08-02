# Karpathy Second Memory

## Project Overview

This is a local-first knowledge system that captures Claude Code sessions and raw source material into an Obsidian-compatible wiki. It maintains structure, provenance, and quality automatically via hooks and a job queue.

## Specification

The authoritative design spec lives at `specs/specification.md`. Consult it before implementing features or making non-trivial changes. See sections 6-8 for the memory model, architectural lanes, and job system; section 9 for functional requirements; section 10 for the data model; section 12 for overwrite policy; section 18 for implementation phases; section 22 for the curator reconciliation workflow; section 25 for the draft/archival lifecycle; section 26 for the research queue redesign; section 27 for resource-boundedness fixes (multi-instance MCP server, and job-system boundedness).

## Build & Test

```bash
pnpm build            # Build with tsup → dist/
pnpm test             # Vitest, 1299 tests across 156 files
pnpm lint             # tsc --noEmit (strict mode)
```

All three must pass before committing.

## Configuration

Karpathy uses a single **global config** at `~/.karpathy/config.json` — no per-project config files.

```json
{
  "defaults": {
    "vaultPath": "/path/to/vault",
    "llm": { "provider": "bedrock", "region": "us-west-2", "model": "..." },
    "maintenance": { "autoBacklinks": true, "autoIndexes": true }
  },
  "projects": {
    "/absolute/path/to/project": {
      "maintenance": { "reviewEnabled": true }
    }
  }
}
```

- `defaults` applies to every project. All Zod schema defaults fill in unset fields.
- `projects` is a map of absolute project paths to partial overrides merged on top of defaults.
- Hooks silently skip (exit 0) when the global config file is absent or `vaultPath` is unset.
- CLI commands throw a `ConfigError` when the config or `vaultPath` is missing.
- State dirs (`.karpathy/state`, `.karpathy/locks`, `.karpathy/logs`) remain project-local.

### Vault layout (config-driven)

Every karpathy-managed path is computed at runtime from `config.layout`. Defaults preserve the legacy layout (`wiki/`, `outputs/`, `raw/`, `review/` at vault root). For a "single Curated/ folder" layout, override:

```jsonc
"layout": {
  "aiConversations": "AI Conversations",
  "aiSummaries":     "AI Conversations/_summaries",
  "aiLegacy":        "AI Conversations/_legacy",
  "wiki":            "Curated/wiki",
  "sources":         "Curated/sources",
  "review":          "Curated/review",
  "system":          "Curated/_system",
  "digests":         "Curated/wiki/digests"
}
```

Helpers in `src/vault/paths.ts`: `layoutFromConfig(config)`, `kindToFolder(layout, kind)`, `wikiContentFolders(layout)`, `allWikiFolders(layout)`, `searchableFolders(layout)`. Use these instead of hardcoded path strings — call sites that need a custom layout pass `layout` (defaults to `DEFAULT_LAYOUT` for backwards compat).

## Key Architecture Rules

- **ESM only** — `"type": "module"` in package.json. All imports use `.js` extensions.
- **Protected regions** — Machine-managed content goes inside `%% begin:id %%` / `%% end:id %%` blocks (Obsidian native comments). Never overwrite content outside these markers. Tag construction is centralized via exported `OPEN_TAG`/`CLOSE_TAG` from `src/vault/protected-regions.ts` — import these rather than hardcoding marker strings. The parser also accepts legacy `<!-- PROTECTED:id -->` format for backward compat.
- **Vault adapter** — All filesystem access to the vault goes through `VaultAdapter` (`src/vault/adapter.ts`). Never use `fs` directly for vault operations.
- **Atomic writes** — Use `vault.atomicWrite()` or `atomicWrite()` from `src/shared/fs-utils.ts` for any write that could corrupt on partial failure.
- **State separation** — Mutable state (`.karpathy/`) lives in the project root, not in the vault. The vault contains only Markdown.
- **Job dedup** — Use `dedupeKey` when enqueuing jobs to prevent duplicate work from rapid hook triggers.

## Directory Layout

- `src/bin/karpathy.ts` — CLI entry point
- `src/config/` — Zod config schema, defaults, loader
- `src/vault/` — Adapter, frontmatter schemas, paths, protected regions
- `src/jobs/` — Queue, runner, lock, handler registry
- `src/hooks/` — Claude Code hook handlers (session-start, user-prompt-submit, post-tool-use, post-compact, stop)
- `src/session/` — Hot cache (CLAUDE.md) and session log management
- `src/ingest/` — File watcher, classifier, ingest pipeline
- `src/enrichment/` — LLM client (Bedrock), prompts, summarizer, entity extractor
- `src/maintenance/` — Backlinks scanner, index rebuilder
- `src/review/` — Contradiction/duplicate detection, review queue
- `src/embeddings/` — Pluggable embedding provider (deterministic / Bedrock Titan / Ollama) + SQLite content-addressable store. See `factory.ts` for config-driven instantiation.
- `src/search/` — Hybrid search module (§24): `FTSIndex` (FTS5 BM25 over the entire vault), `rrf` (Reciprocal Rank Fusion), `HybridStore` (composes FTSIndex + EmbeddingStore + recency fusion). Backs the unified `search` MCP tool.
- `src/intelligence/` — Implementation of the intelligence plan: TL;DR (CoD), retrieval-with-recency, clustering, weekly digest, topic refresh, decay scan, rot scan, research propose/execute, significance gate, Slack notify
- `test/` — Mirrors src/ structure, uses temp directories for isolation

## Frontmatter

All managed notes have YAML frontmatter validated by Zod schemas in `src/vault/frontmatter.ts`. The base schema includes: `id`, `type`, `title`, `status`, `confidence`, `review_state`, `created_at`, `updated_at`, `source_refs`, `derived_from`, `change_origin`, `protected_regions`.

Time-aware fields added by the intelligence plan (all optional, backfilled by `backfillTimeAwareFields` in `src/maintenance/backfill-time-aware.ts`):

- `last_verified` — ISO date the claims were last reconfirmed (by ingest, refresh, or research)
- `stability` — FSRS-style days for confidence to halve; defaults from `defaultStability(domain)` in `src/vault/half-life.ts`
- `half_life_domain` — bucket that drives default stability (e.g. `ai-research` 90d, `decisions` 365d)
- `superseded_by` — wiki-link IDs of newer notes that replace this one
- `contradicts` — `{ ref, reason }[]` preserved as assets, never overwritten
- `tldr` — ≤120 char summary, mirrored into the `tldr` protected region
- `hot_score` — 0..1 from the most recent weekly digest

Phase 0 cascading-curation fields (added by `markDirty()` from `src/maintenance/mark-dirty.ts`):

- `pending_evidence` — `[{ ref, reason?, at }]` queue of unresolved evidence; appended on each new link, consumed (and cleared via `clearPendingEvidence`) by `topic-refresh`. Bounded at `MAX_PENDING_EVIDENCE = 50` (oldest evicted). Idempotent on `(notePath, ref)`.
- `pending_evidence_count` — cached length; gated by `evaluate-refresh-candidates` (Phase 1) against the configured threshold.
- `also_relevant_to` — absolute project paths whose chunks reference this concept (Phase 3 bridges).

`EntitySchema` fields added by B2c (person name resolution), defaulted/backward-compatible for every existing entity page regardless of `entity_kind`:

- `external_ids` — `string[]`, `"provider:id"` form (e.g. `"slack:U01FZCB8X29"`), default `[]`. Populated deterministically at extraction time (no LLM) from Slack profile links in raw source text; the single highest-confidence tier in `resolveEntity`.
- `identity_uncertain` — `boolean`, default `false`. Set `true` when a newly-created person page's `canonical_name` is a bare first name or raw handle (`looksLikeBareHandleOrFirstName`); cleared on any merge (`mergeEntities`/`mergeEntityPage`, unconditionally, regardless of prior state) or `karpathy curator` rename decision (which internally calls the same merge path).

Base-schema fields added by Sub-project C (draft/archival lifecycle), optional and absent by default:

- `archived_at` — ISO timestamp the note transitioned to `status: archived`. Deleted (not set to `undefined` — `gray-matter`'s stringifier throws on `undefined`-valued keys) on un-archival.
- `archived_reason` — free text, e.g. `"stale-draft (34d at ingest_status: detected)"`, `"rot-scan: age 9999d, confidence unknown, inbound no"`, `"superseded"`. Deleted on un-archival.

## Intelligence pipeline

Implements [specs/intelligence-plan.md](specs/intelligence-plan.md). Hot paths:

- **Embedding store** (`src/embeddings/`) — backed by SQLite. `openStoreFromConfig(config, projectRoot)` opens it at `.karpathy/state/embeddings.sqlite`. Provider chosen by `config.embeddings.provider` — `deterministic` (default, offline) or `bedrock-titan`.
- **Retrieval with recency** (`src/intelligence/retrieval.ts`) — `final = α · rerank + β · exp(-Δt / 30)`. β per content-type via `config.intelligence.recencyWeight`.
- **Weekly digest** (`src/intelligence/digest.ts`) — `runWeeklyDigest()` clusters last-N-days chunks via `clusterByCosine` (`src/intelligence/clustering.ts`), labels each cluster via Bedrock, writes `wiki/digests/{ISO-week}.md`. Cron-triggerable via the `digest-weekly` job.
- **Topic refresh** (`src/intelligence/topic-refresh.ts`) — pulls evidence via retrieval and rewrites a note's primary richness region, surfaces contradictions instead of overwriting. **Region-aware since B2b**: dispatches per note `type` through the `REFRESH_TARGETS` registry (`src/intelligence/refresh-targets.ts`) instead of assuming every note has a `current-understanding` region — `concept`/`topic` rewrite `current-understanding`, `decision` rewrites `outcome` (and, when evidence sharpens it, `context`), `project` hubs rewrite `overview`. Each target carries its own anti-fabrication prompt (write the honest placeholder — `(pending)` / `Pending enrichment.` — rather than invent one) and its own `isPlaceholderContent()` predicate. `project_spec` deliberately has no `REFRESH_TARGETS` entry — that content stays owned by `agent-synthesize-project`'s Opus agent loop; an unmapped type just bumps `last_verified`/clears `pending_evidence` without touching the body. As a byproduct of the same pass, `concept`/`topic` refreshes render the resolved cascade-neighbor list into the `related-concepts` region (a `_No connected concepts identified..._` sentinel when none resolve) instead of computing it and discarding it. Job: `topic-refresh` with `targetPath`.
- **Decay scan** (`src/intelligence/decay-scan.ts`) — computes `R = exp(-Δt / S)` per note, enqueues `topic-refresh` for stale ones, surfaces low-retrievability concept/topic notes as research candidates. Job: `decay-scan`. **Thin-content detection (B2b, gated on `intelligence.richness.enabled`):** independent of retrievability, a note whose `REFRESH_TARGETS[type].primaryRegion` is empty/placeholder (or, for `concept`/`topic`, whose `related-concepts` is empty) is force-enqueued for `topic-refresh` with `trigger: 'thin-content'` and a higher priority (80 vs. 75) than the retrievability-driven `cascade` trigger — the mechanism that backfills already-thin notes instead of waiting months for natural staleness. Disabling `richness.enabled` falls back to pre-B2b behavior (retrievability-only enqueue). `DecayScanResult.thinContentEnqueued` tracks the count.
- **Vault-rot diagnostic** (`src/intelligence/rot-scan.ts`) — orphan + stale + low-confidence → `wiki/_system/vault-health.md`. Job: `rot-scan`. Also renders a second, purely-informational "Thin content" table (same `REFRESH_TARGETS`/`isPlaceholderContent` predicate as decay-scan, no side effects) so operators can watch the backfill converge to zero over subsequent scan cycles. **Sub-project C** adds a third table, "Stale draft sources" (`source_summary` notes still `status: draft` past `intelligence.lifecycle.staleDraftReportDays`, reporting-only, runs unconditionally like the other two tables) and feeds its existing `candidates` list into the new archive queue (below) when `intelligence.lifecycle.archiveQueueEnabled` (default `true`).
- **Research handshake** — gap detection (`research-propose.ts`) writes `{layout.system}/research-queue.md`; user decides depth (`light`/`medium`/`heavy`/`skip`) via Slack reply (parsed by `slack-notify.ts`), direct queue edit, or the `approve_research` MCP tool. Tiered executor (`research-execute.ts`) runs `light`/`medium`/`heavy` rounds. Jobs: `research-propose`, `research-execute`. **Sub-project D redesign:** a real-vault audit found two of these three approval surfaces silently inert against any non-default (`Curated/`-style) layout, `research-execute` never scheduled or auto-triggered (never once run in 2.5 months of real daily proposals), ~19 of 30 real queue candidates orphaned by Sub-project B1's concept-glossary consolidation, and unbudgeted, non-tier-aware LLM calls. See `specs/specification.md` §26 for the full design.
  - **G0 — layout-path fix.** `approve-research.ts`, `intel-command.ts` (`queue`/`approve`/`status`), and `health-check.ts`'s `checkResearchQueue` now thread `layoutFromConfig(config)`/`config.layout` through every `readResearchQueue`/`writeResearchQueue` call — previously all four silently defaulted to the legacy `wiki/_system/research-queue.md` path, so every real approval decision against a `Curated/`-layout vault operated on a file that never existed. `karpathy intel health --json`'s research-queue counters (documented as "canonical input for external control centers") are accurate for the first time.
  - **G1 — auto-drain (`intelligence.research.autoDrainEnabled`, default `false`).** Once a queue candidate has a `decision` set (any of the three now-working G0 surfaces) and is still `status: pending`, the next `research-propose` run auto-enqueues a `research-execute` job for it (dedup key `research-execute:{slug}`, matching the manual CLI's own key). Defaults off — `research-execute` makes real LLM calls and, depending on `intelligence.research.search.provider` (defaults `noop`, a second independent gate), can spawn an external websearch MCP subprocess never exercised against real traffic — mirroring Sub-project C's `staleDraftArchiveEnabled` safety decision. No code path anywhere sets it to `true` or bypasses reading it from config.
  - **G2 — budget-gated, tier-aware execution.** `src/jobs/handlers/research-execute.ts` reserves one `BudgetTracker` call (tier from depth: `light→fast`, `medium→medium`, `heavy→heavy`) before doing any work, and builds a depth-appropriate LLM client via `createLLMFromConfig(config, stateDir, tier)` instead of always using the default-tier client — matching `topic-refresh.ts`'s and B2a's `generate-review-analysis.ts`'s patterns. On budget refusal, the job returns without touching the queue row; the next drain cycle (or manual CLI) retries.
  - **G3 — orphan purge + write-guard.** `research-propose.ts`'s `scanFolders()` no longer scans `${layout.wiki}/concepts` (dead since B1's glossary consolidation); every carried-forward candidate is validated against its backing page (`concepts/{slug}.md` or `topics/{slug}.md`) each cycle and dropped immediately if neither exists (completed candidates exempted). `research-execute.ts`'s `writeConceptNote()` refuses (throws) to create a brand-new individual concept page when the resolved target folder is the glossary-consolidated `concepts/` folder, rather than silently forking a duplicate concept representation — an existing page of either kind is still updated in place, never redirected. (A same-day follow-up fix corrected `executeResearch`'s notePath resolution to prefer whichever folder actually backs the candidate's slug — the guard's own existence check had been hardcoded to `concepts/` regardless of type, so it fired and refused on every real topic execution attempt until fixed.)
  - **G4 — `confidenceGap` default fix.** An unset `confidence` field now contributes `0.5` to the gap-score, same as explicit `confidence: medium` (was `0.7` — backwards, since "never judged" outranked "explicitly medium").
  - **G5 — observability.** New `research:queue-capped`, `research:orphans-purged`, `research:drain` log lines (existing `appendLogEntry` convention), each firing only when something was actually dropped/drained.
  - **G6 — closed the test blind spot.** Every research-queue test fixture previously used `DEFAULT_LAYOUT` by construction; new non-default-layout (`Curated/`-style) coverage now exists for `approve_research`, `karpathy intel queue/approve/status`, and `checkResearchQueue`.
- **Significance gate** (`src/intelligence/significance-gate.ts`) — heuristic + optional LLM gate that drops noise entities. Wired into `compileFromSource` (`src/compilation/compiler.ts`, the production entity-creation path used by the rich ingest pipeline) and into the legacy `link-concepts` handler, both gated on `config.enrichment.significanceGate !== 'off'`. Defaults to `'llm'` (was `'heuristic'`) — existing installs that never set this explicitly will start making a Bedrock `fast`-tier call per newly-extracted entity on upgrade; `significanceGateDropConfidence` (default `0.7`) keeps this safe by creating the page anyway (flagged for review) instead of discarding it whenever the LLM's `drop` verdict falls below that confidence. `config.maintenance.reviewEnabled` is no longer dead config either: when `true`, it now schedules `detect-contradictions`/`detect-duplicates`/`detect-entity-dupes` daily (previously these only ran via manual CLI).
- **Concept glossary** (`src/maintenance/concept-glossary.ts`) — concepts are no longer individual wiki pages. `compile-entities.ts` upserts every mention into `{layout.wiki}/concepts/glossary.md` via `upsertConceptMention` — one section per concept, appending sources instead of creating pages. `migrate-concept-glossary` is a one-time job that consolidates pre-existing concept pages into it. **Content-aware dedup + threshold synthesis (B2b):** `upsertConceptMention` now skips a mention whose normalized gloss text already matches another mention under the same concept (not just same `sourceRef`), fixing verbatim-duplicate lines from near-duplicate source files. It returns `{ mentionCount, crossedSynthesisThreshold }`; when a concept's mention count crosses `intelligence.richness.glossarySynthesisThreshold` (default 3, re-fires every further `threshold` mentions), `compile-entities.ts` enqueues the `glossary-synthesize` job (`src/jobs/handlers/glossary-synthesize.ts`), which reserves a `fast`-tier budget call and runs `synthesizeConceptEntry()` to write a short LLM-synthesized rollup line above the concept's raw mention list — skipped entirely when `intelligence.richness.enabled` is `false`.
- **Action-item extraction** (`src/maintenance/action-items.ts`) — `action_items` is its own extraction category, separate from `decisions` (a decision is committed to; an action item is still to be done). `compile-entities.ts` calls `upsertActionItem`, which tracks items as markdown checklists rather than pages: a per-project checklist at `{layout.wiki}/projects/{slug}/action-items.md` plus a vault-wide rollup at `{layout.system}/action-items.md`.
- **Person name resolution (B2c)** — closes the "bare name in one document, fuller name in an unrelated document" blind spot (the real Bryan/Pino duplicate, merged by hand before this shipped). All of it is deterministic — no LLM call anywhere in this feature. Gated by `enrichment.personResolution.*` (below).
  - **External-ID capture** (`src/ingest/external-id-extractor.ts`) — `extractSlackHandleIds(rawText)` deterministically regex-scans raw source text for `[@handle](https://*.slack.com/team/ID)` links, gated on `enrichment.personResolution.externalIdCaptureEnabled`. `extract-entities.ts`'s `resolveExternalIdsForName` attaches the resulting `slack:<ID>` either when the extracted person name IS the handle verbatim, or when the handle appears as a whole, case-insensitive token within a fuller extracted name in the same document (e.g. "Bryan Pino" via handle `pino`) — token-equality only, not substring containment, to avoid false positives from short handles. Does not close the cross-document case or surname+initial-style handles (e.g. `brownf` vs "Frank Brown") — see design doc §12.
  - **`entity-resolver.ts` tiers** — `resolveEntity` gains a Tier 0 exact `external_ids` match (confidence 1.0, checked before every name-based tier) and, for `entity_kind: person` only, honorific stripping (`Dr. Sarah Chen` → `Sarah Chen`) plus a nickname/initials-equivalence fuzzy tier (`Matt Newman` ↔ `Matthew Newman`) in `findFuzzyMatches`, both gated on `enrichment.personResolution.nicknameMatchingEnabled` (an optional 4th `ResolveEntityOptions` parameter on `resolveEntity`/`resolveEntities`, threaded from config at every real call site). Heuristics live in `src/ingest/name-variants.ts` (`stripHonorifics`, `NICKNAME_GROUPS`, `firstNamesEquivalent`, `initialsMatch`, `looksLikeBareHandleOrFirstName`) — pure, dependency-free, extendable via `enrichment.personResolution.extraNicknameGroups`.
  - **Person-scoped name-variant detection** (`src/compilation/person-name-variants.ts`) — the core fix. `personNameVariantScore` scores person-to-person pairs with **no shared-source-reference requirement** (substring containment → 0.5, surname+nickname/initials match → 0.65, always below `AUTO_MERGE_THRESHOLD`), feeding `detectMergeCandidates()`'s 4th tier (`entity-merger.ts`, person-to-person pairs only) and `findNameVariantCandidatesForNewPage` (an O(n) check of one freshly-created person page against the rest of the index). Both land candidates in Sub-project A's reconciliation queue via `refreshQueue` — never auto-merged.
  - **Immediate detection on new-page creation** — `compileFromSource` (`compiler.ts`) and `link-concepts.ts`'s `new` branch both call `findNameVariantCandidatesForNewPage` + `refreshQueue` right after creating a person page, gated on `enrichment.personResolution.enabled`, best-effort (try/catch, logged not thrown) so a candidate-check failure never blocks or undoes page creation. Gives a same-day reconciliation-queue entry instead of waiting on the (often-disabled) scheduled `detect-entity-dupes` sweep.
  - **Rot-scan reporting** (`src/intelligence/rot-scan.ts`) — a "Bare-identity person pages" table (`identity_uncertain: true` person pages), visibility-only like the existing thin-content table, in `wiki/_system/vault-health.md`.
  - **Wikilink-hygiene fix** — `entity-compiler.ts` normalizes any `[[folder/path/Name]]`-shaped wikilink the LLM emits down to bare-name form `[[Name]]` before writing compiled content into a protected region, so `entity-merger.ts`'s `rewriteWikilinks()` (which matches on the file's trailing path segment, case-sensitive) can find and update it on a future merge.
- **Draft/archival lifecycle (Sub-project C)** — a real-vault audit found `status` was write-once for the overwhelming majority of vault content (96.8% of `source_summary` notes permanently `status: draft`, `NoteStatus`'s `rejected` value and `project_status`'s `archived`/`completed` buckets with zero producers, `superseded_by` always empty). Every mechanism below is deterministic-lane, zero LLM calls. See `specs/specification.md` §25 for the full design.
  - **G0/G7 — draft/archived → active promotion.** The real call sites that stamp `ingest_status: 'linked'` (`link-concepts.ts`, `compile-entities.ts` ×2 sites, `agent-ingest.ts`) also promote `status: draft | archived -> active` in the same write, gated on `intelligence.lifecycle.enabled` (default `true`) and never overriding an explicit `status: rejected`.
  - **G1 — stale-draft visibility.** `rot-scan.ts`'s new "Stale draft sources" table (above), reporting-only.
  - **G2 — stale-draft auto-archival.** New `archive-stale-drafts` job (daily, priority 90; `src/jobs/handlers/archive-stale-drafts.ts`) auto-archives (`status: draft -> archived` + `archived_at`/`archived_reason`) `source_summary` notes past `intelligence.lifecycle.staleDraftArchiveDays` (default 30). Gated on **both** `intelligence.lifecycle.enabled` **and** `intelligence.lifecycle.staleDraftArchiveEnabled` — the latter defaults to **`false`** and is a deliberate, load-bearing safety decision: a real vault's worth of already-stale drafts would be archived in one pass the moment this flag is flipped, so it ships fully built but off until an operator explicitly opts in. No code path in this repo sets it to `true` or bypasses reading it from config.
  - **G3/G4 — archive queue.** `src/maintenance/archive-queue.ts` mirrors `reconciliation-queue.ts` (Sub-project A) exactly — `{layout.system}/archive-queue.md`, `ArchiveEntry` (`pending`/`resolved`/`skipped`), `refreshArchiveQueue()` (dedup by `path`, blocks re-addition in any status), `resolveArchiveEntry()`, `applyArchiveDecision()` (shared mutation logic for both resolution surfaces below). `rot-scan` feeds its existing stale+orphan+low-confidence `candidates` list into the queue (gated on `intelligence.lifecycle.archiveQueueEnabled`, default `true`, independent of `maintenance.reviewEnabled`). Two resolution surfaces, each operating on exactly one queue entry per call (no batch-apply path): `karpathy archivist` (interactive CLI, `[a]rchive [k]eep [S]upersede [s]kip [q]uit`) and the `resolve_archive_candidate` MCP tool (no args → up to 10 pending entries; `{ id, decision, supersededByPath? }` → applies one decision). `archive` sets `status: archived` + `archived_at`/`archived_reason` (+ `project_status: archived` when `type === 'project'` — that bucket's first real producer); `supersede` additionally appends to `superseded_by` (deduped) — that field's first real writer anywhere in the codebase; `keep`/`skip` only touch the queue entry.
  - **G5 — review-queue status wiring, and a pre-existing bug fix.** `approveReviewItem`/`rejectReviewItem` (`src/review/review-queue.ts`) now also set the base `status` field (`active` / `rejected` — `rejected`'s first real producer) alongside `review_state`. Fixing this surfaced a **pre-existing, real production bug**: both functions previously mutated frontmatter via regex (`/review_state: \w+/` etc.) against the raw file string, but `createReviewItem` (the sole real producer of `review/*.md` notes) serializes every scalar value JSON-quoted (`status: "draft"`), which an unquoted-value regex can never match — `karpathy review approve`/`reject` had been silently no-op'ing on `review_state`/`resolution_state` against every real review item since the review workflow shipped. Fixed by switching both functions to `parseNote`/`serializeNote` (this project's standard frontmatter round-trip) instead of raw regex-replace, which also rebuilt `test/review/review.test.ts`'s fixtures to be produced by the real `createReviewItem()` entry point instead of hand-typed unquoted YAML, so this bug class can't resurface undetected.
  - **G6 — removed dead code.** `decay-scan.ts`'s `archive_candidate` frontmatter write (no consumer, no clear-on-recovery branch, no test coverage) is removed; rot-scan's archive-queue feed (G3) is its replacement. `DecayScanResult.archiveCandidates` is removed from the interface; the underlying `archiveThreshold` config value is kept (still feeds the low-confidence research-candidate gate a few lines later in the same function).
  - **Un-archival on re-engagement (G7, continued)** — `refreshTopic()` (`src/intelligence/topic-refresh.ts`) and the `re-enrich-note` job both flip `status: archived -> active` (clearing `archived_at`/`archived_reason`) after a genuine content rewrite/re-enrichment pass — never on a no-op branch (unsupported type, zero retrieval hits, or the existing <50-char re-enrichment gate). Archival is never a one-way trap; manual `status` edits remain available at all times regardless.
- **Self-referential filtering** (`compile-entities.ts`) — source content describing the tool's own development is detected by comparing the source summary's `project_slug` frontmatter against `slugify(basename(projectRoot))`; on a match, entity/concept/decision/tool/organization/action-item compilation is skipped entirely — no pages, glossary entries, or checklist items get created (extraction itself still runs and still populates the source summary's own `entities` region; the source is still ingested and searchable via the summary note — just excluded from curation).
- **Mark-dirty primitive** (`src/maintenance/mark-dirty.ts`) — `markDirty(vault, { notePath, ref, reason? })` appends evidence to a note's `pending_evidence` queue (idempotent, bounded). `clearPendingEvidence(vault, notePath)` flushes the queue and stamps `last_verified`. Foundation for Phase 1 `evaluate-refresh-candidates` cascade.
- **Refresh threshold gate** (`src/jobs/handlers/evaluate-refresh-candidates.ts`) — Lane 1, deterministic. Reads a note's `pending_evidence_count`; enqueues `topic-refresh` when ≥ `intelligence.refresh.threshold` (default 3) or when retrievability has decayed below the floor and at least one pending entry exists. Wired into `link-concepts` (per merged concept) and via the topic-refresh depth-1 cascade.
- **Topic refresh cascade** (`src/intelligence/topic-refresh.ts`) — on successful rewrite, clears `pending_evidence` and (when `intelligence.refresh.cascadeDepth >= 1`) calls `markDirty` on each direct neighbor referenced in the new `current-understanding` region. Neighbors are NOT auto-refreshed — the threshold gate decides on the next ingest cycle.
- **Topic refresh budget** — `topic-refresh` handler reserves one `medium`-tier LLM call from `BudgetTracker` before invoking `refreshTopic`. On refusal, the job exits without modifying the note; the pending queue is preserved.
- **Reflection budget** (`src/shared/budget.ts`) — `createBudgetTracker({ statePath, limits, enabled })` issues per-tier daily LLM-call reservations. Persists to `.karpathy/state/budget.json`. Rolls over at local midnight; corrupt-on-disk state falls back to fresh.
- **Embedding cache** (`src/embeddings/store.ts`) — `upsert` and `replaceDoc` skip the provider call when `(provider_id, chunk_hash)` is already stored; `getCacheStats()` exposes hit/miss counters.
- **Vault root artifacts** — `log.md` (append-only, via `appendLogEntry`), `index.md` (rebuilt by `rebuildVaultIndex`), `wiki/_system/research-queue.md` (rebuilt on each `research-propose`).

## Configuration additions

```jsonc
{
  "embeddings": {
    "provider": "deterministic" | "bedrock-titan" | "ollama",
    "model": "nomic-embed-text",        // for "ollama"
    "baseUrl": "http://localhost:11434", // for "ollama"
    "timeoutMs": 5000,                   // for "ollama" probe + per-call timeout
    "dimensions": 1024
  },
  "llm": {
    "model": "us.anthropic.claude-sonnet-4-6",
    "models": {
      "fast":   "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "medium": "us.anthropic.claude-sonnet-4-6",
      "heavy":  "us.anthropic.claude-opus-4-6-v1"
    }
  },
  "intelligence": {
    "recencyWeight": { "session": 0.3, "concept": 0.1, ... },
    "tldr": { "enabled": true, "maxChars": 120, "cooldownDays": 1 },
    "digest": { "enabled": true, "windowDays": 7, "minClusterSize": 3, "maxClusters": 8 },
    "decay": { "enabled": true, "retrievabilityRefresh": 0.5, "retrievabilityArchive": 0.2 },
    "refresh": { "enabled": true, "threshold": 3, "considerRetrievability": true, "cascadeDepth": 1 },
    "budget": { "enabled": true, "llmCallsPerDay": { "fast": 200, "medium": 50, "heavy": 10 } },
    "research": { "enabled": true, "queueCap": 50, "autoExpireDays": 14, "autoExpireBelowScore": 0.3, "autoDrainEnabled": false, "depths": { ... }, "search": { "provider": "noop" } }, // autoDrainEnabled (Sub-project D, G1): defaults false, real-vault-safety decision — do not flip without operator intent
    "richness": { "enabled": true, "glossarySynthesisThreshold": 3 }, // gates decay-scan's thin-content backfill + glossary-synthesize
    "lifecycle": {
      "enabled": true,                    // master gate for G0/G7 promotion sites + G2's archive-stale-drafts job
      "staleDraftReportDays": 14,          // G1: age past which a draft source_summary appears in vault-health.md
      "staleDraftArchiveEnabled": false,   // G2: SECOND gate (alongside `enabled`) for the archive-stale-drafts job — defaults false, real-vault-safety decision, do not flip without operator intent
      "staleDraftArchiveDays": 30,         // G2: age past which a draft source_summary is auto-archived (once staleDraftArchiveEnabled is true)
      "archiveQueueEnabled": true          // G3: gates rot-scan feeding candidates into archive-queue.md
    }
  },
  "notifications": { "slack": { "enabled": false, "webhookUrl": "...", "target": "#channel" } },
  "ingest": {
    "stopDrainMinIntervalMs": 30000 // Fix B: min ms between Stop/PostCompact-hook-spawned background drains; scheduled intel tick still drains every 5 min regardless
  },
  "enrichment": {
    "significanceGate": "heuristic" | "off" | "llm",  // default: "llm"
    "significanceGateDropConfidence": 0.7, // below this, an LLM "drop" verdict still creates the page (flagged for review) instead of discarding it
    "personResolution": {
      "enabled": true,                    // gates Component 3 (immediate name-variant detection on new-page creation)
      "externalIdCaptureEnabled": true,    // gates Slack-handle external-ID capture at extraction time
      "nicknameMatchingEnabled": true,     // gates honorific/nickname/initials matching in entity-resolver.ts
      "extraNicknameGroups": []            // e.g. [["grig", "grigor"]] — appended to the built-in NICKNAME_GROUPS seed list
    }
  }
}
```

## Hook System

Hooks are configured as `type: "command"` in `~/.claude/settings.json`. They call `node dist/bin/karpathy.js hook <event>` with JSON on stdin and return JSON on stdout. Critical hooks (SessionStart, PostCompact, Stop) are synchronous; capture hooks (UserPromptSubmit, PostToolUse) are async.

## Hybrid search (§24)

- **Unified MCP `search` tool** — combines FTS5 BM25 keyword search (covers every markdown file in the vault) with the configured embedding provider's semantic pool via Reciprocal Rank Fusion + recency weighting. Accepts a free-text `query` OR a vault note `path` anchor. Replaces `search_vault` and `get_related` (both kept registered with `Deprecated — use search instead.` descriptions).
- **`HybridStore`** — entry point in `src/search/hybrid-store.ts`. Constructed via `openHybridStoreFromConfig(config, projectRoot)` from `src/search/factory.ts`. Owns one SQLite handle housing both the embeddings table and the `notes_fts` FTS5 virtual table. Falls back to keyword-only mode (with a `degradation_note`) when the embedding provider is unreachable.
- **Sync layers** — keep the FTS index current via four cooperating layers:
  1. Scheduled `sync-fts-index` job (5-min cadence in `defaultSchedule()`, priority 100). Triggered every intel tick.
  2. Stop hook (`src/hooks/stop.ts`) enqueues `sync-fts-index` at session end.
  3. Ingest pipeline calls `hybridStore.upsertDoc(...)` per doc.
  4. File watcher (`src/ingest/watcher.ts`) handles `add`/`change`/`unlink` events; the MCP server enqueues per-file FTS sync jobs.
- **Maintenance CLI** — `karpathy maintenance --populate-fts` (one-shot full FTS seed), `--re-embed` (refresh embeddings under current provider), `--prune-provider <id>` (drop stale provider rows).
- **Ollama provider** — `createOllamaProvider({ baseUrl, model, dimensions, timeoutMs })` in `src/embeddings/ollama.ts`. POSTs to `/api/embeddings`, returns L2-normalized `Float32Array`. Companion `isOllamaAvailable(baseUrl, timeoutMs)` is a non-throwing probe used by `HybridStore.search` before fanning out semantic queries.

## Resource boundedness (§27)

A root-cause audit found 16 concurrently-running Claude Code windows each spawning an independent MCP server, each running its own chokidar watcher over the same OneDrive-backed vault folders — driving `fileproviderd`/OneDrive CPU usage to the point of crashing the machine. Four fixes:

- **Single-watcher lock** — `src/ingest/watcher.ts`'s `acquireWatcherLock(lockDir)` wraps the existing `createFileLock` (`src/jobs/lock.ts`, unchanged) keyed `'watcher'`. `src/mcp/server.ts` acquires it before starting the chokidar watcher; a live holder elsewhere means this instance skips starting a watcher entirely (relies on the holder's watcher + the 5-min `intel tick` FTS sync instead). Released — and the watcher stopped — in the server's existing `shutdown()` path (stdin-close/SIGTERM/SIGHUP/`server.onclose`).
- **Stop/PostCompact drain throttle** — `src/hooks/background-drain.ts`'s `spawnBackgroundDrain` is now async, taking `{ lockDir, stateDir, minIntervalMs? }` (wired via `src/hooks/dispatch.ts`). Skips spawning when the job runner's global `__drain__` lock is held by a live PID, or when the last spawn was within `ingest.stopDrainMinIntervalMs` (default 30000ms, recorded in `<stateDir>/last-drain.json`). The scheduled `intel tick` still drains every 5 min regardless, so a skip never strands work.
- **`enqueueJob` flush fix** — `src/mcp/context.ts`'s `enqueueJob` previously called `queue.enqueue()` without `queue.flush()`, silently dropping watcher-triggered `sync-fts-index` jobs before they reached `job-queue.json`. Fixed via the extracted, directly-testable `enqueueAndPersist(queue, input)`.
- **Websearch subprocess reaping** — `src/intelligence/web-search.ts`'s per-call MCP search client tracks `StdioClientTransport.pid` and, after the SDK's own `close()`, walks and reaps any surviving process-tree descendants via `pgrep -P` (`reapProcessDescendants`) — the SDK's own close() only SIGKILLs the direct command PID, leaking Puppeteer/Chromium grandchildren a websearch MCP server spawns via `npx`. The live operator config's `intelligence.research.search.provider` was also flipped from `mcp` to `noop` (inert, unused path).

A follow-up audit found the job system itself unbounded in four further ways (Fixes E-H), independent of the multi-instance MCP issue above:

- **Fix E — global runner lock** — `src/jobs/runner.ts`'s `runAll()` now acquires one global lock (key `'queue-runner'`, on the same `FileLock`/`lockDir` already passed to `createJobRunner` for per-`targetPath` locking — no new plumbing) before draining, released in a `finally`. Since `FileLock.acquire` throws `LockError` immediately rather than blocking on cross-process contention, acquisition retries with a bounded wait (defaults: 8 attempts, 1s apart, ~7s total; overridable via the test-only `queueRunnerLock` option). Still held after the wait → logs `queue-runner lock held — another drain in progress, skipping` and returns `0` without draining or throwing; jobs stay pending for the holder or the next 5-min `intel tick`. Previously, the launchd tick, Stop-hook drain, MCP `runDeterministicJobs`, and CLI `enqueueAndDrain` could all drain the same `job-queue.json` concurrently — duplicate LLM calls, last-writer-wins `flush()` corruption, and jobs lacking a `targetPath` (`decay-scan`, `rot-scan`, `sync-fts-index`, `digest-weekly`, `archive-stale-drafts`) took no lock at all.
- **Fix F — capped transient retries** — `jobs.transientRetry.maxTransientRetries` (config, default 20). `src/jobs/queue.ts`'s `fail()` `transient` branch previously reset a job to `pending` and incremented `transientRetryCount` forever, never consulting `maxRetries` — a job against an unreachable Bedrock endpoint retried every ≤30 min indefinitely, re-spending LLM budget each attempt. Now, once `transientRetryCount` exceeds the cap, the job is marked terminally `failed` (same terminal path the non-transient branch uses) instead of re-queued; the log message dropped its now-inaccurate "retrying indefinitely" wording.
- **Fix G — decay-scan fan-out cap** — `intelligence.decay.maxRefreshEnqueuePerRun` (config, default 25). `src/intelligence/decay-scan.ts` previously enqueued one `topic-refresh` per stale/thin note with no cap, growing 1:1 with vault size. Qualifying candidates are now collected across the whole scan, sorted by urgency (thin-content trigger first, then lowest retrievability first), and only the top N enqueued; the rest are skipped this run and logged (`decay-scan:capped`, only when non-zero) via the existing `appendLogEntry` convention. `DecayScanResult` gained `refreshCapped`; per-note scoring/write-back and the (uncapped, separately-bounded) research-candidate surfacing are unaffected.
- **Fix H — active-queue cap + budget-tracker lock** — `jobs.maxActiveJobs` (config, default 1000, threaded into every production `createJobQueue` call site): `enqueue()` now refuses a new non-deduped job once the active (pending+running) count reaches this ceiling, logging a warning and returning `null` — `JobQueue.enqueue()`'s return type is now `Promise<Job | null>` (no production call site inspects the resolved value, so this is non-breaking); dedup lookups are unaffected. Separately, `createBudgetTracker` gained an optional `lockDir`: when set, `tryReserve`/`reset` re-read committed state from disk and serialize their read-modify-write via `createFileLock(lockDir)` under a `'budget'` key (bounded retry, ~500ms total, falling back to unlocked past that budget) — closing a lost-update race between tracker instances/processes racing between `budget.json`'s load and flush. `createBudgetTrackerFromConfig` derives `lockDir` automatically from `projectRoot` + `config.lockDir`, so every existing call site is covered without change; `BudgetTracker.tryReserve`/`reset` are now `Promise`-returning and all call sites `await` them.

## Common Tasks

- **Add a new job type**: Add to `JobType` enum in `src/jobs/types.ts`, create handler in `src/jobs/handlers/`, register in `src/jobs/handlers/index.ts`
- **Add a new wiki note type**: Add Zod schema in `src/vault/frontmatter.ts`, add template in `templates/`
- **Add a new hook**: Add handler in `src/hooks/`, register in `src/hooks/dispatch.ts`, add input schema in `src/hooks/types.ts`
- **Add a new MCP tool**: Create handler in `src/mcp/tools/`, add to `src/mcp/tools/index.ts` (definitions) and `src/mcp/tools/router.ts` (handlers), add tests in `test/mcp/tools.test.ts`
