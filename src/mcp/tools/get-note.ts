import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { slugify } from '../../vault/paths.js';
import type { MCPContext } from '../context.js';

const DetailLevel = z.enum(['metadata', 'summary', 'full']).default('full');

const InputSchema = z.object({
  path: z.string().optional().describe('Vault-relative path to the note'),
  title: z.string().optional().describe('Note title to search for'),
  detail: DetailLevel.describe('Detail level: "metadata" (frontmatter only), "summary" (frontmatter + excerpt), "full" (everything, default)'),
}).refine((d) => d.path || d.title, { message: 'Provide either path or title' });

export const definition = {
  name: 'get_note',
  description: 'Read a specific note by path or title. Use detail levels to control token cost: "metadata", "summary", or "full" (default).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, description: 'Vault-relative path to the note (e.g. "wiki/entities/alice-chen.md")' },
      title: { type: 'string' as const, description: 'Note title to search for' },
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
    const summary = (data.prompt_summary as string) || (data.outcome_summary as string);
    if (summary) {
      result.excerpt = summary.slice(0, 200);
    } else {
      const stripped = body.replace(/^#{1,6}\s.*$/gm, '').trim();
      result.excerpt = stripped.slice(0, 200) + (stripped.length > 200 ? '...' : '');
    }
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

  // Search by title
  const slug = slugify(input.title!);
  const { searchableFolders } = await import('../../vault/paths.js');
  const folders = searchableFolders(ctx.config.layout);

  for (const folder of folders) {
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
    content: [{ type: 'text' as const, text: `Note not found: "${input.title}"` }],
    isError: true,
  };
}
