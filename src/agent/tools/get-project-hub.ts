import type { AgentToolDef } from '../tool-registry.js';
import { listProjectSpecs } from '../../compilation/project-hub.js';

export const getProjectHubTool: AgentToolDef = {
  name: 'get_project_hub',
  description:
    'Read a project hub: its _index.md and all sub-spec pages in one call. Returns the full content of each file.',
  input_schema: {
    type: 'object',
    properties: {
      project_slug: {
        type: 'string',
        description: 'The project slug, e.g. "auth-redesign"',
      },
    },
    required: ['project_slug'],
  },
  async execute(input, context) {
    const slug = input.project_slug as string;
    const indexPath = `wiki/projects/${slug}/_index.md`;

    // Try hub model first
    if (await context.vault.exists(indexPath)) {
      const parts: string[] = [];

      // Read index
      const indexContent = await context.vault.read(indexPath);
      parts.push(`=== ${indexPath} ===\n${indexContent}`);

      // Read all sub-specs
      const specs = await listProjectSpecs(context.vault, slug);
      for (const spec of specs) {
        try {
          const content = await context.vault.read(spec.path);
          parts.push(`\n=== ${spec.path} (spec_type: ${spec.specType}) ===\n${content}`);
        } catch {
          parts.push(`\n=== ${spec.path} === [unreadable]`);
        }
      }

      return parts.join('\n');
    }

    // Try legacy single-page
    const legacyPath = `wiki/projects/${slug}.md`;
    if (await context.vault.exists(legacyPath)) {
      const content = await context.vault.read(legacyPath);
      return `=== ${legacyPath} (legacy single-page) ===\n${content}`;
    }

    return `Project not found: ${slug}`;
  },
};
