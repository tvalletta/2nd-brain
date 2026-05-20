import type { AgentToolDef } from '../tool-registry.js';

export const getProjectConversationsTool: AgentToolDef = {
  name: 'get_project_conversations',
  description:
    'List AI conversation files for a project. Checks both Claude and Cursor conversation directories.',
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
    const dirs = [
      `raw/ai-conversations/claude/${slug}`,
      `raw/ai-conversations/cursor/${slug}`,
    ];

    const results: string[] = [];

    for (const dir of dirs) {
      try {
        const files = await context.vault.listMarkdownFiles(dir);
        if (files.length > 0) {
          results.push(`**${dir}/** (${files.length} files)`);
          for (const f of files) {
            results.push(`  - ${f}`);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    if (results.length === 0) return `No conversations found for project: ${slug}`;
    return results.join('\n');
  },
};
