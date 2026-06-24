# Karpathy Second Memory

## Project Overview

This is a local-first knowledge system that captures Claude Code sessions and raw source material into an Obsidian-compatible wiki. It maintains structure, provenance, and quality automatically via hooks and a job queue.

## Specification

The authoritative design spec lives at `specs/specification.md`. Consult it before implementing features or making non-trivial changes. See sections 6-8 for the memory model, architectural lanes, and job system; section 9 for functional requirements; section 10 for the data model; section 12 for overwrite policy; section 18 for implementation phases.

## Build & Test

```bash
pnpm build            # Build with tsup → dist/
pnpm test             # Vitest, 489 tests across 45 files
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

## Intelligence pipeline

Implements [specs/intelligence-plan.md](specs/intelligence-plan.md). Hot paths:

- **Embedding store** (`src/embeddings/`) — backed by SQLite. `openStoreFromConfig(config, projectRoot)` opens it at `.karpathy/state/embeddings.sqlite`. Provider chosen by `config.embeddings.provider` — `deterministic` (default, offline) or `bedrock-titan`.
- **Retrieval with recency** (`src/intelligence/retrieval.ts`) — `final = α · rerank + β · exp(-Δt / 30)`. β per content-type via `config.intelligence.recencyWeight`.
- **Weekly digest** (`src/intelligence/digest.ts`) — `runWeeklyDigest()` clusters last-N-days chunks via `clusterByCosine` (`src/intelligence/clustering.ts`), labels each cluster via Bedrock, writes `wiki/digests/{ISO-week}.md`. Cron-triggerable via the `digest-weekly` job.
- **Topic refresh** (`src/intelligence/topic-refresh.ts`) — pulls evidence via retrieval, rewrites the `current-understanding` protected region, surfaces contradictions instead of overwriting. Job: `topic-refresh` with `targetPath`.
- **Decay scan** (`src/intelligence/decay-scan.ts`) — computes `R = exp(-Δt / S)` per note, enqueues `topic-refresh` for stale ones, surfaces low-retrievability concept/topic notes as research candidates. Job: `decay-scan`.
- **Vault-rot diagnostic** (`src/intelligence/rot-scan.ts`) — orphan + stale + low-confidence → `wiki/_system/vault-health.md`. Job: `rot-scan`.
- **Research handshake** — gap detection (`research-propose.ts`) writes `wiki/_system/research-queue.md`; user decides depth via Slack reply (parsed by `slack-notify.ts`), direct queue edit, or the `approve_research` MCP tool. Tiered executor (`research-execute.ts`) runs `light` / `medium` / `heavy` rounds. Jobs: `research-propose`, `research-execute`.
- **Significance gate** (`src/intelligence/significance-gate.ts`) — heuristic + optional LLM gate that drops noise entities. Wired into `link-concepts` handler when `config.enrichment.significanceGate !== 'off'`.
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
    "research": { "enabled": true, "queueCap": 50, "autoExpireDays": 14, "depths": { ... } }
  },
  "notifications": { "slack": { "enabled": false, "webhookUrl": "...", "target": "#channel" } },
  "enrichment": { "significanceGate": "heuristic" | "off" | "llm" }
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

## Common Tasks

- **Add a new job type**: Add to `JobType` enum in `src/jobs/types.ts`, create handler in `src/jobs/handlers/`, register in `src/jobs/handlers/index.ts`
- **Add a new wiki note type**: Add Zod schema in `src/vault/frontmatter.ts`, add template in `templates/`
- **Add a new hook**: Add handler in `src/hooks/`, register in `src/hooks/dispatch.ts`, add input schema in `src/hooks/types.ts`
- **Add a new MCP tool**: Create handler in `src/mcp/tools/`, add to `src/mcp/tools/index.ts` (definitions) and `src/mcp/tools/router.ts` (handlers), add tests in `test/mcp/tools.test.ts`
