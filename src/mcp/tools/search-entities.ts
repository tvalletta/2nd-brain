import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import type { MCPContext } from '../context.js';

function entityFolders(layout: { wiki: string }): Record<string, string> {
  return {
    person: `${layout.wiki}/entities`,
    org: `${layout.wiki}/entities`,
    tool: `${layout.wiki}/entities`,
    project: `${layout.wiki}/projects`,
    concept: `${layout.wiki}/concepts`,
    decision: `${layout.wiki}/decisions`,
  };
}

const InputSchema = z.object({
  kind: z
    .enum(['person', 'org', 'tool', 'project', 'concept', 'decision'])
    .optional()
    .describe('Filter by entity kind'),
  query: z.string().optional().describe('Search term to match against entity titles and content'),
  limit: z.number().int().positive().default(20),
});

export const definition = {
  name: 'search_entities',
  description: 'Ranked keyword search across entity notes (people, orgs, tools, projects, concepts, decisions). Filter by kind to narrow the search space. Results sorted by relevance: title exact match > title contains > term hits > body frequency. Excludes _index.md category files. Use get_entity for direct lookup of a known name.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string' as const,
        enum: ['person', 'org', 'tool', 'project', 'concept', 'decision'],
        description: 'Filter by entity kind',
      },
      query: { type: 'string' as const, description: 'Search term' },
      limit: { type: 'number' as const, description: 'Max results (default 20)' },
    },
  },
};

interface EntityResult {
  path: string;
  title: string;
  type: string;
  entity_kind?: string;
  status: string;
  score: number;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const queryLower = input.query?.toLowerCase();

  const folderMap = entityFolders(ctx.config.layout);
  const folders = input.kind
    ? [folderMap[input.kind]]
    : [...new Set(Object.values(folderMap))];

  const results: EntityResult[] = [];

  for (const folder of folders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      if (results.length >= input.limit * 3) break; // over-fetch before sort

      // Skip category-level index files
      if (file.endsWith('/_index.md')) continue;

      let raw: string;
      try {
        raw = await ctx.vault.read(file);
      } catch {
        continue;
      }

      const { data, body } = parseNote(raw);
      const title = (data.title as string) ?? file;
      const entityKind = data.entity_kind as string | undefined;
      const type = (data.type as string) ?? 'unknown';

      if (input.kind && entityKind && entityKind !== input.kind) continue;

      let score = 0;
      if (queryLower) {
        const titleLower = title.toLowerCase();
        const bodyLower = body.toLowerCase();
        if (titleLower === queryLower) {
          score = 100;
        } else if (titleLower.includes(queryLower)) {
          score = 80;
        } else {
          const terms = queryLower.split(/\s+/).filter(Boolean);
          const fullText = `${titleLower}\n${bodyLower}`;
          const matchedTerms = terms.filter((t) => fullText.includes(t)).length;
          if (matchedTerms === 0) continue;
          // Title term hits score higher than body hits
          const titleHits = terms.filter((t) => titleLower.includes(t)).length;
          score = titleHits * 20 + matchedTerms * 5;
          // Frequency in body
          for (const t of terms) {
            score += Math.min(bodyLower.split(t).length - 1, 5);
          }
        }
      } else {
        score = 1; // unfiltered, all equal
      }

      results.push({
        path: file,
        title,
        type,
        entity_kind: entityKind,
        status: (data.status as string) ?? 'draft',
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const trimmed = results.slice(0, input.limit);

  if (trimmed.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matching entities found.' }] };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(trimmed, null, 2) }],
  };
}
