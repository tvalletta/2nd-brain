/**
 * Filters noise entities before page creation.
 * Prevents creation of wiki pages for generic names, internal tool names,
 * and trivially short entity names.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('entity-filter');

/** Built-in generic names that should never become entity pages. */
const BUILTIN_BLOCKLIST = new Set([
  'user', 'assistant', 'system', 'ai', 'human', 'bot', 'agent', 'model',
  'the user', 'the assistant', 'the system',
  'error', 'warning', 'unknown', 'none', 'n/a', 'null', 'undefined',
  'api', 'cli', 'sdk', 'url', 'ui', 'ux',
]);

/** Internal agent tool names that LLMs sometimes extract as "tools". */
const AGENT_TOOL_NAMES = new Set([
  'classify-cwd', 'create-entity', 'create-page', 'create-project-spec',
  'get-project-conversations', 'get-project-hub', 'glob-files', 'list-projects',
  'mark-complete', 'read-file', 'resolve-entity', 'search-wiki',
  'update-protected-region',
  // Underscore variants (MCP tool style)
  'classify_cwd', 'create_entity', 'create_page', 'create_project_spec',
  'get_project_conversations', 'get_project_hub', 'glob_files', 'list_projects',
  'mark_complete', 'read_file', 'resolve_entity', 'search_wiki',
  'update_protected_region',
]);

/**
 * Check if an entity name is noise and should not become a wiki page.
 *
 * @param name - The entity name
 * @param kind - The entity kind (person, concept, tool, etc.)
 * @param customBlocklist - Additional names from user config
 */
export function isNoiseEntity(
  name: string,
  kind: string,
  customBlocklist: string[] = [],
): boolean {
  const normalized = name.toLowerCase().trim();

  // Too short
  if (normalized.length < 2) {
    log.debug('Filtered noise entity (too short)', { name, kind });
    return true;
  }

  // Built-in blocklist
  if (BUILTIN_BLOCKLIST.has(normalized)) {
    log.debug('Filtered noise entity (blocklist)', { name, kind });
    return true;
  }

  // User-configured blocklist
  if (customBlocklist.some((b) => normalized === b.toLowerCase().trim())) {
    log.debug('Filtered noise entity (custom blocklist)', { name, kind });
    return true;
  }

  // Agent tool names
  if (AGENT_TOOL_NAMES.has(normalized)) {
    log.debug('Filtered noise entity (agent tool)', { name, kind });
    return true;
  }

  return false;
}
