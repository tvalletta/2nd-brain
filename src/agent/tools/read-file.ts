import type { AgentToolDef } from '../tool-registry.js';

export const readFileTool: AgentToolDef = {
  name: 'read_file',
  description: 'Read the contents of a file in the vault. Returns the full text content.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Vault-relative path to the file, e.g. "wiki/projects/auth-redesign/_index.md"',
      },
    },
    required: ['path'],
  },
  async execute(input, context) {
    const path = input.path as string;
    if (!(await context.vault.exists(path))) {
      return `File not found: ${path}`;
    }
    return context.vault.read(path);
  },
};
