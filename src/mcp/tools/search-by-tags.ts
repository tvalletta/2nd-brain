import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  tags: z
    .array(z.string())
    .min(1)
    .describe('Tags to search for (matches against aliases, links, and tags fields)'),
  match_all: z
    .boolean()
    .default(false)
    .describe('If true, notes must match ALL tags (AND). Default false (OR).'),
  limit: z.number().int().positive().default(20).describe('Max results to return'),
});

export const definition = {
  name: 'search_by_tags',
  description:
    'Search notes by tags, aliases, or link references. Matches against the aliases, links, and tags frontmatter fields.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Tags to search for',
      },
      match_all: {
        type: 'boolean' as const,
        description: 'If true, match ALL tags (AND). Default: false (OR)',
      },
      limit: { type: 'number' as const, description: 'Max results (default 20)' },
    },
    required: ['tags'] as const,
  },
};

interface TagSearchResult {
  path: string;
  title: string;
  type: string;
  matched_tags: string[];
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const tagsLower = input.tags.map((t) => t.toLowerCase());

  const { allWikiFolders } = await import('../../vault/paths.js');
  const folders = allWikiFolders(ctx.config.layout);

  const results: TagSearchResult[] = [];

  for (const folder of folders) {
    if (results.length >= input.limit) break;

    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      if (results.length >= input.limit) break;

      let raw: string;
      try {
        raw = await ctx.vault.read(file);
      } catch {
        continue;
      }

      const { data } = parseNote(raw);

      // Collect all tag-like fields into a flat array
      const noteTagFields: string[] = [];
      for (const field of ['aliases', 'links', 'tags']) {
        const value = data[field];
        if (Array.isArray(value)) {
          noteTagFields.push(...value.map((v: unknown) => String(v).toLowerCase()));
        }
      }

      // Match
      const matched = tagsLower.filter((tag) =>
        noteTagFields.some((field) => field.includes(tag)),
      );

      const isMatch = input.match_all
        ? matched.length === tagsLower.length
        : matched.length > 0;

      if (isMatch) {
        results.push({
          path: file,
          title: (data.title as string) ?? file,
          type: (data.type as string) ?? 'unknown',
          matched_tags: matched,
        });
      }
    }
  }

  if (results.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No notes found matching tags: ${input.tags.join(', ')}` }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
  };
}
