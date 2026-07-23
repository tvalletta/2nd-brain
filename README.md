# Karpathy Second Memory

Local-first knowledge system that captures Claude Code sessions and raw source material, compiles them into a persistent Obsidian wiki, and maintains structure, provenance, and links automatically.

## Quickstart

```bash
pnpm install && pnpm build

# Configure the vault path (global — applies to all projects)
mkdir -p ~/.karpathy
echo '{"defaults":{"vaultPath":"/path/to/your/obsidian-vault"}}' > ~/.karpathy/config.json

# Install Claude Code hooks (runs automatically on every session)
node dist/bin/karpathy.js install-hooks

# Register the MCP server in Claude Code
node dist/bin/karpathy.js install-mcp

# Check vault health
node dist/bin/karpathy.js status
```

---

## MCP Usage Analysis

Every call to the Carpathi MCP server is logged to `.karpathy/logs/mcp-usage.jsonl` — one JSON line per call with tool name, args, duration, result count, success flag, and any error message.

**Review this log regularly.** It shows which tools are actually being reached for, which return useless results, and where to tighten descriptions or fix scoring. This is how the system improves over time.

```bash
# Which tools are called most often?
cat .karpathy/logs/mcp-usage.jsonl | jq -r '.tool' | sort | uniq -c | sort -rn

# All failures — tool errors and unknown-tool calls
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.success == false)'

# Slowest calls (top 10 by duration)
cat .karpathy/logs/mcp-usage.jsonl | jq -s 'sort_by(.duration_ms) | reverse | .[0:10] | .[] | {tool, duration_ms, result_count}'

# What has search_vault been searching for?
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.tool == "search_vault") | .args.query'

# How many results does each search actually return?
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.result_count != null) | {tool, result_count, query: .args.query}'

# Calls with zero results (tool ran but returned nothing useful)
cat .karpathy/logs/mcp-usage.jsonl | jq 'select(.result_count == 0)'

# Usage summary for a given date
cat .karpathy/logs/mcp-usage.jsonl | jq -r 'select(.ts | startswith("2026-05")) | .tool' | sort | uniq -c | sort -rn
```

Use these to answer: *Is the system finding the right things? Are the tool descriptions clear enough to route correctly? What searches return zero results?*

---

## CLI Reference

| Command | Description |
|---|---|
| `karpathy init [vault-path]` | Initialize a new vault |
| `karpathy status` | Vault stats: wiki pages, sessions, sources, review queue |
| `karpathy maintain` | Run deterministic maintenance (backlinks + indexes) |
| `karpathy maintenance <flags>` | Hybrid-search maintenance: `--populate-fts`, `--re-embed`, `--prune-provider <id>`, `--rebuild-fts-tokenizer [--confirm]` |
| `karpathy drain-queue` | Drain pending jobs (used by background hooks) |
| `karpathy ingest <file> [--enrich]` | Ingest a raw source file (`--enrich` for LLM enrichment) |
| `karpathy reingest [--no-enrich]` | Re-ingest all raw files through the pipeline |
| `karpathy reprocess-agent` | Run agent pipeline on unprocessed AI conversations |
| `karpathy import-sessions [--all] [--enrich]` | Import Claude Code session history |
| `karpathy import-cursor-sessions [--enrich]` | Import Cursor IDE session history |
| `karpathy clean` | Delete all generated content (`wiki/`, `outputs/`, etc.), keep `raw/` |
| `karpathy review` | List items in the review queue |
| `karpathy merge <src> <tgt>` | Merge one entity into another |
| `karpathy merge --detect` | Detect potential duplicate entities |
| `karpathy merge --auto` | Auto-merge high-confidence duplicates |
| `karpathy migrate` | Migrate vault (delete old summaries, backfill frontmatter) |
| `karpathy migrate-hubs` | Migrate legacy single-page projects to hub model |
| `karpathy migrate-markers` | Migrate `<!-- PROTECTED -->` markers to `%%` syntax |
| `karpathy install-hooks` | Install Claude Code hooks into `~/.claude/settings.json` |
| `karpathy install-mcp` | Register MCP server in Claude Code + Cursor |
| `karpathy mcp` | Start MCP server (stdio transport) |
| `karpathy hook <event>` | Handle a Claude Code hook event (called by hooks, not directly) |
| `karpathy synthesize <slug>` | Run full re-synthesis for a project (Opus model) |
| `karpathy check-decay` | Check for stale project specs and trigger re-synthesis |
| `karpathy cross-project` | Detect cross-project patterns and shared entities |
| `karpathy skills` / `skills seed` / `skills generate` | List / seed / generate synthesis skills |
| `karpathy spec-versions [archive]` | List or archive superseded spec versions |
| `karpathy curator` | Interactive entity reconciliation queue walkthrough |
| `karpathy touch <note-path>` | Re-run entity extraction on a wiki note you edited |
| `karpathy entity-aliases` | Interactive walkthrough to fill in aliases for every entity note |

### Intelligence pipeline (`karpathy intel <subcommand>`)

| Subcommand | Description |
|---|---|
| `intel backfill` | Backfill time-aware frontmatter (`last_verified`, `stability`, `tldr`, ...) |
| `intel reindex [folder]` | Re-embed all notes under `folder` (default: wiki). Use after upgrading. |
| `intel digest` | Run weekly hot-topics digest (clusters recent chunks by topic) |
| `intel decay` | Run decay scan now (enqueues topic refreshes) |
| `intel rot` | Run vault rot diagnostic (writes `wiki/_system/vault-health.md`) |
| `intel propose` | Propose research candidates from high-mention entities |
| `intel refresh <path>` | Refresh a single topic note by path |
| `intel research <slug> <depth>` | Execute approved research at depth (`light`\|`medium`\|`heavy`) |
| `intel queue` | Print the current research queue |
| `intel index` | Rebuild vault root `index.md` |
| `intel tick` | Self-pacing scheduler — fires whichever scheduled jobs are due |
| `intel schedule` | Print scheduler state (last fire per job type) |
| `intel approve "<reply>"` | Approve research candidates ("1 heavy, 2 medium, skip 3") |
| `intel status` | Pipeline health: counts, latest digest, scheduler state |
| `intel health [--json]` | Structured health check (exit 0 OK, 1 critical, 2 warn) |
| `intel serve [--port N]` | Long-running HTTP server exposing `/health` (default port 9123) |

---

## How It Works

### Session Capture

Claude Code hooks run automatically on every session:

- **SessionStart** — Loads vault context (hotcache) into the session via `additionalContext`
- **UserPromptSubmit** — Logs each prompt to the session note
- **PostToolUse** — Tracks file writes/edits during the session
- **PostCompact** — Saves compaction summaries, flushes the hot cache
- **Stop** — Finalizes the session note, updates hotcache, exports transcript for ingest

### Ingest Pipeline

Drop files into the raw directory or use `karpathy ingest <file>`:

1. File classified by source type (markdown, audio transcript, JSON, etc.)
2. Source summary note created with entities, concepts, and decisions extracted
3. Entities compiled into wiki pages; cross-links and backlinks updated
4. Hot topics digest updated on the next `intel digest` run

### Job Queue

All automation flows through a JSON-backed job queue at `.karpathy/state/job-queue.json`:

- Jobs deduplicate by `dedupeKey` so rapid triggers collapse
- Each job handler is idempotent — safe to re-run
- Full cascade graph in `specs/specification.md` §8.5

### Hot Cache

`Curated/hotcache.md` (or `CLAUDE.md` in default layout) is injected into every Claude Code session at start. It contains recent sessions, key entities, hot topics from the latest weekly digest, and pending research candidates. This is the primary mechanism for keeping AI assistants informed about ongoing work.

---

## MCP Server

The Carpathi MCP server exposes 23 tools to Claude Code, Cursor, and any MCP-compatible host.

### Which tool to use

| Goal | Tool |
|---|---|
| Orient at session start | `get_hot_cache` |
| Find notes about X (any free-text query) | `search` |
| Find a specific person/tool/project | `get_entity` or `search_entities` |
| Find notes tagged with X or linked to Y | `search_by_tags` |
| Surface past decisions | `get_decisions` |
| Recent session context | `get_recent_sessions` |
| Read a specific note | `get_note` or `batch_get_notes` |
| Find and resolve duplicate entity pages | `reconcile_entities` |
| Save what was decided or built | `log_session_summary` + `log_insight` |
| Refresh backlinks and indexes | `run_maintenance` |

### Search notes

- `search` — **the primary search tool.** Hybrid FTS5 + BM25 keyword ranking, fused with an optional Ollama semantic layer (Reciprocal Rank Fusion), plus a recency boost. Runs in <100ms against a pre-built SQLite index. Accepts any free-text query or a `path` to find notes similar to an anchor note. Use this for vault-wide queries.
- `search_vault` — **deprecated.** A sequential file scan (7-11s on a large vault) kept only for backward compatibility. Do not use it for new integrations; use `search` instead.
- `search_entities` — keyword search scoped to entity notes (people, orgs, tools, projects, concepts), ranked by relevance.
- `get_related` — semantic similarity via embeddings + recency boost. Falls back gracefully when the embedding provider is unavailable — see `search.semanticFallbackEnabled` in [Configuration](#configuration).

### Server instructions

The server sends dynamic instructions to the LLM at startup, derived from the actual vault layout. This means paths shown in guidance match what's actually on disk (e.g., `Curated/wiki/entities/` not the default `wiki/entities/`).

---

## Vault Layout

The vault layout is config-driven. The production layout puts everything under one `Curated/` folder:

```
Obsidian Notes/
  Curated/
    wiki/
      entities/           # People, orgs, tools
      projects/           # Work initiatives
      decisions/          # Architectural and strategic choices
      concepts/           # Abstract ideas and frameworks
      digests/            # Weekly hot-topic digests
      _system/            # research-queue.md, vault-health.md
    sources/              # Processed source summaries
    hotcache.md           # Hot cache (injected into every Claude session)
    review/               # Items pending human review
  AI Conversations/
    _summaries/           # Claude Code session logs
  Plaud/                  # Audio transcripts (raw source)
```

The default (legacy) layout uses flat `wiki/`, `outputs/`, `raw/`, `review/` at vault root.

---

## Configuration

Global config at `~/.karpathy/config.json`:

```jsonc
{
  "defaults": {
    "vaultPath": "/path/to/vault",
    "hotCachePath": "Curated/hotcache.md",
    "layout": {
      "wiki":           "Curated/wiki",
      "sources":        "Curated/sources",
      "review":         "Curated/review",
      "system":         "Curated/_system",
      "digests":        "Curated/wiki/digests",
      "aiConversations": "AI Conversations",
      "aiSummaries":    "AI Conversations/_summaries",
      "aiLegacy":       "AI Conversations/_legacy"
    },
    "llm": {
      "provider": "bedrock",
      "region": "us-west-2",
      "model": "us.anthropic.claude-sonnet-4-6",
      "models": {
        "fast":   "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "medium": "us.anthropic.claude-sonnet-4-6",
        "heavy":  "us.anthropic.claude-opus-4-6-v1"
      }
    },
    "intelligence": {
      "digest": { "enabled": true, "windowDays": 7 },
      "decay":  { "enabled": true },
      "refresh": { "enabled": true, "threshold": 3 },
      "budget": { "enabled": true, "llmCallsPerDay": { "fast": 200, "medium": 50, "heavy": 10 } },
      "research": { "enabled": true }
    },
    "search": {
      "semanticFallbackEnabled": true
    }
  }
}
```

`search.semanticFallbackEnabled` gates the hybrid retrieval fallback path (confidence-gated: falls back only when the FTS pass returns too few hits) — see `src/search/hybrid-store.ts`.

### Critical path rules

- **Layout-aware paths** — Always use `layoutFromConfig(config)` and `kindToFolder(layout, kind)` from `src/vault/paths.ts`. Never hardcode `'wiki/'` — in production the wiki lives at `Curated/wiki/`.
- **VaultAdapter only** — All vault filesystem I/O goes through `VaultAdapter`. Never use `fs` directly for vault operations.
- **Protected regions** — Machine-managed content lives inside `%% begin:id %%` / `%% end:id %%` blocks. Never write outside these markers.

---

## Architecture

### Three Processing Lanes

1. **Deterministic** (priority 10) — Backlinks, indexes, hot cache flush. Fast, idempotent, no LLM.
2. **Extraction** (priority 50) — LLM summarization, entity extraction, concept linking, topic refresh.
3. **Heuristic Review** (priority 80) — Contradiction and duplicate detection.

### Key Patterns

- **Protected Regions** — `%% begin:id %%` / `%% end:id %%` confine automation; human-authored content is never overwritten.
- **Job Queue** — JSON-backed with dedup by `dedupeKey` and debounce windows.
- **Atomic Writes** — Write to `.tmp`, then rename. No partial writes on crash.
- **Usage Audit Log** — Every MCP tool call logged to `.karpathy/logs/mcp-usage.jsonl`.

### State Separation

```
.karpathy/
  state/
    job-queue.json     # pending + completed jobs
    budget.json        # daily LLM call budgets
    embeddings.sqlite  # Vector embedding store (Ollama or Bedrock-Titan, config-driven)
  locks/               # file-based mutexes
  logs/
    *.log              # structured job execution logs
    mcp-usage.jsonl    # MCP tool call audit log ← analyze this regularly
```

---

## Development

```bash
pnpm build            # Build with tsup → dist/
pnpm test             # Vitest — 901 tests across 116 files
pnpm lint             # tsc --noEmit (strict mode)
```

All three must pass before committing.

### Retrieval Eval Harness

`eval/` holds a standalone harness for benchmarking retrieval variants (keyword-only vs. hybrid FTS5+BM25+RRF+semantic) against a hand-curated + usage-mined query dataset, plus a downstream check of whether retrieval differences actually change generated-answer quality (blind pairwise LLM judging), not just a proxy metric like recall@k.

| Script | Description |
|---|---|
| `npm run eval:mine` | Mine real usage logs + session history into candidate eval queries |
| `npm run eval:run` | Run all retrieval variants against the query dataset |
| `npm run eval:pool` / `eval:judge-full` | Build the judgment pool and run blind LLM relevance judging |
| `npm run eval:score` | Compute recall/precision/MRR scorecards per category/variant |
| `npm run eval:bakeoff` | Composite score + verdict across variants — **fails loudly (non-zero exit) if the downstream answer-quality check is missing or stale relative to the current run** |
| `npm run eval:answer-quality` | Generate real answers from each variant's retrieved context and blind-judge them pairwise |
| `npm run eval:typecheck` | Typecheck the `eval/` tree separately from the main build |

`eval/pool/judge-full.ts` and `eval/report/main.ts` auto-load `.env` (via `eval/shared/load-env.ts`) so Bedrock credentials are available without sourcing it manually first.

### Adding a new MCP tool

1. Create handler in `src/mcp/tools/<tool-name>.ts` — export `definition` and `handle`
2. Register in `src/mcp/tools/index.ts` (definitions) and `src/mcp/tools/router.ts` (handlers)
3. Add tests in `test/mcp/tools.test.ts`
4. Update `src/mcp/instructions.ts` — add to the search decision table and "when to use" section

The router automatically logs every tool call to the usage audit log — no extra wiring needed.

## Tech Stack

- TypeScript (strict) + Node.js >= 18
- tsup (ESM build)
- Vitest (testing)
- Zod (schema validation)
- gray-matter (YAML frontmatter)
- AWS Bedrock SDK (LLM + embeddings, optional)
- better-sqlite3 (embedding store)
- Model Context Protocol SDK (`@modelcontextprotocol/sdk`)
