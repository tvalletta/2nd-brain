# Karpathy Second Memory Specification v2

## 1. Purpose

Karpathy Second Memory is a local-first, automatically maintained knowledge system that captures source material and AI work products, compiles them into a persistent Obsidian wiki, preserves provenance, maintains structure over time, and improves future work without requiring a separate retrieval stack.

The system exists to create compounding knowledge rather than transient chat history.

## 2. Normative language

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY in this document are to be interpreted as normative requirements.

## 3. Goals

The system MUST:

1. capture raw sources and AI work products;
2. compile them into a persistent Obsidian-based knowledge system;
3. maintain links, indexes, summaries, and relationships automatically;
4. capture Claude Code sessions into the vault automatically;
5. preserve provenance and auditability;
6. remain local-first and portable across tools;
7. remain repairable by a human using ordinary files on disk.

## 4. Non-goals

The system MUST NOT depend on:

- a vector database;
- embeddings as a required substrate;
- a cloud service for normal operation;
- a hidden mutable source of truth.

The system SHOULD minimize routine manual upkeep. Human review MAY be required for exception cases defined in this specification.

## 5. System of record

The system has four storage layers. All paths below are logical names. The actual filesystem paths are config-driven via `config.layout` in `~/.karpathy/config.json`. The default layout uses `wiki/`, `outputs/`, `raw/`, `review/` at vault root. The production layout uses `Curated/wiki/`, `Curated/sources/`, `AI Conversations/_summaries/`, etc. Code MUST always derive paths via `layoutFromConfig(config)` and `kindToFolder(layout, kind)` from `src/vault/paths.ts` — never hardcode layout-specific path strings.

### 5.1 `raw/` (logical: source evidence)

`raw/` is the immutable system of record for source evidence.

Rules:

- Files placed in `raw/` MUST be treated as evidence.
- Files in `raw/` MUST NOT be modified in place by automated processes.
- If normalization is required, the normalized artifact MUST be written elsewhere and linked back to the original raw artifact.

### 5.2 `wiki/` (logical: curated knowledge)

`wiki/` is the authoritative system of record for curated knowledge.

Rules:

- Pages in `wiki/` MUST contain structured, human-readable markdown.
- Curated knowledge MAY be updated by automation, subject to overwrite and review rules defined below.
- Every nontrivial claim in `wiki/` MUST carry provenance.

### 5.3 `outputs/` (logical: derived intermediates)

`outputs/` contains derived intermediate artifacts.

Rules:

- Files in `outputs/` MUST be treated as generated intermediates unless explicitly promoted.
- Promotion into `wiki/` MUST preserve a link to the source output artifact.

### 5.4 `CLAUDE.md` and agent config

`CLAUDE.md` is the derived hot cache for active context.

Rules:

- `CLAUDE.md` MUST NOT be treated as authoritative.
- `CLAUDE.md` MAY be regenerated.
- `.claude/` or equivalent configuration MUST be versioned and visible on disk.

### 5.5 Global operator config

Karpathy uses a single global config file at `~/.karpathy/config.json` rather than per-project config files.

Rules:

- The global config MUST contain a `defaults` block with at minimum a `vaultPath`.
- The global config MAY contain a `projects` map of absolute project paths to partial override objects merged shallowly on top of `defaults`.
- Hooks MUST silently skip (exit 0) when the global config is absent or `vaultPath` is not resolvable — hooks run globally and MUST NOT error in non-Karpathy projects.
- CLI commands MUST throw a `ConfigError` when the global config is missing or `vaultPath` cannot be determined.
- Per-project state directories (`.karpathy/state`, `.karpathy/locks`, `.karpathy/logs`) remain project-local and are resolved relative to the project root (cwd).

## 6. Memory model

### 6.1 Two-tier memory model

The system MUST implement a hot-cache and cold-storage split.

#### Hot cache

The hot cache is `CLAUDE.md` at the vault root or project root.

It MUST remain concise and MUST contain only currently useful context, including:

- active projects;
- key entities and aliases;
- current terminology;
- current constraints;
- operating rules;
- pointers to deep notes.

#### Cold storage

Cold storage lives under `wiki/`, `memory/`, or equivalent structured directories.

It MUST contain durable historical context, including:

- entity pages;
- project histories;
- session archives;
- source summaries;
- research notes;
- transcripts and artifacts.

### 6.2 Retrieval behavior

The runtime retrieval flow MUST be:

1. read `CLAUDE.md` first;
2. resolve against the hot cache where possible;
3. read only the minimum required deep notes or source pages;
4. update the hot cache and affected deep notes after the session.

## 7. Architectural lanes

The system MUST separate automated work into distinct lanes.

### 7.1 Deterministic maintenance lane

This lane handles operations that should be exact and reproducible.

Examples:

- backlink updates;
- index rebuilds;
- rename propagation;
- broken-link checks;
- metadata normalization;
- source-to-note mapping refresh.

### 7.2 Extraction and enrichment lane

This lane handles derived structured knowledge.

Examples:

- source summaries;
- entity extraction;
- concept extraction;
- decision extraction;
- action-item extraction;
- open-question extraction;
- session summaries.

Concept extraction MUST NOT materialize individual wiki pages per concept.
Instead, every concept mention consolidates into a single glossary file
(`{layout.wiki}/concepts/glossary.md`), one section per concept, each
section listing every source that mentioned it. Action-item extraction is
a distinct category from decision extraction (a decision is a choice
already committed to; an action item is a task still to be done) and is
tracked as per-project and vault-wide rollup checklists rather than pages.

Source content that is self-referential — i.e. describes the tool's own
development, detected by comparing the source's `project_slug` against the
tool's own project root — MUST be excluded from entity, concept, decision,
tool, organization, and action-item compilation (no pages, glossary entries,
or checklist items get created from it). Extraction itself still runs and
still populates the source summary's own `entities` protected region; only
the downstream curation step is skipped. The source MUST still be ingested
as a raw, searchable note.

### 7.3 Heuristic review lane

This lane handles uncertain or inferential work products.

Examples:

- contradiction candidates;
- duplicate-page candidates;
- missing-concept proposals;
- low-confidence claim flags;
- alias-collision proposals.

The system MUST NOT silently treat heuristic review outputs as deterministic truth.

## 8. Event and job model

### 8.1 Event sources

The system MAY receive events from:

- file watcher events;
- periodic timers;
- Claude Code hook events;
- post-ingest batch completion events.

### 8.2 Job queue

Events MUST be normalized into jobs before write activity occurs.

Each job MUST include:

- `job_id`;
- `job_type`;
- `origin`;
- `target_paths`;
- `created_at`;
- `dedupe_key`.

### 8.3 Idempotency and debouncing

The system MUST be safe to re-run.

Specifically:

- semantically equivalent repeated events MUST deduplicate;
- generated writes MUST NOT immediately retrigger equivalent jobs without a debounce window;
- deterministic jobs MUST be idempotent;
- failed jobs SHOULD be retryable;
- poisoned jobs SHOULD be quarantined for operator inspection.

### 8.4 Concurrency and locking

The system MUST prevent concurrent conflicting writes.

At minimum:

- only one writer MAY hold a write lock per target note at a time;
- jobs touching overlapping notes SHOULD serialize;
- partial writes MUST NOT leave malformed markdown or frontmatter.

### 8.5 Job cascade graph

Jobs cascade: a handler may enqueue downstream jobs on completion. The full graph:

```mermaid
graph TD
    %% Entry points
    hook_stop["hook:stop"] -->|if exportToRaw| ingest-raw-file
    hook_decay["cron:check-decay"] --> check-confidence-decay

    %% Deterministic ingest path
    ingest-raw-file -->|AI conversation + agent enabled| agent-ingest
    ingest-raw-file -->|else| classify-source
    classify-source --> summarize-source
    classify-source --> extract-entities-rich

    %% Extraction → compilation
    extract-entities -->|if autoCreateEntities| link-concepts
    extract-entities-rich -->|if autoCreateEntities| compile-entities
    compile-entities -->|if pages created/updated| cross-link-pages
    compile-entities --> rebuild-indexes

    %% Cross-linking → maintenance
    cross-link-pages --> update-backlinks
    cross-link-pages --> rebuild-indexes
    link-concepts --> update-backlinks
    link-concepts --> rebuild-index

    %% Phase 1 (cascading curation)
    link-concepts -->|per merged concept: markDirty| evaluate-refresh-candidates
    evaluate-refresh-candidates -->|threshold OR retrievability| topic-refresh
    topic-refresh -.->|cascadeDepth>=1: markDirty neighbors| neighbor_pending["neighbor.pending_evidence"]

    %% Decay/rot (B2b: region-aware refresh + thin-content backfill)
    decay-scan -->|stale OR thin, per REFRESH_TARGETS[type]| topic-refresh

    %% Concept glossary threshold synthesis (B2b)
    compile-entities -->|mention count crosses richness.glossarySynthesisThreshold| glossary-synthesize

    %% Agent path
    agent-ingest -->|if threshold reached| agent-synthesize-project
    agent-ingest --> update-backlinks
    agent-ingest --> rebuild-indexes
    agent-synthesize-project --> update-backlinks
    agent-synthesize-project --> rebuild-indexes

    %% Maintenance triggers
    check-confidence-decay -->|per stale project| agent-synthesize-project
    finalize-session --> rebuild-index

    %% Terminal jobs (no further cascades)
    style summarize-source fill:#e8f5e9
    style update-backlinks fill:#e8f5e9
    style rebuild-index fill:#e8f5e9
    style rebuild-indexes fill:#e8f5e9
    style glossary-synthesize fill:#e8f5e9
```

**Key properties:**

- Terminal jobs (green): `summarize-source`, `update-backlinks`, `rebuild-index`, `rebuild-indexes`, `detect-contradictions`, `detect-duplicates`, `detect-cross-project-patterns`, `generate-synthesis-skills`, `flush-hot-cache`, `lint-wiki`, `glossary-synthesize`.
- `decay-scan` resolves the region to refresh per note `type` via the `REFRESH_TARGETS` registry (`concept`/`topic` → `current-understanding`, `decision` → `outcome`, `project` hub → `overview`); `project_spec` has no entry and is never routed to `topic-refresh` (owned exclusively by `agent-synthesize-project`). Enqueue fires on retrievability decay OR thin/placeholder content — the latter gated on `intelligence.richness.enabled`.
- Deduplication: `update-backlinks` and `rebuild-indexes` use `dedupeKey` + optional 5s debounce to collapse rapid cascades.
- Two ingest paths diverge at `ingest-raw-file`: deterministic (classify → extract → compile → crosslink) vs agent (agent-ingest → synthesize).

### 8.6 Cascading curation budget (Phase 0)

The curation pipeline is **write-time cheap, refresh-time batched**:

- Ingest MUST NOT rewrite linked concept pages directly. Linkers call
  `markDirty()` to record evidence on each touched concept's frontmatter.
- A `BudgetTracker` (per-tier daily LLM-call ceiling, configured via
  `intelligence.budget`) gates expensive refresh jobs. Handlers that need
  an LLM call SHOULD `tryReserve(tier)` first; on refusal, the handler
  re-enqueues for the next budget window or falls back to a cheaper path.
- LLM model selection is tiered (`config.llm.models.fast | medium | heavy`).
  Extraction, the significance gate, and stance/TL;DR classifiers route to
  `fast`; topic-refresh and conflict triage route to `medium`; weekly
  digests and deep-research synthesis route to `heavy`.
- The embedding store is content-addressable: `upsert` and `replaceDoc` skip
  the provider call when `(provider_id, chunk_hash)` is already present.
  `getCacheStats()` exposes hit/miss counters for observability.

### 8.7 Cascading curation cascade (Phase 1)

The full cascade for an existing concept that gains new evidence:

1. **Linker** (`link-concepts`) merges new evidence into a matched concept
   page. For each merged page, it calls `markDirty(page, ref=summaryPath,
   reason='new-evidence')` and enqueues `evaluate-refresh-candidates` with
   `dedupeKey: refresh-eval:${page}`. Newly created entity pages are NOT
   mark-dirtied (their content is already fresh).
2. **Threshold gate** (`evaluate-refresh-candidates`, deterministic, no LLM)
   reads the page's frontmatter:
   - `pending_evidence_count >= refresh.threshold` → enqueue `topic-refresh`.
   - else if `considerRetrievability` AND `R = exp(-Δt/S) < retrievabilityRefresh`
     AND `pending_evidence_count > 0` → enqueue `topic-refresh`.
   - else → no-op (the queue accumulates until the next ingest re-fires the gate).
3. **Refresh** (`topic-refresh`, medium-tier LLM) reserves one budget call,
   pulls evidence via retrieval, rewrites the `current-understanding`
   protected region, clears `pending_evidence`, stamps `last_verified`, and
   bumps `stability` (or halves it on contradictions). On budget refusal the
   job exits without modifying the note; the pending queue is preserved so
   the next ingest re-triggers the gate.
4. **Cascade depth-1** (default): after the refresh writes the new region,
   it extracts outlinks from `current-understanding`, resolves each to a
   vault path via the entity index, and calls `markDirty` on those neighbors
   with `reason='cascade-from-refresh'`. It does NOT auto-enqueue refreshes
   for neighbors — the threshold gate decides whether evidence has
   accumulated enough on the next cycle. Cascade depth is bounded at 1 by
   config (`refresh.cascadeDepth`); higher depths are deliberately not
   supported (storm risk).

## 9. Functional requirements

### FR-1 Ingest raw source material

When a file lands in `raw/`, the system MUST:

1. detect it;
2. classify it by supported source type;
3. register provenance to the raw file path;
4. create or update a source summary artifact;
5. extract candidate entities, concepts, decisions, action items, and open questions (self-referential source content, per §7.2, is still ingested and still extracted, but its results are excluded from compilation — no pages/glossary/checklist entries get created from it);
6. update related deterministic graph structures where confidence permits;
7. append an audit log entry.

### FR-2 Capture Claude Code sessions

When Claude Code is used, the system MUST capture:

- the submitted prompt;
- compact summaries, if present;
- terminal or session outcomes, if available;
- major file changes;
- key decisions;
- action items;
- follow-up tasks;
- open questions.

The system MUST write a session note into the vault and MUST link it to affected projects, concepts, and evidence where possible.

### FR-3 Hook event support

The system MUST support:

- `UserPromptSubmit`;
- `PostCompact`;
- `SessionEnd`;
- `PostToolUse`.

`PostToolUse` support is REQUIRED in v1.

The implementation SHOULD suppress low-value repetitive logs, but it MUST preserve meaningful tool-use checkpoints affecting tracked knowledge.

### FR-4 Maintain deterministic structure automatically

The system MUST continuously maintain:

- backlinks;
- indexes;
- link integrity;
- rename propagation;
- alias tables;
- source-to-note mappings;
- change logs.

### FR-5 Preserve provenance

Every nontrivial curated claim in `wiki/` MUST include at least one provenance reference to:

- a raw file;
- a source summary;
- a transcript or session note;
- another curated page that itself carries provenance.

### FR-6 Support review and correction

The system MUST support a human review loop.

Human review MUST be required for:

- contradiction resolutions;
- merges of suspected duplicate canonical pages;
- alias merges that collapse canonical identities;
- destructive or lossy edits;
- edits to protected human-authored summary regions.

Human review SHOULD be optional for routine deterministic maintenance.

### FR-7 Background operation

The system MUST run without requiring routine manual kickoff.

The system MAY use:

- file watchers;
- timers;
- queue workers;
- Claude hooks;
- post-session tasks.

## 10. Data model

### 10.1 Base schema

Every managed note MUST support the following base frontmatter fields:

```yaml
---
id: string
type: string
title: string
status: draft | active | archived | rejected
confidence: low | medium | high
review_state: unreviewed | reviewed | approved | rejected
created_at: ISO-8601 timestamp
updated_at: ISO-8601 timestamp
last_maintained_at: ISO-8601 timestamp
source_refs: []
derived_from: []
aliases: []
links: []
change_origin: human | deterministic_maintenance | extraction | heuristic_review | hook_capture
protected_regions: []

# --- Phase 0: cascading curation (mark-dirty / lazy refresh) ---
pending_evidence: []          # [{ ref, reason?, at }] — unresolved evidence awaiting refresh
pending_evidence_count: 0     # cached length of `pending_evidence`; threshold-gated by evaluate-refresh-candidates
also_relevant_to: []          # absolute project paths that reference this concept (Phase 3 bridges)

# --- Sub-project C: draft/archival lifecycle (§25) ---
archived_at: undefined        # ISO timestamp the note transitioned to status: archived; cleared on un-archival
archived_reason: undefined    # free text reason (e.g. "stale-draft (34d at ingest_status: detected)", "rot-scan: ...", "superseded")
---
```

The `pending_evidence` queue is the keystone of the cascading-curation model
(Phase 0 of the curation plan). Ingest MUST NOT rewrite a concept page's body
in the same transaction as new-source linking; instead, the linker calls
`markDirty(notePath, ref, reason?)` which appends to `pending_evidence`. A
later `evaluate-refresh-candidates` job consumes the queue under a budget and
threshold gate. The queue is bounded (`MAX_PENDING_EVIDENCE = 50`) and
idempotent on `(notePath, ref)`.

### 10.2 Canonical identity rules

- Every canonical entity, concept, project, and decision page MUST have a stable `id`.
- Aliases MUST map to a canonical page id.
- A rename MUST preserve canonical identity.
- Duplicate pages MUST NOT be silently merged without review.
- For `entity_kind: person` specifically (B2c): resolution additionally supports an exact external-ID match (highest confidence, no review needed — see §10.3), and honorific/nickname/initials-aware fuzzy matching. A person-scoped name-variant detection tier (no shared-source-reference requirement, unlike every other duplicate-detection tier — see §22.2) closes the case where a bare name/handle in one document and a fuller name in an unrelated document refer to the same person; every candidate it produces is confidence-capped below the auto-merge threshold and always routed to human review (§22), never silently merged — consistent with the rule above.

### 10.3 Type-specific schemas

#### `source_summary`

Required fields:

- `source_type`
- `source_path`
- `ingest_status`
- `source_hash`

#### `session_summary`

Required fields:

- `source_type: claude_code`
- `session_id`
- `prompt_summary`
- `outcome_summary`
- `files_changed`

Note: `prompt_summary` and `outcome_summary` are populated by the session finalization path. When these fields are empty (e.g., session ended before finalization ran), tools MUST fall back to extracting content from the `%% begin:decisions %%` protected region within the note body. The `get_recent_sessions` MCP tool implements this fallback automatically.

#### `entity`

Required fields:

- `entity_kind`
- `canonical_name`

Optional fields (added by B2c, person name resolution):

- `external_ids: []` — stable external identifiers, `"provider:id"` form (e.g. `"slack:U01FZCB8X29"`), default `[]`. An exact match is `resolveEntity`'s highest-confidence tier (1.0) — definitionally the same identity, no fuzziness.
- `identity_uncertain: false` — `true` when `canonical_name` is a bare first name or raw handle rather than a full "First Last" name; cleared unconditionally on any merge or a `karpathy curator` rename decision. Purely a reportable signal (`wiki/_system/vault-health.md`'s bare-identity table) — never gates ingest or blocks page creation.

Note: `concept` is no longer a page-producing `entity_kind` (§7.2) — concept
mentions are consolidated into the glossary file instead of individual
`entity` pages.

#### `project`

Required fields:

- `project_key`
- `project_status`

`project_status: archived`/`completed` (rendered by `indexes.ts`'s `renderProjectsCategory` since before Sub-project C) is now actually producible: the archive queue's `archive` decision (§25.3) sets `project_status: archived` in the same write as the base `status` field, for any target note where `type === 'project'`. This is the field's first real producer of a non-`active` value (see §25).

#### `decision`

Required fields:

- `decision_status`
- `decision_date` — when absent or empty, MUST fall back to `created_at` for display and sorting purposes.

#### `contradiction`

Required fields:

- `conflict_type`
- `claim_a`
- `claim_b`
- `resolution_state`

## 11. State transitions

### 11.1 Ingest state

Source ingest SHOULD follow this state flow:

`detected -> classified -> summarized -> extracted -> linked -> logged`

Failed ingest MAY transition to `failed` and SHOULD preserve diagnostic information.

**Sub-project C, G0/G7:** the base `status` field (§10.1) is now wired to this flow for `source_summary` notes — every real call site that stamps `ingest_status: 'linked'` (`link-concepts.ts`, `compile-entities.ts` ×2 sites, `agent-ingest.ts`) also promotes `status: draft | archived -> active` in the same write, gated on `intelligence.lifecycle.enabled` (default `true`) and never overriding an explicit `status: rejected`. Before this, `status` was written once at note creation (`draft`) and never transitioned again for the lifetime of the note — see §25 for the full mechanism, including the deterministic, no-review auto-archival of drafts that never reach `linked` (G2).

### 11.2 Review state

Reviewable notes SHOULD follow:

`unreviewed -> reviewed -> approved`

Rejected review outputs SHOULD transition to `rejected` and MUST remain auditable.

**Sub-project C, G5:** `karpathy review approve`/`reject` (`src/review/review-queue.ts`) now also transition the base `status` field alongside `review_state` — `approve` sets `status: active`, `reject` sets `status: rejected` (this enum value's first real producer). Fixed in the same change: `approveReviewItem`/`rejectReviewItem` previously mutated frontmatter via regex (`/review_state: \w+/` etc.) against the raw file string, but `createReviewItem` (the sole real producer of `review/*.md` notes) serializes every scalar frontmatter value JSON-quoted (`status: "draft"`), which the unquoted-value regex could never match — `karpathy review approve`/`reject` had been silently no-op'ing on `review_state`/`resolution_state` against every real, production review item since the review workflow (Phase 5) shipped. Both functions now parse/mutate/serialize via `parseNote`/`serializeNote` (this project's standard frontmatter round-trip) instead of raw regex-replace, which sidesteps the quoting issue entirely and was the vehicle for adding the new `status` transition.

## 12. Overwrite and edit policy

### 12.1 Raw evidence

Automation MUST NOT overwrite files in `raw/`.

### 12.2 Deterministic fields

Automation MAY update deterministic fields such as backlinks, index references, alias tables, metadata, and machine-managed sections.

### 12.3 Protected human-authored content

Automation MUST NOT overwrite protected human-authored regions except through an explicit approved review action.

Protected regions are delimited by Obsidian `%%` comment markers:

```
%% begin:region-id %%
content here
%% end:region-id %%
```

A region may be pinned with `%% pinned %%` inside the region body to prevent automated modification. The parser also accepts the legacy `<!-- PROTECTED:id -->` / `<!-- /PROTECTED:id -->` format for backward compatibility; any write operation auto-migrates to the `%%` format.

### 12.4 Destructive changes

Destructive or lossy edits MUST require review and MUST be restorable from diff, snapshot, or backup.

## 13. Classification definitions

### 13.1 Duplicate candidates

A duplicate candidate is a pair or set of notes that appear to represent the same canonical subject.

Duplicate candidates MAY be proposed automatically but MUST NOT be auto-merged.

### 13.2 Contradictions

A contradiction candidate is a pair of incompatible claims associated with overlapping subject identity and time scope.

The system SHOULD distinguish at least:

- direct factual contradiction;
- stale claim superseded by newer evidence;
- alias collision;
- interpretation conflict.

### 13.3 Low-confidence claims

A low-confidence claim is a generated claim lacking sufficient provenance, support, or extraction certainty.

Low-confidence claims SHOULD be surfaced for review rather than silently promoted.

### 13.4 Safe removal

A reference MAY be removed automatically only if:

- the target no longer exists or has been canonically replaced;
- provenance is preserved elsewhere;
- removal does not discard unique human-authored meaning.

## 14. Safety and security requirements

The implementation MUST:

- avoid blind overwrites;
- avoid destructive edits without backup or diff;
- avoid path traversal;
- quote shell variables;
- prefer absolute paths;
- keep a changelog of automated writes;
- separate raw evidence from curated knowledge.

This specification intentionally keeps security scope lightweight for the current phase. Expanded trust-zone and quarantine behavior MAY be added later.

## 15. Performance requirements

The system MUST work locally on a personal machine.

The implementation SHOULD:

- maintain low idle CPU;
- process incrementally rather than fully reindexing on every small change;
- batch near-simultaneous arrivals when useful;
- throttle maintenance runs;
- deduplicate repeated triggers;
- keep interactive note generation fast enough to feel immediate.

## 16. Observability requirements

The system MUST maintain operator-visible logs for:

- ingest activity;
- job execution;
- retries and failures;
- automated writes;
- review-required proposals.

The system SHOULD expose summary metrics for:

- files ingested;
- jobs processed;
- average ingest latency;
- failed jobs;
- backlog depth;
- review queue size.

### 16.1 MCP tool usage audit log

The MCP server MUST write one JSONL entry to `.karpathy/logs/mcp-usage.jsonl` for every tool call, regardless of success or failure.

Each entry MUST include:

- `ts` — ISO-8601 timestamp;
- `tool` — tool name as called;
- `args` — sanitized call arguments (content fields > 200 chars replaced with `[N chars]`);
- `duration_ms` — wall-clock execution time;
- `success` — boolean reflecting whether the call succeeded or returned `isError`;
- `result_chars` — total character length of the response;
- `result_count` — length of the returned JSON array if the result is an array (omitted otherwise);
- `error` — error message string when `success` is false.

The log MUST NOT throw or affect tool execution on write failure.

**The operator SHOULD review this log regularly** — at minimum after the first week of use and after any workflow change. The log is the primary signal for improving tool quality over time:

```bash
# Most-called tools
cat .karpathy/logs/mcp-usage.jsonl | jq -r '.tool' | sort | uniq -c | sort -rn

# All failures
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.success == false)'

# Slowest calls
cat .karpathy/logs/mcp-usage.jsonl | jq -s 'sort_by(.duration_ms) | reverse | .[0:10] | .[] | {tool, duration_ms, result_count}'

# search_vault queries (what was searched)
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.tool == "search_vault") | .args.query'

# Calls returning zero results
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.result_count == 0)'
```

These queries answer: which tools are being reached for, which return empty results, and whether tool descriptions are precise enough to route correctly.

## 17. Acceptance criteria

The build is complete only when the following criteria are met on a reference local machine and sample vault.

### AC-1 Raw ingest

A supported file dropped into `raw/` MUST produce or update a source summary and provenance entry within a defined target latency.

### AC-2 Session capture

A Claude Code session containing prompt submission, at least one meaningful tool interaction, optional compact summary, and session end MUST produce a session summary note containing the captured elements.

### AC-3 Deterministic maintenance

Backlinks, index pages, and rename propagation MUST remain internally consistent after repeated maintenance runs.

### AC-4 Review surfacing

Contradiction candidates, duplicate candidates, and low-confidence claims MUST be surfaced into a reviewable form and MUST remain auditable.

### AC-5 Long-running operation

The system MUST be able to run continuously for an extended period without requiring routine manual maintenance to preserve coherence of the vault.

### AC-6 Human usability

A user MUST be able to open Obsidian after normal work and see:

- a session summary;
- updated related pages where permitted;
- preserved provenance;
- an increasingly coherent knowledge structure.

## 18. Implementation phases

### Phase 1: Vault skeleton

Create the folder structure, templates, schemas, and operator-visible configuration.

### Phase 2: Job system and deterministic maintenance

Implement the event normalization layer, queue, locking, backlinks, index rebuilds, rename propagation, and machine-managed sections.

### Phase 3: Session capture

Implement Claude Code hook scripts for `UserPromptSubmit`, `PostToolUse`, `PostCompact`, and `SessionEnd`.

### Phase 4: Ingest pipeline

Implement raw-source detection, classification, source summaries, structured extraction, and provenance registration.

### Phase 5: Review workflow

Implement contradiction candidates, duplicate candidates, low-confidence flags, approval paths, and audit visibility.

### Phase 6: Optional MCP bridge

Expose the vault to AI tools through MCP only after the local workflow is stable.

MCP SHOULD begin with read-oriented operations. Expanded mutation behavior MAY be added later under explicit control.

### Phase 7: Hybrid search

Replace the siloed `search_vault` (keyword) and `get_related` (semantic) tools with a single unified `search` tool backed by an FTS5 keyword index over the entire vault and an Ollama-powered semantic pool, fused via Reciprocal Rank Fusion. See §24.

### Phase 8: Draft/archival lifecycle

Make the base `status` field (§10.1) genuinely live: auto-promote `source_summary` notes out of `draft` the moment the pipeline actually processes them, auto-archive drafts that never do, give rot-scan's already-computed rot candidates a human-reviewed archive queue, and wire `NoteStatus`'s `rejected` value and `project_status`'s `archived`/`completed` buckets to their first real producers. See §25.

## 19. MCP scope

The MCP server exposes 20+ tools organized by function. Server instructions are derived at startup from the actual runtime vault layout so paths shown to the LLM match what is on disk.

### Search decision table

The server instructions MUST include a routing table telling the LLM which search tool to use for each goal:

| Goal | Tool |
|------|------|
| Orient at session start | `get_hot_cache` |
| Find notes by keyword OR concept | `search` |
| Find notes similar to one I have | `search` (with `path`) |
| Find a specific person/tool/project | `get_entity` or `search_entities` |
| Surface past decisions | `get_decisions` |
| Recent session context | `get_recent_sessions` |

`search_vault` and `get_related` are deprecated; their definitions remain registered with `Deprecated — use search instead.` descriptions for one major version. New callers MUST use `search`. See §24 for the hybrid retrieval design.

### Read tools (13)
- `get_hot_cache` — active context from the hotcache (CLAUDE.md or Curated/hotcache.md per layout); MUST be called first at session start;
- `search` — **unified hybrid search**. FTS5 BM25 keyword pool over every markdown file in the vault, fused with the configured embedding provider's semantic pool (Ollama by default — fully local) via Reciprocal Rank Fusion + recency weighting. Accepts a free-text `query` OR a vault note `path` (anchor — uses the note's `title + tldr + body[:800]`). Degrades to keyword-only mode when the embedding provider is unreachable; never errors on provider unavailability;
- `search_vault` — *Deprecated — use `search` instead. Will be removed in the next major version.*
- `get_note` — read by exact path or title, with detail levels (metadata / summary / full);
- `get_recent_sessions` — session summaries sorted by date; when frontmatter `prompt_summary`/`outcome_summary` are unpopulated, automatically extracts from the `decisions` protected region;
- `get_entity` — direct lookup by name or path, with detail levels;
- `search_entities` — keyword search across entity notes ranked by relevance (title exact > title contains > term hits > body frequency); excludes `_index.md` files;
- `get_decisions` — decisions sorted by date; falls back to `created_at` when `decision_date` is unset; excludes `_index.md`;
- `get_review_queue` — items pending human review;
- `get_backlinks` — all notes linking to a target via wikilinks;
- `search_by_tags` — search notes by aliases, links, or tags (AND/OR);
- `get_related` — *Deprecated — use `search` with a `path` parameter instead. Will be removed in the next major version.*
- `batch_get_notes` — read multiple known notes in one round-trip, with detail levels.

### Write tools (4)
- `log_session_summary` — capture session summary, update hot cache;
- `log_insight` — create entity, concept, decision, project, or general note;
- `update_note` — merge frontmatter, replace or append body content (protected regions always preserved);
- `ingest_content` — ingest raw content through the pipeline.

### Maintenance tools (3)
- `run_maintenance` — update backlinks and rebuild indexes;
- `lint_vault` — health checks: orphan notes, broken links, stale notes, missing frontmatter, empty notes, duplicate titles;
- `approve_research` — approve pending research candidates from the research queue with depth selection.

### Utility tool (1)
- `vault_status` — aggregate counts by type, status, recent activity, review queue size.

All tools support detail levels (`metadata` / `summary` / `full`) where applicable, enabling token-efficient retrieval.

MCP MUST NOT become the primary source of truth.

### 19.1 Tool quality and the refinement loop

MCP tool quality degrades silently unless actively monitored. The operator MUST treat tool descriptions as living documentation:

1. **Review the usage log** after the first week of use and after any change in workflow (see §16.1 for queries).
2. **Identify zero-result searches** — queries that should have found something but returned nothing. These indicate stemming gaps, missing content, or tool routing failures.
3. **Identify routing failures** — where the LLM called the wrong tool. These indicate unclear `definition.description` text.
4. **Fix and rebuild** — update `definition.description` in the relevant tool file and `src/mcp/instructions.ts`, then `pnpm build`. The server picks up the new descriptions on next restart.

Tool descriptions MUST state: what search algorithm is used, what ranking means, what prerequisites exist (e.g. AWS credentials), and when to prefer this tool over alternatives. Vague descriptions ("search entities by kind or keyword") MUST be replaced with precise ones that help the LLM route correctly.

## 20. Required deliverables

The implementation deliverables MUST include:

- a working local Obsidian vault template;
- a session-capture hook script set;
- a maintenance worker;
- an ingest compiler;
- a review and repair pass for contradictions, duplicates, and link integrity;
- a clean README;
- a sample vault with example notes;
- Claude Code hook configuration;
- an operator guide.

## 21a. Intelligence layer (optional, additive)

An optional, opt-in intelligence layer is specified in [intelligence-plan.md](intelligence-plan.md) and implemented under `src/intelligence/` and `src/embeddings/`. It does NOT alter any of the goals, non-goals, or normative requirements above; it is purely additive and disabled by default for installs that prefer the deterministic substrate.

When enabled, the layer adds:

- **Time-aware frontmatter** (`last_verified`, `stability`, `half_life_domain`, `superseded_by`, `contradicts`, `tldr`, `hot_score`) — backfilled idempotently on first run;
- **Embedding store** at `.karpathy/state/embeddings.sqlite` with a pluggable provider (deterministic offline / Bedrock Titan production);
- **Two-stage retrieval with recency boost** powering the MCP `get_related` tool;
- **Weekly hot-topics digest** at `wiki/digests/{YYYY-Www}.md`;
- **Topic refresh** that integrates new evidence into a note's primary richness region without overwriting contradictions — region-aware per note `type` (`concept`/`topic` → `current-understanding`, `decision` → `outcome`/`context`, `project` hub → `overview`), each with its own anti-fabrication prompt (an honest placeholder rather than a fabricated answer when evidence doesn't support one). Also renders resolved cascade-neighbors into `related-concepts` for `concept`/`topic` notes as a byproduct of the same pass;
- **Decay scan** that enqueues refreshes for stale concept / topic / decision / project notes, and — independent of staleness, when the intelligence layer's optional richness backfill is enabled — force-enqueues a refresh for any note whose primary richness region is still empty or a known placeholder;
- **Vault-rot diagnostic** at `wiki/_system/vault-health.md`, including a thin-content table and a bare-identity person-pages table (both reporting-only) alongside the existing rot candidates;
- **Human-in-the-loop research handshake**: gap detection writes a stack-ranked queue at `wiki/_system/research-queue.md`; the user picks depth (light / medium / heavy / skip) via Slack reply, queue edit, or the MCP `approve_research` tool; only then does `research-execute` fire;
- **Significance gate** that drops generic / too-short entity names before they spawn noisy pages;
- **Concept glossary synthesis** — mention de-duplication is content-aware (not just source-reference-aware), and a concept that accumulates enough mentions gets a short LLM-synthesized rollup line above its raw mention list, replacing the placeholder-quality "first gloss frozen forever" state.

All artefacts produced by the layer respect the protected-region overwrite policy in section 12. The research handshake explicitly forbids autonomous web research without user approval.

## 21. Done definition

The system is done when a user can:

1. work in Claude Code normally;
2. generate useful session artifacts automatically;
3. open Obsidian and see the work summarized and linked;
4. trust that provenance and history have been preserved;
5. benefit from a knowledge base that improves without routine manual upkeep.

## 22. Curator reconciliation workflow

The system exposes an interactive reconciliation workflow for operators who want to improve entity quality: consolidate duplicates, fix name spelling, and resolve alias collisions without examining every file manually.

### 22.1 Reconciliation queue

The reconciliation queue persists at `{layout.system}/reconciliation-queue.md` inside a protected region. Each entry carries:

- `id` — nanoid stable identifier
- `status` — `pending` | `resolved` | `skipped`
- `sourcePath` / `targetPath` — candidate pair paths
- `sourceName` / `targetName` — display names
- `reason` — why the pair was flagged
- `confidence` — 0..1 score
- `decision` — `merge` | `rename` | `skip` | `manual` (set on resolution)
- `resolvedAt` — ISO timestamp (set on resolution)

The reconciliation queue file MUST be written at session start by `detect-entity-dupes` and is human-readable in Obsidian.

### 22.2 Detection

The `detect-entity-dupes` job:

1. Calls `detectMergeCandidates()` from `src/compilation/entity-merger.ts`.
2. Appends new candidates not already present in the queue — deduplication is on `sourcePath+targetPath` pair, order-normalized.
3. Does NOT remove or modify existing entries; their `status` is set only by operator decisions.

Running `detect-entity-dupes` twice MUST NOT create duplicate queue entries for the same pair.

`detectMergeCandidates()`'s first three tiers (Levenshtein-distance names, substring names, alias match) all require overlapping `source_refs` between the candidate pair, to hold down false positives. **B2c adds a 4th tier, person-to-person pairs only, with no shared-source-reference requirement**: `personNameVariantScore()` (`src/compilation/person-name-variants.ts`) scores substring-containment and surname+nickname/initials-equivalent pairs, always below the auto-merge threshold. This is the mechanism that catches a bare name/handle in one document and a fuller name in a completely unrelated document — the class of duplicate every other tier structurally cannot see, because none of them relax the source-overlap requirement. In addition to the periodic `detect-entity-dupes` sweep, the same scoring function runs **immediately** when a new person page is created (both the rich `compileFromSource` path and the simple `link-concepts` path), gated on `enrichment.personResolution.enabled` and best-effort (a failure never blocks or undoes page creation) — so a same-day mention gets a same-day queue entry rather than waiting on the periodic sweep, which itself only runs when `maintenance.reviewEnabled: true`.

### 22.3 Resolution paths

Three resolution paths exist:

**CLI (`karpathy curator`)** — interactive walk-through. For each `pending` entry, prints both entity names, the reason, and the confidence score, then prompts:

```
[m]erge  [r]ename  [s]kip  [M]anual  [q]uit
```

- `merge` — calls `mergeEntities(sourcePath, targetPath, vault)` then rebuilds backlinks and indexes. Marks entry `resolved` with `decision: merge`.
- `rename` — prompts for the new canonical name, calls `mergeEntities` with the renamed target, marks `resolved` with `decision: rename`.
- `skip` — marks entry `skipped`. Skipped entries are not shown again in future curator runs.
- `manual` — marks `resolved` with `decision: manual`; the operator handles it directly.
- `quit` — exits the interactive loop; unresolved entries remain `pending`.

**MCP (`reconcile_entities`)** — non-interactive, for in-session resolution. Without arguments, returns up to 10 pending queue entries. With `{ id, decision, newName? }`, applies the decision and returns the updated entry. Merge decisions execute `mergeEntities` and trigger backlink+index rebuilds.

**CLI (`karpathy merge`)** — existing direct merge command. Unchanged. Does not interact with the reconciliation queue.

### 22.4 Constraints

- `detect-entity-dupes` MUST be idempotent: running twice MUST NOT create duplicate entries.
- All merge decisions MUST use `mergeEntities()` — no alternative merge path is permitted.
- The reconciliation queue MUST NOT auto-apply merges without operator decision (the existing `karpathy merge --auto` is a separate explicit opt-in outside this workflow).
- After any merge triggered via `curator` or `reconcile_entities`, backlinks and indexes MUST be rebuilt.
- The `reconcile_entities` MCP tool MUST refuse to apply a `merge` decision if either path no longer exists (was already merged or deleted).

## 23. Manual content drop and re-enrichment

### 23.1 Clippings drop zone

`layout.clippings` (default: `clippings/`) is a designated drop zone for human-authored notes, research clippings, meeting notes, and any ad-hoc content the operator wants absorbed into the knowledge graph. Files added to this folder MUST be processed through the standard ingest pipeline:

`classify-source → summarize-source → extract-entities-rich → link-concepts → update-backlinks`

When `ingest.watchClippings` is `true` (default: `false`), the file watcher MUST include `{vaultPath}/{layout.clippings}` in its watch paths. New files trigger an `ingest-raw-file` job with the file path as payload.

Files ingested via clippings MUST follow the same provenance rules as `raw/` sources: a source summary is written, provenance is preserved, and all content outside protected regions is treated as evidence.

### 23.2 Re-enrichment of existing wiki notes

When an operator manually adds content outside protected regions to an existing wiki note, the system MUST provide a mechanism to re-trigger entity extraction and concept-linking without a full ingest.

**`re-enrich-note` job** — given a `targetPath` (a vault note path):

1. Reads the note's full body.
2. Strips all machine-owned protected region content (any `%% begin:id %%` block listed in the note's `protected_regions` frontmatter field) to isolate the human-authored text.
3. If the stripped text has fewer than 50 characters, completes as a no-op (no enrichment).
4. Otherwise: runs `extractEntitiesRich()` on the stripped text.
5. For each non-noise extracted entity, enqueues `link-concepts` (deduped by entity path).
6. Enqueues `update-backlinks` for `targetPath` (deduped).
7. Updates `last_verified` to the current ISO timestamp and `updated_at` in frontmatter.

The job MUST NOT overwrite any protected regions during re-enrichment. Only the downstream `update-backlinks` job MAY update the `backlinks` protected region.

**CLI (`karpathy touch <note-path>`)** — resolves `note-path` relative to the vault root, enqueues a `re-enrich-note` job, and drains the queue. Prints a summary of jobs processed.

**MCP (`re_enrich_note`)** — accepts `{ notePath }` (vault-relative path). Enqueues `re-enrich-note` and drains the queue. Returns a summary of what changed.

### 23.3 Constraints

- Re-enrichment MUST NOT delete or overwrite human-authored content outside protected regions.
- `last_verified` MUST be updated to the current ISO timestamp after successful re-enrichment (even for no-op enrichment — the note was "verified" as of that moment).
- If entity extraction produces no results, the job completes successfully — no-op enrichment is valid.
- Re-enrichment of a note that does not exist in the vault MUST fail with a clear error, not silently succeed.

## 24. Hybrid search

The full design lives in [`docs/superpowers/specs/2026-06-17-hybrid-search-design.md`](../docs/superpowers/specs/2026-06-17-hybrid-search-design.md). This section captures the normative requirements that flow from that design.

### 24.1 Goals

A single unified `search` MCP tool MUST combine an FTS5 BM25 keyword pool over the entire vault with the configured embedding provider's semantic pool, fused via Reciprocal Rank Fusion + recency weighting. The tool MUST:

- accept either a free-text `query` or a vault note `path` (anchor — uses the note's `title + tldr + body[:800]`);
- cover **every** markdown file in the vault for the keyword pool, regardless of whether the embedding pipeline has touched it;
- degrade to keyword-only mode (`searchMode: 'keyword-only'`) with a `degradation_note` when the embedding provider is unavailable — never raise an error on provider unavailability;
- exclude the anchor doc itself from results when invoked with `path`;
- support `scope` (`vault` | `this-week` | `project`), `note_type`, and `limit` filters;
- emit per-hit scores: `{ rrf, recency, final, keyword_rank?, semantic_sim? }`.

### 24.2 Storage

The keyword index lives in `notes_fts` (FTS5 virtual table) inside the existing `.karpathy/state/embeddings.sqlite`. A companion `fts_meta` table (`doc_id PRIMARY KEY, file_mtime INTEGER, indexed_at TEXT`) drives mtime-based incremental sync. No new database file.

### 24.3 Sync layers

The keyword index MUST be kept current via four cooperating layers:

1. **Scheduled (`sync-fts-index` job, 5-minute cadence, priority 100)** — primary path. Walks every configured wiki + outputs folder, diffs `{path, mtime}` against `fts_meta`, incrementally upserts changed/new files and removes vanished ones. Cheap (~56ms stat walk + ~8ms per changed file at 22k-file scale per the design doc); requires the intel tick cron to fire at least every 5 minutes.
2. **Stop hook** — enqueues `sync-fts-index` with `dedupeKey: 'sync-fts-index'` so any session-created content is indexed before the next session begins.
3. **Ingest pipeline** — `HybridStore.upsertDoc(docId, title, body, chunks)` updates both `notes_fts` and the embedding store atomically per doc. Real-time during enrichment.
4. **File watcher** — chokidar `change` and `unlink` events enqueue single-file `sync-fts-index` jobs. The watcher MUST handle all three of `add`, `change`, and `unlink`.

Embedding coverage remains ingest-pipeline-only (per the design doc — embedding all 22k files is wasteful at ~18 minutes per run). FTS coverage is total from day 1.

### 24.4 Embedding providers

`config.embeddings.provider` accepts `deterministic`, `bedrock-titan`, or `ollama`. Ollama is the default-recommended provider behind hybrid search:

- always-on local daemon (typical macOS launchd-managed); no credential expiry
- default model `nomic-embed-text` (768-dim, L2-normalized at the provider)
- `config.embeddings.baseUrl` (default `http://localhost:11434`) and `config.embeddings.timeoutMs` (default `5000`)
- `isOllamaAvailable(baseUrl, timeoutMs)` MUST be a non-throwing probe used by `HybridStore.search` before calling the embedding pool

### 24.5 Maintenance commands

The CLI MUST expose `karpathy maintenance` with three flags:

- `--populate-fts` — one-shot: walks every configured folder and seeds `notes_fts` + `fts_meta`. Idempotent on `(doc_id, mtime)`.
- `--re-embed` — enqueues `embedding-index` over `layout.wiki` to refresh embeddings under the currently-configured provider.
- `--prune-provider <id>` — deletes every embedding row owned by `<id>` (used after switching providers, e.g. `titan-v2-1024` → `ollama-nomic-embed-text-768`).

### 24.6 Migration sequence

After implementation, an operator switching to Ollama:

1. `brew install ollama && ollama pull nomic-embed-text` — daemon auto-starts via launchd.
2. Update `~/.karpathy/config.json` to set `embeddings.provider: "ollama"`.
3. `karpathy maintenance --populate-fts` — one-time FTS seeding (~4 minutes for ~22k files).
4. `karpathy maintenance --re-embed` — re-embed existing notes under the new provider id.
5. `karpathy maintenance --prune-provider titan-v2-1024` — drop stale Bedrock rows.
6. Configure intel tick cron at 5-minute cadence (see §24.3).

## 25. Draft/archival lifecycle (Sub-project C)

A real-vault audit found the base `status` field (§10.1) was write-once: every `source_summary` note (11,499 of 11,876 real files, 96.8%) was permanently `status: draft` because no code path anywhere transitioned it after note creation; `NoteStatus`'s `rejected` value and `project_status`'s `archived`/`completed` buckets had zero producers despite being fully rendered by existing UI/index code; and `superseded_by` had 215 real occurrences, all empty. This section makes `status` genuinely live without any physical file moves, deletions, or new LLM calls — every mechanism below is deterministic-lane (§7.1).

### 25.1 Draft → active promotion (G0)

The three (four, counting `agent-ingest.ts`'s completion path) real call sites that stamp `data.ingest_status = 'linked'` (`link-concepts.ts`, `compile-entities.ts` ×2 sites, `agent-ingest.ts`) also promote `status: draft | archived -> active` in the same write — reaching `'linked'` is proof the pipeline extracted real value from the source (or correctly decided there was nothing further to compile, for a self-referential source). The promotion:

- Is gated on `intelligence.lifecycle.enabled` (default `true`).
- MUST NOT override an explicit `status: rejected` — a human rejection is a stronger signal than pipeline progress.
- Clears `archived_at`/`archived_reason` when recovering from `archived` (this is also G7's un-archival path for `source_summary` notes — see §25.4).

### 25.2 Stale-draft visibility and auto-archival (G1, G2)

`rot-scan.ts` (§8.5) gains an independent scan pass over `layout.sources` — deliberately **not** folded into the existing stale+orphan+low-confidence rot rule, which is tuned for wiki content and would flag nearly every source note under a rule not built for this shape of content. The pass reports every `source_summary` still `status: draft` past `intelligence.lifecycle.staleDraftReportDays` (default 14) in a "Stale draft sources" table in `vault-health.md` — reporting-only, runs unconditionally (like the pre-existing thin-content/bare-identity passes), no note mutation.

A separate, scheduled `archive-stale-drafts` job (daily, priority 90) auto-archives (`status: draft -> archived`, plus `archived_at`/`archived_reason`) any `source_summary` still `draft` past `intelligence.lifecycle.staleDraftArchiveDays` (default 30). This is deterministic and has no human review — per §12.2, `status` here is a deterministic field: nothing is deleted, `raw/` and the note body are untouched, and the transition is fully reversible (manual edit, or automatically the moment the source is actually processed — §25.1's guard already flips a previously-archived note back to `active`).

**`intelligence.lifecycle.staleDraftArchiveEnabled` defaults to `false`** and is a second, independent gate on top of `intelligence.lifecycle.enabled` — both MUST be `true` for the job to archive anything. This is a deliberate safety decision, not an oversight: with a real vault's worth of already-stale drafts past the default 30-day threshold, defaulting this on would silently archive the large majority of `Curated/sources/` the moment the daily job first runs after deploy. G0/G1/G3-G5 and the reporting table are fully enabled by default and work identically regardless of this flag; only G2's actual auto-archival stays off until an operator explicitly opts in.

### 25.3 Archive queue (G3, G4)

Mirrors the curator reconciliation queue (§22) exactly in shape — a detector produces candidates, a human resolves them at their own pace, resolutions persist and are never re-proposed — as a separate mechanism (single-note candidates, not pairs; `archive`/`keep`/`supersede`/`skip` decisions, not `merge`/`rename`).

The queue persists at `{layout.system}/archive-queue.md` inside a protected region. Each entry carries `id`, `status` (`pending`/`resolved`/`skipped`), `path`, `title`, `reason`, `ageDays`, `confidence`, `retrievability?`, `decision?`, `supersededByPath?`, `resolvedAt?`.

**Detection:** `rot-scan`'s already-computed, already-displayed `candidates` list (the unchanged stale+orphan+low-confidence rule) is fed into the queue via `refreshArchiveQueue()`, deduplicated by `path` — an existing entry in ANY status (including `resolved`/`skipped`) blocks re-addition, so a `keep`/`skip` decision permanently silences that candidate against future weekly rescans. Gated on `intelligence.lifecycle.archiveQueueEnabled` (default `true`), independent of `maintenance.reviewEnabled` — `rot-scan` runs unconditionally weekly regardless of that flag.

**Resolution paths** (both apply decisions through one shared `applyArchiveDecision()` helper, so the mutation logic lives in exactly one place):

- **CLI (`karpathy archivist`)** — interactive walk-through, one entry at a time: `[a]rchive [k]eep [S]upersede [s]kip [q]uit`.
- **MCP (`resolve_archive_candidate`)** — no arguments returns up to 10 pending entries; `{ id, decision, supersededByPath? }` applies one decision to one entry.

Per-decision effect on the target note:

| Decision | Target note changes | Queue entry |
|---|---|---|
| `archive` | `status: archived`, `archived_at`, `archived_reason`; `project_status: archived` too if `type === 'project'` (§10.3) | `resolved` |
| `keep` | none | `resolved` |
| `supersede` | `status: archived`, `archived_at`, `archived_reason: 'superseded'`, `superseded_by` gains the replacement path (deduped) — this field's first real writer anywhere in the codebase | `resolved`, `supersededByPath` set |
| `skip` | none | `skipped` |

Both `karpathy archivist` and `resolve_archive_candidate` operate on exactly one queue entry per invocation — there is no batch-apply path, by construction (matching §22.4's equivalent constraint for the reconciliation queue).

Decay-scan's prior dead `archive_candidate` frontmatter write (no consumer, no clear-on-recovery branch, no test coverage) is removed (G6); rot-scan's archive-queue feed above is its replacement.

### 25.4 Un-archival on re-engagement (G7)

Archival is never a one-way trap. Beyond §25.1's `source_summary` recovery, a note archived via the queue (§25.3) automatically flips back to `status: active` (clearing `archived_at`/`archived_reason`) the instant it's genuinely re-engaged with:

- `refreshTopic()` (`src/intelligence/topic-refresh.ts`), after a successful protected-region rewrite — not on either of its no-op branches (unsupported type; zero retrieval hits).
- `re-enrich-note` job, after a successful (non-no-op) re-enrichment pass — the existing "fewer than 50 characters of human-authored content" no-op gate (§23.2) still short-circuits before this check.

Manual `status: archived -> active` frontmatter edits remain available at all times regardless of this mechanism.

### 25.5 Constraints

- Auto-archival of `source_summary` drafts (§25.2) MUST NOT run unless both `intelligence.lifecycle.enabled` and `intelligence.lifecycle.staleDraftArchiveEnabled` are `true` — no code path in this mechanism sets `staleDraftArchiveEnabled` to `true` or bypasses reading it from config.
- Wiki content (entity/concept/project/decision/topic pages) MUST NOT be auto-archived without human review — always queue-and-decide (§25.3), matching FR-6's spirit and §22's precedent.
- No note is ever deleted. Archival is a status flip plus two optional metadata fields — never a body change, never a file move.
- `karpathy reprocess-agent` and any future call site that stamps `ingest_status: 'linked'` for a `source_summary` MUST apply the same §25.1 promotion guard.

## 26. Research queue redesign (Sub-project D)

A real-vault audit of the §21a research handshake found the mechanism sound in principle but broken in practice: two of its three documented approval surfaces (the `approve_research` MCP tool; `karpathy intel queue`/`approve`/`status`) silently operated on the legacy default `wiki/_system/research-queue.md` path regardless of the vault's actual configured `layout.system`, so every real approval attempt against a `Curated/`-layout production vault (30 real, live candidates) always reported or mutated an empty queue; `research-execute` had never once run in 2.5 months of continuous daily `research-propose` cycles; roughly two-thirds of the real queue's candidates were structurally orphaned by Sub-project B1's own concept-glossary consolidation, and would have silently resurrected deprecated individual-concept-page architecture if ever executed; and `research-execute`'s LLM calls were unbudgeted and non-tier-aware, unlike every sibling mechanism in the intelligence layer. This section fixes all of the above without weakening the human-in-the-loop gate itself — no change here ever causes `research-execute` to fire without a prior, explicit `decision` recorded by a human through one of the three approval surfaces.

### 26.1 Layout-path fix (G0)

`src/mcp/tools/approve-research.ts`, `src/bin/intel-command.ts` (`queue`/`approve`/`status` subcommands), and `src/intelligence/health-check.ts`'s `checkResearchQueue` now thread `layoutFromConfig(config)` (or `config.layout`, matching each file's existing local convention) through every `readResearchQueue`/`writeResearchQueue` call, matching the established pattern already used by `reconcile-entities.ts` and §25.3's `resolve-archive-candidate.ts`. This is the same bug class §25's sibling sub-projects (B2c) already fixed once elsewhere in this codebase (`mergeEntities`/`rebuildAllIndexes` call sites) — the research-queue module was a second, independent, previously-uncaught occurrence. Ships unconditionally: a correctness fix, not a new mutation. `karpathy intel health --json`'s research-queue counters — documented as "the canonical input for external control centers" — are accurate for the first time as a result.

### 26.2 Auto-drain (G1)

Folded into the existing daily `research-propose` job rather than a new scheduled job type: once a queue candidate has a `decision` set (by any of the three now-working G0 surfaces) and is still `status: pending`, `proposeResearch` auto-enqueues a `research-execute` job for it, reusing the exact `dedupeKey: research-execute:{slug}` shape the manual `karpathy intel research <slug> <depth>` CLI already uses so the job queue's existing dedup guarantees no duplicate stacking.

**`intelligence.research.autoDrainEnabled` defaults to `false`** — a deliberate safety decision, not an oversight, resolved the same way §25.2's `staleDraftArchiveEnabled` was: `research-execute` makes real, budget-gated-but-still-real-cost LLM calls and, depending on `intelligence.research.search.provider` (defaults `noop`, a second independent gate), can spawn an external websearch MCP subprocess (`@mzxrai/mcp-webresearch@latest` in the real config) never exercised against real traffic. Turning on automatic enqueueing the moment a decision is recorded would mean the very first real execution of this path could fire without a human directly watching it happen. G0/G2/G3/G4/G5 ship fully enabled by default; G1 ships fully built and tested, gated off, so an operator can run one or two candidates by hand first via the now-working approval surfaces and flip the flag once satisfied with a real result. No code path anywhere in this mechanism sets `autoDrainEnabled` to `true` or bypasses reading it from config.

On budget refusal (§26.3), the drained job returns without touching the queue row, so it stays `pending`+decided and is retried by the next day's drain pass — no separate retry bookkeeping needed.

### 26.3 Budget gate + tier-aware execution (G2)

`src/jobs/handlers/research-execute.ts` reserves one call from the existing `BudgetTracker` (tier mapped from research depth: `light → fast`, `medium → medium`, `heavy → heavy`) before invoking `executeResearch`, matching `topic-refresh.ts`'s established budget pattern; and constructs a depth-appropriate LLM client via `createLLMFromConfig(config, stateDir, tier)` per job instead of always using the single default-tier client, matching the tier-selection pattern Sub-project B2a's `generate-review-analysis.ts` established in this same codebase. Ships enabled unconditionally — strictly protective (budget) and strictly cost/quality-improving (tier selection); necessary companion to G1, since auto-drain is what could first cause several `research-execute` jobs to fire in one day without a human individually typing each one. Budget reservation happens once per job (not once per internal round) — `executeResearch`'s 1-3 round loop is treated as a single logical research call for budget-accounting purposes.

### 26.4 Orphan purge + write guard (G3)

`research-propose.ts`'s `scanFolders()` no longer scans `${layout.wiki}/concepts` — permanently a no-op since Sub-project B1's concept-glossary consolidation (zero `type: concept` files remain there; concepts get their own LLM-synthesis enrichment via the glossary rollup-line mechanism instead). Every carried-forward (not-freshly-redetected) candidate is now validated each cycle against whether its backing page still exists at `${layout.wiki}/concepts/{slug}.md` or `${layout.wiki}/topics/{slug}.md`, and dropped immediately (regardless of score/age) if neither does — completed candidates are exempt from this check, since a completed research result may legitimately reference a page later archived by §25's lifecycle mechanism, a different, valid lifecycle state rather than an orphan.

`research-execute.ts`'s `writeConceptNote()` gains a defense-in-depth guard: it refuses (throws, rather than silently no-oping) to create a brand-new individual concept page when the resolved write target is the glossary-consolidated `concepts/` folder (i.e., the target doesn't exist yet and `concepts/glossary.md` does) — a stale decision surfacing via the job queue's own retry/quarantine machinery instead of silently forking a duplicate, disconnected representation of an already-consolidated concept. The write-target resolution itself prefers whichever folder (`concepts/` or `topics/`) actually already backs the candidate's slug, so an in-place update to an existing page (of either kind) is never redirected; the guard only applies when the resolved target folder is actually `concepts/` — a topic candidate (the only kind `scanFolders()` emits post-purge) is never subject to it regardless of whether `concepts/glossary.md` happens to exist. (An initial version of this guard hardcoded the existence check to the `concepts/` path regardless of the candidate's real type, which — combined with `scanFolders()` now emitting topics only — caused the guard to fire and refuse on every real execution attempt, both new and update; fixed same-day by resolving the target folder against whichever page actually backs the slug before deciding whether the guard applies.)

### 26.5 `confidenceGap` default fix (G4)

`research-propose.ts`'s gap-score confidence signal: an unset `confidence` field (the common case for most `topic` notes) now contributes `0.5` to the score, same as an explicit `confidence: medium` — previously it fell through to `0.7`, meaning a note nobody had ever judged outranked one a human had explicitly marked medium-confidence, which is backwards. A narrow, evidenced default-value correction — not a re-weighting of the six-signal formula's weights or signals.

### 26.6 Observability (G5)

Three new structured `appendLogEntry` log lines in `log.md`, matching the existing `kind:` convention (`research:propose`, `topic:refresh`, etc.), each firing only when something was actually affected: `research:queue-capped` (candidates dropped by the `queueCap` slice), `research:orphans-purged` (candidates dropped by §26.4's purge), `research:drain` (candidates auto-enqueued by §26.2, when `autoDrainEnabled` is on).

### 26.7 Test coverage (G6)

Every research-queue-adjacent test fixture previously constructed its config via the default `VaultLayout` by construction — exactly why G0's bug shipped and went undetected (it only manifests under a non-default layout, i.e. every real `Curated/`-style production vault). New fixture coverage exists for `approve_research`, `karpathy intel queue`/`approve`/`status`, and `checkResearchQueue` against a non-default (`Curated/`-style) `VaultLayout`, alongside the pre-existing default-layout regression cases, so this bug class cannot silently recur a third time in this module.

### 26.8 Constraints

- No change in this section ever causes `research-execute` to fire without a prior, explicit `decision` value recorded by a human through one of the three approval surfaces (§21a's human-in-the-loop gate is not weakened).
- Auto-drain (§26.2) MUST NOT enqueue `research-execute` unless both `intelligence.research.autoDrainEnabled` is `true` and a caller-supplied `enqueue` dependency is present.
- `research-execute` MUST reserve a budget slot before performing any LLM call, and MUST NOT mark a queue candidate `completed` if that reservation is refused.
- `writeConceptNote()` MUST NOT create a new individual page under a glossary-consolidated `concepts/` folder; it MAY update an existing page there in place.

## 27. Resource-boundedness fixes (multi-instance MCP server)

A root-cause audit of repeated machine crashes under resource pressure found that every Claude Code window spawns its own MCP server process (`src/mcp/server.ts`), and — with 16 windows open concurrently — each independently ran a chokidar file watcher over the same OneDrive-backed vault folders, driving `fileproviderd` to 119% CPU and OneDrive's sync daemon to 70% CPU purely from N-fold redundant filesystem event/polling activity. Three further contributors compounded this: an unconditional background-drain spawn on every Stop/PostCompact hook (across every session, every turn), a data-loss bug that silently dropped watcher-triggered jobs before they ever reached disk, and a leaked Puppeteer/Chromium grandchild process per per-call websearch MCP invocation. This section fixes all four without weakening any existing job's correctness or the human-in-the-loop gates elsewhere in the intelligence layer.

### 27.1 Single-watcher advisory lock

`src/ingest/watcher.ts` exports `acquireWatcherLock(lockDir)`, a thin wrapper over the existing `createFileLock` (`src/jobs/lock.ts`) — no changes to `lock.ts` itself, since its cross-process staleness rule (a lock file whose recorded PID fails `process.kill(pid, 0)`) already implements "a dead holder's lock is free to take over." `src/mcp/server.ts` calls it, keyed `'watcher'`, before starting the chokidar watcher: if acquired, the watcher starts as before and the release function is retained; if a live MCP server instance already holds the lock, this instance skips starting a watcher entirely and relies on the lock-holder's watcher plus the every-5-min launchd `intel tick` FTS sync — no functionality is lost, only the redundant process. The lock is released (and the watcher stopped) from the server's existing `shutdown()` path, now also invoked from `server.onclose` so the lock is never held past the process's actual lifetime longer than the existing PID-staleness check would otherwise require.

### 27.2 Stop/PostCompact-hook drain throttle

`src/hooks/background-drain.ts`'s `spawnBackgroundDrain` is now async and takes `{ lockDir, stateDir, minIntervalMs? }` (wired from `src/hooks/dispatch.ts`'s shared `HookContext.backgroundDrain` closure, consumed identically by both `stop.ts` and `post-compact.ts`). Before spawning, it skips when either is true:

- the job runner's existing global `__drain__` lock (acquired by `drainQueueCommand()` in `src/bin/karpathy.ts`) is currently held by a live PID — that process will drain the whole queue itself;
- the last spawn happened within `ingest.stopDrainMinIntervalMs` (default 30000ms), recorded in `<stateDir>/last-drain.json` (same directory `job-queue.json` lives in).

Neither check risks stranding work: the scheduled `intel tick` (launchd, every 5 min) drains the queue unconditionally regardless of what a Stop/PostCompact hook decided.

### 27.3 `enqueueJob` flush fix

`src/mcp/context.ts`'s `enqueueJob` called `queue.enqueue(input)` without a following `queue.flush()` — `enqueue()` only mutates in-memory state, so an "enqueued" job never reached `job-queue.json` and was silently lost the moment the MCP server process exited. This hit watcher-triggered `sync-fts-index` jobs particularly hard (§24.3's layer 4): they fired on every file change but never survived to the next drain. Fixed by extracting `enqueueAndPersist(queue, input)` — `load()` then `enqueue()` then `flush()` — which `enqueueJob` now delegates to; exported standalone so it's directly testable without booting a full `MCPContext`.

### 27.4 Websearch subprocess reaping

`src/intelligence/web-search.ts`'s per-call MCP search client (`createMcpSearch`, the `lifecycle: 'per-call'` path used by `createWebSearchFromConfig` for `intelligence.research.search.provider: 'mcp'`) spawns through the SDK's `StdioClientTransport`, which shells out via `cross-spawn` with no `detached`/process-group option — so a grandchild the spawned command forks (e.g. Puppeteer's Chromium, spawned by a websearch MCP server run via `npx`) is never made a process-group leader, and the SDK's own `close()` only SIGTERM/SIGKILLs the direct command PID, leaking the grandchild.

What's reachable: `StdioClientTransport.pid` (SDK ≥1.29), the directly-spawned command's PID, available after `connect()`. What's NOT reachable: any way to make the SDK spawn its own process group — `StdioServerParameters` has no `detached` field — so signaling the negated PID (`-pid`) is unsafe here (the child was never made a group leader, so `-pid` would resolve to this process's own shared group). Best-available fix: after the SDK's own `close()`, `reapProcessDescendants(pid)` walks the process tree rooted at that PID via `pgrep -P` (macOS/BSD and Linux), SIGTERMs every descendant, waits a grace period, then SIGKILLs survivors — never touching the shared process group, so it can't collaterally kill unrelated processes. No-op (fast) when there are no descendants.

Companion config fix: the live operator config (`~/.karpathy/config.json`) had `defaults.intelligence.research.search.provider: "mcp"` (spawning `npx -y @mzxrai/mcp-webresearch@latest` on every research-execute call) despite `intelligence.research.autoDrainEnabled` being off and this path never having executed against real traffic — flipped to `"noop"` (backed up to `config.json.bak` first) since it was inert risk with no offsetting benefit until auto-drain is deliberately enabled.

### 27.5 Constraints

- The single-watcher lock MUST NOT block MCP server startup — a contested lock, or any acquire failure other than "already held live," only skips watcher startup, never context/tool/resource initialization.
- Skipping a Stop/PostCompact-hook drain MUST NOT strand the job queue indefinitely — the scheduled `intel tick` (5 min) drains regardless of the throttle/lock outcome.
- Process-tree reaping MUST only ever signal descendants of the tracked per-call subprocess PID — never a process group that could include the parent Karpathy/Claude Code process itself.

### 27.6 Global runner lock (Fix E)

A follow-up root-cause audit found the job system itself unbounded in four further ways, independent of the multi-instance MCP issue above — none of them mitigated by §27.1's single-watcher lock, since they concern the job *queue* rather than the file watcher. First: `src/jobs/runner.ts`'s `runAll()` drained the whole queue with no cross-process lock of its own. The launchd `intel tick`, the Stop-hook background drain, MCP `runDeterministicJobs`, and CLI `enqueueAndDrain` could all invoke `runAll()` concurrently against the same `job-queue.json`, causing duplicate LLM calls and last-writer-wins `flush()` corruption — and jobs without a `targetPath` (`decay-scan`, `rot-scan`, `sync-fts-index`, `digest-weekly`, `archive-stale-drafts`) took no lock at all under the pre-existing per-`targetPath` lock in `runOne`.

Fix: `runAll()` now acquires one global lock (key `'queue-runner'`, on the same `FileLock`/`lockDir` already threaded into every `createJobRunner` call site for per-`targetPath` locking — no new config plumbing needed) before draining, and releases it in a `finally`. Acquisition is a bounded wait: since `FileLock.acquire` throws `LockError` immediately rather than blocking when a *different* `FileLock` instance already holds a key, `runAll()` retries a few times (defaults: 8 attempts, 1s apart — ~7s bounded total, overridable via the test-only `queueRunnerLock` option) before giving up. If still held after the wait, it logs `queue-runner lock held — another drain in progress, skipping` and returns `0` without draining — never throws, and jobs stay pending for the current holder or the next scheduled tick. The per-`targetPath` lock inside `runOne` is unchanged (a different key, no deadlock risk).

### 27.7 Capped transient retries (Fix F)

Second: `src/jobs/queue.ts`'s `fail()` `transient` branch reset a job to `pending` and incremented `transientRetryCount` forever, never consulting `maxRetries` — a job against a slow/unreachable Bedrock endpoint (`TransientLLMError` from the 120s abort timeout) retried every ≤30 min indefinitely, re-spending LLM budget on every attempt.

Fix: `jobs.transientRetry.maxTransientRetries` (config, default 20). Once `transientRetryCount` exceeds this, `fail()` marks the job terminally `failed` (same terminal path the non-transient branch uses after `maxRetries`) instead of re-queuing, logging the give-up. The exponential backoff + 30-min ceiling for retries under the cap is unchanged.

### 27.8 Decay-scan fan-out cap (Fix G)

Third: `src/intelligence/decay-scan.ts` enqueued one `topic-refresh` job per stale/thin note across the scanned folders with no cap — growing 1:1 with vault size.

Fix: `intelligence.decay.maxRefreshEnqueuePerRun` (config, default 25). Qualifying candidates are now collected across the whole scan (not enqueued as encountered), sorted by urgency — thin-content trigger first, then lowest retrievability first — and only the top N are enqueued; the remainder are skipped this run (re-collected and re-considered on the next scheduled scan) and logged via `appendLogEntry` (`decay-scan:capped`) when any are actually dropped. `DecayScanResult` gained `refreshCapped` (count skipped); all prior fields are unchanged, and per-note retrievability scoring/persistence and research-candidate surfacing (uncapped — a separate, already-bounded mechanism) are unaffected.

### 27.9 Active-queue cap and budget-tracker lock (Fix H)

Fourth, two related gaps: `src/jobs/queue.ts`'s `enqueue()` had no guard on total active (pending+running) job count — `flush()` only capped the completed/failed tail at 100, so the active set could grow unbounded in `job-queue.json`. Separately, `src/shared/budget.ts`'s `tryReserve()` did an in-memory read-modify-write with no cross-process lock, so two tracker instances racing between load and flush (now rare after §27.6's runner-level lock, but still reachable via a synchronous CLI path invoked outside the job queue) could lose reservations and overspend the daily LLM cap.

Fix (queue cap): `jobs.maxActiveJobs` (config, default 1000; threaded into every production `createJobQueue` call site). `enqueue()` refuses a new (non-deduped) job once the active count reaches this ceiling — logging `job queue at capacity (N) — dropping <type>` and returning `null` rather than adding it. Dedup lookups (an existing pending/running job with the same `dedupeKey`) are unaffected by the cap. `JobQueue.enqueue()`'s return type is now `Promise<Job | null>`; no production call site inspects the resolved value, so this is a non-breaking ripple.

Fix (budget lock): `createBudgetTracker` gained an optional `lockDir`; when set, `tryReserve` (and `reset`) re-read committed state from disk and serialize their read-modify-write via `createFileLock(lockDir)` under a `'budget'` key (a bounded retry — 25 attempts, 20ms apart, ~500ms total — handles cross-instance contention the same way §27.6 does, falling back to proceeding unlocked past the retry budget rather than denying the reservation or hanging, since budget tracking is a soft rate-limit, not correctness-critical data). `createBudgetTrackerFromConfig` derives `lockDir` from the caller's `projectRoot` + `config.lockDir` (mirroring `defaultBudgetPath`'s convention) and passes it automatically, so every existing call site (topic-refresh, glossary-synthesize, research-execute, `generate-review-analysis`, the significance gate in `compiler.ts`) is covered without change. `BudgetTracker.tryReserve`/`reset` are now `Promise`-returning; all five call sites `await` them.

### 27.10 Constraints (§27.6-27.9)

- `runAll()`'s global lock acquisition MUST NOT throw on contention — a still-held lock after the bounded wait returns `0` (drains nothing), never an exception.
- The per-`targetPath` lock inside `runOne` and the global `'queue-runner'` lock MUST use distinct keys on the same `FileLock`/`lockDir` — no deadlock between them.
- A job's transient-retry cap (`maxTransientRetries`) MUST NOT apply to the bounded (non-transient) retry path, and vice versa — the two counters (`transientRetryCount`, `retryCount`) and their caps stay independent.
- `enqueue()`'s active-job cap MUST NOT interfere with dedup: an enqueue whose `dedupeKey` matches an existing pending/running job always returns that job, even at capacity.
- Decay-scan's per-note retrievability scoring and write-back, and its (uncapped) research-candidate surfacing, MUST run for every scanned note regardless of the refresh-enqueue cap — only the `topic-refresh` fan-out is bounded.
- The budget-tracker lock MUST degrade to today's unlocked behavior when `lockDir` is omitted — no call site is required to pass one.

