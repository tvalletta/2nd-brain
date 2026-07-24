# Design: Taxonomy & Extraction Redesign (Sub-project B1)

**Status:** Approved for spec write-up (design conversation complete 2026-07-24)
**Sub-project:** B1 of the post-audit curation redesign. B2 (content richness — extending synthesis depth to wiki pages and adding real explanatory content to review notes) is a separate spec, not covered here. Sub-project A (activating the dormant significance gate, review-detector scheduling, and entity-dedup auto-merge) is complete and merged.

## 0. Context

A curation-effectiveness audit (2026-07-23) found that of the vault's ~139 "curated" notes, only the 23 `topic` notes are genuinely working — real multi-source synthesis, actively refreshed. The other ~116 (entity/concept/decision/tool/organization) were frozen at a single 2026-05-15 backfill: concept notes in particular are one-line stubs, sometimes with verbatim-identical boilerplate across different concepts; only 3 of 9 decision notes are real committed choices (the rest are process trivia or a meta-decision titled "Audit the audit"); tool/organization notes contain noise (Claude Code's own `Glob`/`Read` tool calls became permanent wiki pages; Workfront and "Claude Max Enterprise" — a product and a subscription tier — are miscategorized as `organization`).

Tom's own framing, in response to the audit's follow-up questions: "topics work, but some of the other things don't" (concepts, primarily); people/entity resolution matters (misspelled-name lookup); decisions and action items should be *maintained, improved, and cleaned up* — they're underused because of their current shape, not because they lack value; self-referential (karpathy-developing-itself) content should be filtered from curation but should remain searchable.

A second grounding pass (2026-07-24, post Sub-project A) surfaced concrete, previously-unknown defects that directly explain several of these symptoms:
- **`action_items` is silently dropped.** The extraction prompt (`src/enrichment/prompts.ts:159-195`) already asks the LLM for a distinct `"action_items": [{task, owner, due_date, status}]` array, but `RichExtractedEntitiesSchema` (`src/enrichment/entity-extractor-rich.ts:19-79`) has no field for it. Since `llm.extractStructured` parses with a non-strict Zod schema, any `action_items` the LLM returns is silently stripped before it ever reaches `compile-entities.ts`. Today's `decisions` bucket conflates genuine decisions with to-dos partly *because* the pipeline already throws away the signal that would separate them.
- **Decision notes are structurally unable to be maintained.** `entity-compiler.ts`'s decision-specific synthesis prompt (`src/enrichment/prompts.ts:321-338`) asks the LLM for sections labeled `SUMMARY/PEOPLE/PROJECTS/TOPICS/SOURCES`, but a decision note's actual protected regions are `context/outcome/people/sources` (`src/ingest/entity-writer.ts:224-230`). `parseSectionResponse` (`src/compilation/entity-compiler.ts:182-226`) only keeps a section if its label matches an entry in `KIND_SECTIONS[kind]`; for decisions, `SUMMARY`/`PROJECTS`/`TOPICS` never match anything, so only `people`/`sources` ever get rewritten. `context`/`outcome` — the decision's actual narrative — have never once been touched by synthesis since page creation, on any decision note in the vault.
- **`project_slug` is computed and persisted but never reaches the entity-creation choke point.** It's set on the source-summary note's frontmatter at ingest time (`src/jobs/handlers/ingest-raw-file.ts:110-112`) and passed one hop into `classify-source.ts`'s job payload, but every downstream handler (`classify-source.ts`, `extract-entities.ts`, `compile-entities.ts`) drops it from the payload it cascades forward. It's still recoverable — the source-summary note's frontmatter carries it for the note's whole life — just not currently read at the point where a self-reference filter would need it.

This spec covers fixing all of the above, plus the taxonomy decisions from the design conversation (§1). It does **not** cover extending rich synthesis to entity/concept/tool/organization notes, adding real LLM-generated explanations to contradiction/duplicate review notes, or resolving shallow person entities (bare Slack handles) to real names — all of that is Sub-project B2.

## 1. Type disposition (what this spec changes)

| Type | Before | After |
|---|---|---|
| `topic` | Standalone, rich synthesis | Unchanged |
| `project` | Standalone | Unchanged |
| `entity` (person) | Standalone | Unchanged structurally (dedup/merge already live via Sub-project A) |
| `concept` | Standalone page per concept (thin, frozen) | **Eliminated as standalone pages.** Consolidated into `Curated/wiki/concepts/glossary.md`, one section per concept, listing every mention with source + context |
| `decision` | Standalone, but conflated with to-dos/trivia; synthesis-broken | Standalone, tightened at extraction time to genuine committed choices; synthesis bug fixed so `context`/`outcome` actually get maintained |
| `action_items` (new) | Silently dropped by schema bug | Recovered; tracked in per-project `action-items.md` + a vault-wide rollup, as a markdown checklist — not standalone pages |
| `tool` | Standalone, blocklist too narrow | Standalone, broader noise filtering |
| `organization` | Standalone, no product-vs-org distinction | Standalone, extraction-prompt guidance added; 2 known-bad existing entries fixed manually |

Self-referential (karpathy/2nd-brain development) sessions continue to ingest as raw, searchable `source_summary`/`session_summary` notes; they stop spawning entity/concept/decision/tool/organization pages.

## 2. Goals / Non-Goals

**Goals:**
- Concepts stop being individual thin pages; existing 37 are migrated into one glossary, future extractions append to it.
- `action_items` is recovered from the extraction schema and given a real destination (per-project + rollup checklists), separate from `decisions`.
- Decision extraction is tightened (prompt guidance distinguishes decision / action-item / trivia) and decision synthesis is fixed so `context`/`outcome` regions are actually maintained going forward.
- Self-referential karpathy-development content no longer creates entity/concept/decision/tool/organization pages, while remaining fully searchable as raw source/session notes.
- Tool and organization noise filtering is broadened (generic Claude Code tool names, system state-file patterns, product-vs-org prompt guidance); the 2 known-bad existing organization entries are corrected.

**Non-goals (deferred to Sub-project B2):**
- Extending topic-refresh-style (or entity-compiler-style) rich synthesis to concept/entity/tool/organization content.
- Adding real LLM-generated explanations to contradiction/duplicate review notes (currently 100% templated, zero LLM involvement).
- Resolving shallow person entities (bare Slack handles) to real names.
- Archival/decay policy for completed action items (tracked here only as open/done; auto-expiry or archival-after-N-days is Sub-project C's concern).

## 3. Component 1 — Concept glossary

### 3.1 File and format

New file: `Curated/wiki/concepts/glossary.md` — deliberately **not** `_index.md` (the auto-generated category index rebuilt by `rebuildVaultIndex()`; overloading it risks collision with that job). Frontmatter: `type: index`, `title: "Concept glossary"`. Body is one protected region (`glossary-entries`) containing all concept sections:

```markdown
---
type: index
title: Concept glossary
created_at: ...
updated_at: ...
protected_regions: [glossary-entries]
---

# Concept glossary

%% begin:glossary-entries %%
## Efficiency
*Last mentioned: 2026-07-20*
- "Architectural principle used as a benchmark for evaluating audit findings" — [[architectural-best-practices]] (2026-05-15)
- "Team velocity benchmark discussed in retro" — [[code-audit]] (2026-06-10)

## Modularity
*Last mentioned: 2026-06-01*
- "..." — [[...]] (...)
%% end:glossary-entries %%
```

### 3.2 Module: `src/maintenance/concept-glossary.ts`

```typescript
export interface ConceptMention {
  sourceRef: string;   // wikilink target, e.g. "architectural-best-practices"
  gloss: string;       // the extracted definition/context text for this mention
  date: string;        // ISO date the mention was recorded
}

export interface ConceptEntry {
  name: string;         // canonical concept name, e.g. "Efficiency"
  mentions: ConceptMention[];
}

export async function upsertConceptMention(
  vault: VaultAdapter,
  layout: VaultLayout,
  concept: { name: string; gloss: string; sourceRef: string },
): Promise<void>;
```

`upsertConceptMention`: reads `Curated/wiki/concepts/glossary.md` (creates it with the header above if absent), parses the `glossary-entries` region into `ConceptEntry[]` keyed by normalized name (reuse `normalizeName()` from `src/ingest/entity-resolver.ts` — same normalization already used for entity dedup, so "Efficiency" and "efficiency" collapse to one entry), appends a new `ConceptMention` if this exact `(name, sourceRef)` pair isn't already present (idempotent — matches the `pending_evidence` idempotency pattern in `mark-dirty.ts`), re-serializes, `atomicWrite`s.

### 3.3 Routing change

In `src/jobs/handlers/compile-entities.ts`, the existing `for (const concept of (entities.concepts ?? []))` loop (currently pushing into `compilable`) is replaced: instead of building a `CompilableEntity`, it calls `upsertConceptMention(context.vault, layoutFromConfig(context.config), { name: concept.name, gloss: concept.definition ?? '', sourceRef: sourceSummaryPath })` directly, still subject to the existing `shouldInclude` blocklist/confidence filter. `compiler.ts`/`compileFromSource` is untouched — it never sees concept-kind entities again.

### 3.4 Migration

One-time job/script (`karpathy migrate concepts-to-glossary` or a maintenance job type `migrate-concept-glossary`): for each existing `Curated/wiki/concepts/*.md` file (excluding `_index.md`), read its `title`/`canonical_name`, its `source_refs`, and its `definition` region content; call `upsertConceptMention` once per source_ref (using the note's single definition text, since the old pages don't distinguish per-mention gloss); then delete the old page and rewrite any `[[old-concept-slug]]` wikilinks elsewhere in the vault to point at `[[glossary#Concept-Name]]` (reuse `rewriteWikilinks()` from `src/compilation/entity-merger.ts`, generalized to accept a heading-anchor target instead of only a bare slug).

## 4. Component 2 — Action items

### 4.1 Schema recovery

Add to `RichExtractedEntitiesSchema` (`src/enrichment/entity-extractor-rich.ts`):

```typescript
actionItems: z.array(z.object({
  task: z.string(),
  owner: optStr,
  dueDate: optStr,
  status: z.enum(['open', 'done']).default('open'),
  confidence: z.number().min(0).max(1).default(0.5),
  chunkRefs: z.array(z.string()).default([]),
})).default([]),
```

Field name in the Zod schema is `actionItems` (camelCase, matching the file's existing convention for other fields); the prompt's JSON key stays `action_items` (snake_case, matching the prompt's existing convention for all its other keys) — this is the first multi-word key in this schema, so no existing remap precedent to follow. Fix: in `entity-extractor-rich.ts`, wherever the raw parsed LLM JSON object is assembled before `RichExtractedEntitiesSchema.parse()` is called, rename the `action_items` key to `actionItems` on that plain object first (a one-line `const { action_items: actionItems, ...rest } = raw; const normalized = { ...rest, actionItems };` or equivalent) — not a Zod `.transform()`, since transforms run on already-validated shape and the mismatch here is a raw pre-validation key name, not a post-parse value shape.

### 4.2 Files and format

Per-project: `Curated/wiki/projects/<project-slug>/action-items.md` (sibling to the existing `decisions.md`/`product.md`/`technical.md` files each project hub already has, created via `getOrCreateProjectHub()` in `src/compilation/project-hub.ts`). Vault-wide rollup: `Curated/wiki/_system/action-items.md`.

Both are a single protected region (`action-item-entries`) containing a flat markdown checklist:

```markdown
%% begin:action-item-entries %%
- [ ] Investigate root cause of missing project enrichment — from [[session-2026-06-15]] `id:a1b2c3`
- [x] Create multi-vector radar view for calibrating architects `id:d4e5f6`
%% end:action-item-entries %%
```

The rollup's entries additionally show which project each came from: `- [ ] Investigate root cause of missing project enrichment (2nd-brain) — from [[session-2026-06-15]] \`id:a1b2c3\``. The trailing `` `id:xxxxxx` `` is a stable per-item id (6-char nanoid) so re-parsing can match an item back to its source record even if the task text is edited by hand in Obsidian.

### 4.3 Module: `src/maintenance/action-items.ts`

```typescript
export interface ActionItem {
  id: string;
  task: string;
  owner?: string;
  dueDate?: string;
  status: 'open' | 'done';
  sourceRef: string;
  projectSlug: string;
  createdAt: string;
}

export async function upsertActionItem(
  vault: VaultAdapter,
  layout: VaultLayout,
  item: { task: string; owner?: string; dueDate?: string; sourceRef: string; projectSlug: string },
): Promise<void>;
```

`upsertActionItem`: parses the target file's checklist (both the per-project file and the rollup, in that order) preserving each existing item's checkbox state (`[ ]` vs `[x]`) by id — this is the read-before-write step that makes hand-toggled checkboxes in Obsidian survive the next automated pass, following the same "preserve existing user decision" pattern `research-propose.ts` already uses for the research queue. A genuinely new item (no existing id matches on `(task, sourceRef)` — same-task-different-source is treated as a new mention, not a duplicate) gets a fresh id and `status: 'open'`. `atomicWrite`s both files.

### 4.4 Routing

In `compile-entities.ts`, a new `for (const item of (entities.actionItems ?? []))` loop applies the same `shouldInclude(item.task, 'action_item', item.confidence)` blocklist/confidence check the other kind-loops already use (§4.1's `confidence` field feeds this — action items are not exempt from noise filtering just because they're not full pages), then calls `upsertActionItem(context.vault, layout, { ...item, sourceRef: sourceSummaryPath, projectSlug })`, where `projectSlug` comes from the source summary's own `project_slug` frontmatter field (already read for the self-reference check in §6 — same read, reused). If `projectSlug` is `'general'` or `'discovery'` (the cwd-classifier's non-project buckets, `src/ingest/cwd-classifier.ts:26-44`), `upsertActionItem` writes only to the rollup, skipping the per-project file (there is no real project to scope it to).

## 5. Component 3 — Decision tightening

### 5.1 Extraction prompt guidance

In `src/enrichment/prompts.ts`, the rich-extraction prompt's `decisions` field description gains explicit criteria (inserted alongside the existing schema-shape guidance):

```
A "decision" is a choice that was actually committed to — not a stated
preference, an observed fact, or a task still to be done. If the text
describes a task someone needs to do, extract it under "action_items"
instead. If it's just background/context/preference with no choice being
made, don't extract it as either.
```

### 5.2 Fix the decision synthesis label mismatch

In `src/compilation/entity-compiler.ts`, the decision branch of `compileEntityPrompt` (`src/enrichment/prompts.ts:321-338`) currently requests `SUMMARY:`/`PEOPLE:`/`PROJECTS:`/`TOPICS:`/`SOURCES:`. Change it to request `CONTEXT:`/`OUTCOME:`/`PEOPLE:`/`SOURCES:` — matching `KIND_SECTIONS.decision = ['context', 'outcome', 'people', 'sources']` (`entity-compiler.ts:31`) exactly, so `parseSectionResponse` actually keeps the `context`/`outcome` content instead of discarding it. The prompt text for these two sections: `CONTEXT` = "the situation/reasoning that led to this decision, synthesized from all sources so far"; `OUTCOME` = "what actually happened as a result, if known — leave empty if still pending."

## 6. Component 4 — Self-reference filtering

### 6.1 Where the check happens

`src/jobs/handlers/compile-entities.ts`, at the top of the handler, before the existing per-kind loops build `compilable`: read `project_slug` from the source summary's frontmatter (the handler already does `parseNote(await context.vault.read(sourceSummaryPath))` later at line ~139 for a different purpose — move that read earlier and reuse the parsed `data`).

```typescript
const summaryContent = await context.vault.read(sourceSummaryPath);
const { data: summaryData } = parseNote(summaryContent);
const projectSlug = summaryData.project_slug as string | undefined;
const selfSlug = slugify(basename(context.projectRoot));
const isSelfReferential = projectSlug === selfSlug;
```

`slugify`/`basename` are both already imported elsewhere in this file's neighbors (`src/vault/paths.ts`, `node:path`). No new config field — the tool always knows its own root via `context.projectRoot` (already on `JobContext`, threaded through in Sub-project A's Task 3).

### 6.2 Effect

If `isSelfReferential`, skip building `compilable` entirely (entity/concept/decision/tool/organization/action-item creation all skipped for this source) — but the handler still performs its existing bookkeeping (mark `ingest_status: 'linked'`, since there's nothing more to link) so the source summary doesn't stay stuck in a pending state. The `cross-link-pages`/`rebuild-indexes` cascades at the end of the handler are skipped too (nothing was created to cross-link).

### 6.3 Scope

Only `compile-entities.ts` (the production path) gets this check. The legacy `link-concepts.ts` path (manual re-enrichment only, not part of the automatic ingest cascade per Sub-project A's grounding) does not — low value for the added surface, since it's never invoked automatically.

## 7. Component 5 — Tool & organization noise filtering

### 7.1 Broaden the tool blocklist

In `src/enrichment/entity-filter.ts`, extend the existing blocklist mechanism (`BUILTIN_BLOCKLIST`, `AGENT_TOOL_NAMES`) with a new `CLAUDE_CODE_TOOL_NAMES` set covering the actual built-in tool surface (case-insensitive match): `read, write, edit, glob, grep, bash, task, webfetch, websearch, todowrite, notebookedit, askuserquestion, exitplanmode` (and their common display variations). Also add a pattern check: names ending in `-json` or matching known state filenames (`config.json`, `job-queue.json`, `ingest-tracker.json`, `budget.json`) are treated as noise regardless of kind.

### 7.2 Organization prompt guidance

In `src/enrichment/prompts.ts`, the `organizations` field description gains: `"Only extract genuine organizations (companies, teams, departments) — not products, services, or subscription tiers (e.g. 'Workfront' is a product, not an organization; skip it or extract its parent company instead)."`

### 7.3 Manual cleanup

`Curated/wiki/organizations/workfront.md` and `Curated/wiki/organizations/claude-max-enterprise.md` are deleted (or reclassified as `tool` entries, if their content is otherwise useful) as a one-time manual fix — 2 known instances, not worth an automated migration.

## 8. Config schema changes

One schema addition: `RichExtractedEntitiesSchema.actionItems` (§4.1). No new user-facing `KarpathyConfig` fields — self-reference filtering uses the existing `projectRoot`, tool/org noise filtering is a hardcoded list extension (matching how `AGENT_TOOL_NAMES` already works today, not user-configurable), and the concept-glossary/action-items file locations are fixed paths (not configurable), consistent with how `research-queue.md`/`reconciliation-queue.md` are also fixed paths today.

## 9. Testing plan

- Unit tests for `concept-glossary.ts`: creates file if absent; appends new mention; is idempotent on `(name, sourceRef)` re-runs; normalizes concept name casing to avoid duplicate sections.
- Unit tests for `action-items.ts`: creates per-project and rollup files; routes `general`/`discovery` project slugs to rollup only; preserves hand-toggled `[x]` state across a re-run that also adds a new item; assigns stable ids.
- Unit test for the `action_items` → `actionItems` key transform in `entity-extractor-rich.ts`, confirming a raw LLM response with `action_items` populates the parsed result (regression guard for the exact bug found in grounding).
- Unit test for the decision label-mismatch fix in `entity-compiler.ts`: given a mock LLM response with `CONTEXT:`/`OUTCOME:` sections, confirm both survive into the compiled note (this was previously silently dropped — assert it isn't anymore).
- Unit test for the self-reference check in `compile-entities.ts`: a source with `project_slug` matching `slugify(basename(projectRoot))` produces zero created/updated entities and `ingest_status: 'linked'`; a source with a different `project_slug` is unaffected.
- Unit tests for the broadened tool blocklist and organization prompt guidance (the latter is a prompt-text assertion plus a mocked-LLM-response test confirming a product-labeled response is filtered, not a live-LLM test).
- Manual verification: run the concept migration script against a scratch copy of the vault (not the live vault, per the Task 6 incident lesson from Sub-project A), confirm the glossary renders sensibly and no `_index.md` collision occurs.

## 10. Explicitly deferred (Sub-project B2 and beyond)

- Rich synthesis for entity/concept/tool/organization content depth.
- Real LLM-generated explanations in contradiction/duplicate review notes.
- Person-entity name resolution (bare Slack handles → real names).
- Action-item archival/decay policy (Sub-project C).

## 11. Open implementation questions (for the plan phase, not product decisions)

- Confirm exactly how `rebuildVaultIndex()` enumerates a folder's entries today, to verify `glossary.md` sitting alongside (now zero) individual concept files doesn't produce a broken or confusing auto-generated `_index.md` for that folder.
- Confirm the exact per-project-hub file-creation convention in `project-hub.ts` (`getOrCreateProjectHub`) to make `action-items.md` created consistently with `decisions.md`/`product.md`'s existing frontmatter/naming.
- Confirm `rewriteWikilinks()`'s current signature can be generalized to a heading-anchor target (`glossary.md#Concept-Name`) without breaking its existing plain-slug callers (entity-merger.ts), or whether a small parallel function is cleaner.
