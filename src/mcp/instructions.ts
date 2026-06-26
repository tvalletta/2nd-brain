import type { VaultLayout } from '../vault/paths.js';
import { DEFAULT_LAYOUT } from '../vault/paths.js';

export function buildInstructions(layout: VaultLayout = DEFAULT_LAYOUT): string {
  return `Karpathy is a local-first knowledge system backed by an Obsidian vault. Use these tools to query past sessions, entities, decisions, and concepts — or to capture and refine knowledge.

## Vault Structure
- ${layout.wiki}/entities/ — People, orgs, tools
- ${layout.wiki}/projects/ — Work initiatives
- ${layout.wiki}/decisions/ — Important choices with context
- ${layout.wiki}/concepts/ — Abstract ideas and frameworks
- ${layout.aiSummaries}/ — AI session logs
- ${layout.sources}/ — Ingested source material
- ${layout.review}/ — Items pending human review
- ${layout.digests}/ — Weekly hot-topic digests

## Which search tool to use

| Goal | Tool |
|------|------|
| "What have I worked on recently?" | get_recent_sessions |
| "Find notes about X" (any query) | **search** — fast hybrid BM25 + semantic, covers entire vault |
| "Find the person/tool/project named X" | get_entity (direct) or search_entities (ranked) |
| "What decisions have I made?" | get_decisions |
| "Find notes tagged with X or linked to Y" | search_by_tags |
| "Read a specific note" | get_note or batch_get_notes |
| "Find and resolve duplicate entity pages" | reconcile_entities |

**Always use \`search\` for vault-wide queries.** It runs in <100ms against a pre-built SQLite FTS5 index with BM25 ranking and optional Ollama semantic search. Do not use \`search_vault\` — it does a sequential file scan (7–11s) and is deprecated.

## When to use which tool

### Start of every session
1. **get_hot_cache** — Always call first. Returns recent sessions, active entities, hot topics, pending research. ~2KB of distilled context.
2. **vault_status** — Optional quick count of notes and review queue size.

### Reading
- **search** — The primary search tool. Accepts any free-text query. BM25 keyword matching over all 22,000+ vault notes; optional semantic layer via Ollama. Returns hits with title, path, score, and snippet. Default: up to 20 results.
- **get_note** — Read a specific note by exact path or title. Prefer detail:"metadata" or "summary" to save tokens.
- **get_recent_sessions** — Recent AI session summaries with what was worked on and decided.
- **get_entity** — Direct lookup of a known entity by name. Faster than search_entities for known names.
- **search_entities** — Ranked keyword search across entity notes (people, orgs, tools, projects, concepts). Filter by kind to narrow.
- **get_decisions** — All decision notes sorted by date.
- **get_backlinks** — All notes that link to a given note.
- **batch_get_notes** — Read multiple known notes in one round-trip. Use detail:"summary" for efficiency.
- **search_by_tags** — Find notes by frontmatter aliases, links, or tags.
- **get_review_queue** — Notes flagged for human review (contradictions, low-confidence claims).

### Writing
- **log_session_summary** — At end of a substantive task: capture what was done, decided, and changed. Always call this at session end.
- **log_insight** — When a conversation surfaces a new entity (person, project, concept, decision) worth persisting. Each insight becomes a wiki note.
- **update_note** — Refine an existing note: update frontmatter, replace or append body. Protected regions are always preserved.
- **ingest_content** — Add raw source material (meeting notes, documents) into the vault for processing.

### Maintenance
- **run_maintenance** — After any write operations, call once to update backlinks and rebuild indexes.
- **lint_vault** — Health check: orphan notes, broken links, stale notes, missing frontmatter, duplicate titles.
- **approve_research** — Approve pending research candidates from the research queue.
- **reconcile_entities** — Manage the entity reconciliation queue.
- **re_enrich_note** — Re-run entity extraction on an existing wiki note after manual edits.

## Tips
- Default to detail:"summary" for exploration; use detail:"full" only when you need the complete body.
- After log_session_summary, log_insight, or update_note, call run_maintenance once to keep the graph current.
- Notes use [[wikilinks]] for cross-referencing.
- search excludes _index.md category files — it only returns content notes.

## Performance
- **search** uses a pre-built SQLite FTS5 index — fast (<100ms). Use it freely.
- search_vault and lint_vault scan files sequentially — avoid these; search_vault is deprecated.
- run_maintenance is idempotent. One call after a batch of writes is enough.

## Usage audit
Every tool call is logged to .karpathy/logs/mcp-usage.jsonl with tool name, args, duration, result count, and success/error.
`;
}

/** Static export for backward compat — uses default layout. */
export const INSTRUCTIONS = buildInstructions();
