import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { slugify } from '../../vault/paths.js';
import type { MCPContext } from '../context.js';

const DetailLevel = z.enum(['metadata', 'summary', 'full']).default('full');

const InputSchema = z.object({
  name: z.string().optional().describe('Entity name to search for'),
  path: z.string().optional().describe('Vault-relative path to the entity note'),
  detail: DetailLevel.describe('Detail level: "metadata" (frontmatter only), "summary" (frontmatter + excerpt), "full" (everything, default)'),
}).refine((d) => d.name || d.path, { message: 'Provide either name or path' });

export const definition = {
  name: 'get_entity',
  description: 'Fetch an entity note (person, project, concept, decision) by name or path. Use detail levels to control token cost.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, description: 'Entity name to search for' },
      path: { type: 'string' as const, description: 'Vault-relative path to the entity note' },
      detail: {
        type: 'string' as const,
        enum: ['metadata', 'summary', 'full'],
        description: 'Detail level (default: full)',
      },
    },
  },
};

function formatResult(path: string, data: Record<string, unknown>, body: string, detail: string) {
  const result: Record<string, unknown> = { path, frontmatter: data };

  if (detail === 'full') {
    result.body = body;
  } else if (detail === 'summary') {
    const stripped = body.replace(/^#{1,6}\s.*$/gm, '').trim();
    result.excerpt = stripped.slice(0, 200) + (stripped.length > 200 ? '...' : '');
  }
  // metadata: frontmatter only

  return result;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  if (input.path) {
    const raw = await ctx.vault.read(input.path);
    const { data, body } = parseNote(raw);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(formatResult(input.path, data, body, input.detail), null, 2) }],
    };
  }

  const slug = slugify(input.name!);
  const wiki = ctx.config.layout.wiki;
  const searchFolders = [`${wiki}/entities`, `${wiki}/projects`, `${wiki}/decisions`, `${wiki}/concepts`];

  for (const folder of searchFolders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      if (file.toLowerCase().includes(slug)) {
        const raw = await ctx.vault.read(file);
        const { data, body } = parseNote(raw);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatResult(file, data, body, input.detail), null, 2) }],
        };
      }
    }
  }

  return {
    content: [{ type: 'text' as const, text: `Entity not found: "${input.name}"` }],
    isError: true,
  };
}
