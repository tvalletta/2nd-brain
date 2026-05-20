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
| "Find notes about X" (keyword) | search_vault |
| "Find the person/tool/project named X" | get_entity or search_entities |
| "Find notes semantically related to X" | get_related (needs AWS creds) |
| "What decisions have I made?" | get_decisions |
| "Find notes tagged with X or linked to Y" | search_by_tags |
| "Read a specific note" | get_note or batch_get_notes |
| "Find and resolve duplicate entity pages" | reconcile_entities |
| "Re-process a note I just edited" | re_enrich_note |

## When to use which tool

### Start of every session
1. **get_hot_cache** — Always call first. Returns recent sessions, active entities, hot topics, pending research. ~2KB of distilled context.
2. **vault_status** — Optional quick count of notes and review queue size.

### Reading
- **get_note** — Read a specific note by exact path or title. Prefer detail:"metadata" or "summary" to save tokens.
- **get_recent_sessions** — Recent AI session summaries with what was worked on and decided. Falls back to the decisions protected region when frontmatter is not yet populated.
- **get_entity** — Direct lookup of a known entity by name. Faster than search_entities for known names.
- **search_entities** — Ranked keyword search across entity notes (people, orgs, tools, projects, concepts). Filter by kind to narrow. Results sorted by relevance.
- **get_decisions** — All decision notes sorted by date. Useful for surfacing past architectural or strategic choices before making a new one.
- **search_vault** — Full-text keyword search with stemming across wiki, sessions, sources, and review. Use when you don't know exactly where something is. Supports partial matches ("analysis" finds "analyses"). Returns up to 20 results ranked by title > heading > body frequency.
- **get_related** — Semantic similarity search using Bedrock-Titan embeddings + recency boost. Best for "what else is like this?" queries. Requires active AWS credentials — returns a clear fallback message if credentials are expired.
- **get_backlinks** — All notes that link to a given note. Use to understand who references a person, decision, or concept.
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
- **reconcile_entities** — Manage the entity reconciliation queue. Call with no args to see pending duplicate/variant entity pairs. Call with { id, decision } to apply a resolution (merge, rename, skip, manual). Merge executes atomically and rebuilds backlinks.
- **re_enrich_note** — Re-run entity extraction and concept-linking on an existing wiki note after you manually add content outside its protected regions. Pass { notePath } (vault-relative path).

## Tips
- Default to detail:"summary" for exploration; use detail:"full" only when you need the complete body.
- After log_session_summary, log_insight, or update_note, call run_maintenance once to keep the graph current.
- Notes use [[wikilinks]] for cross-referencing. Mention entity names in double brackets to create links.
- search_vault excludes _index.md category files — it only returns content notes.
- get_related will tell you if AWS credentials are expired and suggest search_vault as a fallback.

## Performance
- search_vault and lint_vault scan files sequentially — avoid calling in tight loops.
- run_maintenance is idempotent. One call after a batch of writes is enough.
- The server is single-threaded. Avoid many parallel calls that each trigger large vault scans.

## Usage audit
Every tool call is logged to .karpathy/logs/mcp-usage.jsonl with tool name, args, duration, result count, and success/error. Use this to analyze which tools are most useful and refine descriptions over time:
  cat .karpathy/logs/mcp-usage.jsonl | jq -r '.tool' | sort | uniq -c | sort -rn
`;
}

/** Static export for backward compat — uses default layout. */
export const INSTRUCTIONS = buildInstructions();
