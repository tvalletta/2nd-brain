import type { AgentToolDef } from '../tool-registry.js';
import { parseNote } from '../../vault/frontmatter.js';

export const searchWikiTool: AgentToolDef = {
  name: 'search_wiki',
  description:
    'Search across wiki pages for a text query. Returns matching file paths and a snippet of the matching content. Searches titles, frontmatter, and body text.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for (case-insensitive substring match)',
      },
      folder: {
        type: 'string',
        description: 'Optional: limit search to a specific wiki folder, e.g. "wiki/projects"',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
      },
    },
    required: ['query'],
  },
  async execute(input, context) {
    const query = (input.query as string).toLowerCase();
    const folder = (input.folder as string) ?? 'wiki';
    const maxResults = (input.max_results as number) ?? 10;

    let files: string[];
    try {
      files = await context.vault.listMarkdownFiles(folder);
    } catch {
      return `Folder not found: ${folder}`;
    }

    const results: string[] = [];

    for (const path of files) {
      if (results.length >= maxResults) break;
      try {
        const content = await context.vault.read(path);
        const lower = content.toLowerCase();
        if (!lower.includes(query)) continue;

        const { data } = parseNote(content);
        const title = (data.title as string) ?? path;

        // Extract a snippet around the match
        const idx = lower.indexOf(query);
        const start = Math.max(0, idx - 80);
        const end = Math.min(content.length, idx + query.length + 80);
        const snippet = content.slice(start, end).replace(/\n/g, ' ').trim();

        results.push(`- **${title}** (${path})\n  ...${snippet}...`);
      } catch {
        // Skip unreadable files
      }
    }

    if (results.length === 0) return `No results found for "${input.query}" in ${folder}`;
    return results.join('\n');
  },
};
