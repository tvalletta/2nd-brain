import type { AgentToolDef } from '../tool-registry.js';
import { parseNote } from '../../vault/frontmatter.js';

export const listProjectsTool: AgentToolDef = {
  name: 'list_projects',
  description:
    'List all project hubs in the wiki. Returns project names, slugs, and status.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(_input, context) {
    let files: string[];
    try {
      files = await context.vault.listMarkdownFiles('wiki/projects');
    } catch {
      return 'No projects directory found.';
    }

    // Filter to only project-level pages (hub _index.md or legacy .md)
    const projectFiles = files.filter((f) => {
      if (f.endsWith('_index.md')) return true;
      // Legacy: top-level .md files (not inside subdirectories beyond wiki/projects/)
      const rel = f.replace('wiki/projects/', '');
      return !rel.includes('/') && f.endsWith('.md');
    });

    if (projectFiles.length === 0) return 'No projects found.';

    const results: string[] = [];
    for (const path of projectFiles) {
      try {
        const content = await context.vault.read(path);
        const { data } = parseNote(content);
        const title = (data.title as string) ?? 'Untitled';
        const slug = (data.project_key as string) ?? path;
        const status = (data.project_status as string) ?? 'unknown';
        const isHub = path.endsWith('_index.md');
        results.push(`- **${title}** (slug: ${slug}, status: ${status}, hub: ${isHub})`);
      } catch {
        results.push(`- ${path} (unreadable)`);
      }
    }

    return results.join('\n');
  },
};
