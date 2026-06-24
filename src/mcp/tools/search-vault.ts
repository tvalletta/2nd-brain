import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import type { MCPContext } from '../context.js';

const DetailLevel = z.enum(['metadata', 'summary', 'full']).default('summary');

const InputSchema = z.object({
  query: z.string().describe('Search term to match against note titles and content'),
  note_type: z
    .enum([
      'source_summary', 'session_summary', 'entity', 'project',
      'decision', 'concept', 'contradiction', 'index',
    ])
    .optional()
    .describe('Filter by note type'),
  folder: z.string().optional().describe('Limit search to a specific vault folder (e.g. "wiki/entities")'),
  scope: z
    .enum(['vault', 'this-week', 'project'])
    .default('vault')
    .describe('Restrict results: "this-week" (updated in last 7d), "project" (requires projectSlug), or full "vault"'),
  projectSlug: z.string().optional().describe('Required when scope = "project"'),
  limit: z.number().int().positive().default(20).describe('Max results to return'),
  detail: DetailLevel.describe('Detail level: "metadata", "summary" (default — includes excerpt), "full" (includes full body)'),
});

export const definition = {
  name: 'search_vault',
  description:
    'Deprecated — use `search` instead. Will be removed in the next major version. ' +
    '(Legacy: full-text keyword search with stemming across all vault notes. Ranking: title exact > title contains > title term hits > heading hits > body frequency.)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Search term to match against note titles and content' },
      note_type: {
        type: 'string' as const,
        enum: [
          'source_summary', 'session_summary', 'entity', 'project',
          'decision', 'concept', 'contradiction', 'index',
        ],
        description: 'Filter by note type',
      },
      folder: { type: 'string' as const, description: 'Limit search to a specific vault folder' },
      scope: {
        type: 'string' as const,
        enum: ['vault', 'this-week', 'project'],
        description: 'Restrict results',
      },
      projectSlug: { type: 'string' as const, description: 'Required when scope = "project"' },
      limit: { type: 'number' as const, description: 'Max results to return (default 20)' },
      detail: {
        type: 'string' as const,
        enum: ['metadata', 'summary', 'full'],
        description: 'Detail level (default: summary)',
      },
    },
    required: ['query'] as const,
  },
};

interface ScoredResult {
  path: string;
  title: string;
  type: string;
  score: number;
  excerpt: string;
  updated_at: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
}

/** Prefix/stem matching: exact, or shares prefix of length max(4, floor(term.length * 0.75)). */
function matchesTerm(text: string, term: string): boolean {
  if (text.includes(term)) return true;
  if (term.length >= 5) {
    const prefix = term.slice(0, Math.max(4, Math.floor(term.length * 0.75)));
    return text.includes(prefix);
  }
  return false;
}

function scoreMatch(query: string, title: string, body: string): { score: number; excerpt: string } {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const fullText = `${titleLower}\n${bodyLower}`;

  // Require all terms to match (with stem/prefix fallback for longer words)
  const allTermsPresent = queryTerms.every((term) => matchesTerm(fullText, term));
  if (!allTermsPresent) return { score: 0, excerpt: '' };

  let score = 0;

  // Title exact match (highest)
  if (titleLower === queryLower) {
    score += 100;
  } else if (titleLower.includes(queryLower)) {
    // Title contains full query
    score += 80;
  } else {
    // Title contains individual terms
    const titleTermHits = queryTerms.filter((t) => titleLower.includes(t)).length;
    score += titleTermHits * 20;
  }

  // Heading matches
  const headings = body.match(/^#{1,6}\s.+$/gm) ?? [];
  const headingText = headings.join(' ').toLowerCase();
  if (headingText.includes(queryLower)) {
    score += 30;
  } else {
    const headingTermHits = queryTerms.filter((t) => headingText.includes(t)).length;
    score += headingTermHits * 10;
  }

  // Body match — term density
  for (const term of queryTerms) {
    const count = bodyLower.split(term).length - 1;
    score += Math.min(count, 5) * 2; // Cap at 5 occurrences per term
  }

  // Extract excerpt around the first match
  const idx = fullText.indexOf(queryTerms[0]);
  const start = Math.max(0, idx - 80);
  const end = Math.min(fullText.length, idx + queryTerms[0].length + 80);
  const excerpt = (start > 0 ? '...' : '') + fullText.slice(start, end).trim() + (end < fullText.length ? '...' : '');

  return { score, excerpt };
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  const layout = ctx.config.layout;
  const folders = input.folder
    ? [input.folder]
    : [layout.wiki, layout.aiSummaries, layout.sources, layout.review];

  const candidates: ScoredResult[] = [];

  for (const folder of folders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      // Skip category-level index files — they're directory listings, not content
      if (file.endsWith('/_index.md')) continue;

      let raw: string;
      try {
        raw = await ctx.vault.read(file);
      } catch {
        continue;
      }

      const { data, body } = parseNote(raw);
      const title = (data.title as string) ?? file;
      const type = (data.type as string) ?? 'unknown';
      const updatedAt = (data.updated_at as string) ?? '';

      if (input.note_type && type !== input.note_type) continue;

      // Scope filtering (E3).
      if (input.scope === 'this-week') {
        const ts = updatedAt ? new Date(updatedAt).getTime() : 0;
        if (!ts || Date.now() - ts > 7 * 86400_000) continue;
      } else if (input.scope === 'project') {
        const slug = input.projectSlug;
        if (!slug) continue;
        const projectSlug = (data.project_slug as string | undefined) ?? '';
        if (projectSlug !== slug) continue;
      }

      const { score, excerpt } = scoreMatch(input.query, title, body);
      if (score === 0) continue;

      const result: ScoredResult = { path: file, title, type, score, excerpt, updated_at: updatedAt };

      if (input.detail === 'full') {
        result.body = body;
        result.frontmatter = data;
      } else if (input.detail === 'metadata') {
        result.frontmatter = data;
      }
      // summary: excerpt is already included

      candidates.push(result);
    }
  }

  // Sort by score descending, then by updated_at as tiebreaker
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updated_at.localeCompare(a.updated_at);
  });

  const results = candidates.slice(0, input.limit);

  if (results.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No results found for "${input.query}"` }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
  };
}
