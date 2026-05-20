import type { AgentToolDef } from '../tool-registry.js';
import { readFileTool } from './read-file.js';
import { globFilesTool } from './glob-files.js';
import { searchWikiTool } from './search-wiki.js';
import { listProjectsTool } from './list-projects.js';
import { getProjectHubTool } from './get-project-hub.js';
import { getProjectConversationsTool } from './get-project-conversations.js';
import { createPageTool } from './create-page.js';
import { updateProtectedRegionTool } from './update-protected-region.js';
import { resolveEntityTool } from './resolve-entity.js';
import { createEntityTool } from './create-entity.js';
import { createProjectSpecTool } from './create-project-spec.js';
import { classifyCwdTool } from './classify-cwd.js';
import { markCompleteTool } from './mark-complete.js';

/**
 * Create the full set of ingest agent tools.
 */
export function createIngestToolRegistry(): AgentToolDef[] {
  return [
    // Read / explore
    readFileTool,
    globFilesTool,
    searchWikiTool,
    listProjectsTool,
    getProjectHubTool,
    getProjectConversationsTool,
    // Write / update
    createPageTool,
    updateProtectedRegionTool,
    createProjectSpecTool,
    // Entity resolution
    resolveEntityTool,
    createEntityTool,
    // Classification
    classifyCwdTool,
    // Completion
    markCompleteTool,
  ];
}
