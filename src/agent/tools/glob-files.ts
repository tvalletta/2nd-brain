import type { AgentToolDef } from '../tool-registry.js';

export const globFilesTool: AgentToolDef = {
  name: 'glob_files',
  description: 'List markdown files in a vault directory. Returns an array of vault-relative paths.',
  input_schema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Vault-relative directory to list, e.g. "wiki/projects" or "raw/ai-conversations/claude"',
      },
    },
    required: ['directory'],
  },
  async execute(input, context) {
    const directory = input.directory as string;
    try {
      const files = await context.vault.listMarkdownFiles(directory);
      if (files.length === 0) return 'No markdown files found.';
      return files.join('\n');
    } catch {
      return `Directory not found or empty: ${directory}`;
    }
  },
};
