import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { extractOutlinks, extractLinkContext } from '../../maintenance/backlinks.js';
import { slugify, wikiContentFolders } from '../../vault/paths.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  path: z.string().optional().describe('Vault-relative path of the note to find backlinks for'),
  title: z.string().optional().describe('Title of the note to find backlinks for'),
}).refine((d) => d.path || d.title, { message: 'Provide either path or title' });

export const definition = {
  name: 'get_backlinks',
  description:
    'Find all notes that link to a given note via [[wikilinks]]. Returns the linking note path, title, and surrounding context for each backlink.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, description: 'Vault-relative path of the target note' },
      title: { type: 'string' as const, description: 'Title of the target note' },
    },
  },
};

interface BacklinkResult {
  path: string;
  title: string;
  type: string;
  context: string;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  // Resolve the target note's slug (filename without extension)
  let targetSlug: string;
  if (input.path) {
    targetSlug = input.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  } else {
    targetSlug = slugify(input.title!);
  }

  if (!targetSlug) {
    return {
      content: [{ type: 'text' as const, text: 'Could not resolve target note.' }],
      isError: true,
    };
  }

  const results: BacklinkResult[] = [];
  const searchFolders = [...wikiContentFolders(ctx.config.layout), ctx.config.layout.aiSummaries];

  for (const folder of searchFolders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      let raw: string;
      try {
        raw = await ctx.vault.read(file);
      } catch {
        continue;
      }

      const { data, body } = parseNote(raw);
      const outlinks = extractOutlinks(body);

      // Check if any outlink matches our target slug
      const matchingLink = outlinks.find(
        (link) => link.toLowerCase() === targetSlug.toLowerCase() ||
          slugify(link) === targetSlug,
      );

      if (matchingLink) {
        const context = extractLinkContext(body, matchingLink);
        results.push({
          path: file,
          title: (data.title as string) ?? file,
          type: (data.type as string) ?? 'unknown',
          context,
        });
      }
    }
  }

  if (results.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No backlinks found for "${input.path ?? input.title}".` }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
  };
}
