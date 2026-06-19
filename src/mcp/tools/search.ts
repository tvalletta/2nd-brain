// Unified hybrid search MCP tool.
//
// Combines FTS5 BM25 keyword search (covers 100% of the vault) with the
// configured embedding provider's semantic pool via Reciprocal Rank Fusion +
// recency weighting. Accepts either a free-text `query` or a vault note `path`
// as the query anchor (the path's title + tldr + body[:800] becomes the query).
//
// Replaces `search_vault` and `get_related` — both remain registered with
// deprecated descriptions so existing callers keep working through one major
// version.

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import { parseNote } from '../../vault/frontmatter.js';
import { openHybridStoreFromConfig } from '../../search/factory.js';

const NoteType = z.enum([
  'source_summary', 'session_summary', 'entity', 'project',
  'decision', 'concept', 'contradiction', 'index',
]);

const InputSchema = z.object({
  query: z.string().optional(),
  path: z.string().optional(),
  note_type: NoteType.optional(),
  scope: z.enum(['vault', 'this-week', 'project']).default('vault'),
  projectSlug: z.string().optional(),
  limit: z.number().int().positive().max(50).default(10),
  detail: z.enum(['metadata', 'summary', 'full']).default('summary'),
});

export const definition = {
  name: 'search',
  description:
    'Hybrid keyword + semantic search across all vault notes. Combines SQLite FTS5 BM25 full-text search ' +
    '(covers all 22k+ notes) with semantic embeddings (Ollama by default — fully local) for conceptual matches. ' +
    'Degrades gracefully to keyword-only when the embedding provider is unavailable. ' +
    'Accepts a text `query` or a vault note `path` (finds notes similar to the anchor). ' +
    'Replaces `search_vault` and `get_related`.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' as const, description: 'Free-text query. Required if `path` is not provided.' },
      path: { type: 'string' as const, description: 'Vault-relative note path. Finds notes similar to this anchor.' },
      note_type: {
        type: 'string' as const,
        enum: [
          'source_summary', 'session_summary', 'entity', 'project',
          'decision', 'concept', 'contradiction', 'index',
        ],
        description: 'Filter by note type',
      },
      scope: {
        type: 'string' as const,
        enum: ['vault', 'this-week', 'project'],
        description: 'Restrict results: "vault" (all), "this-week" (updated <=7d), or "project" (requires projectSlug).',
      },
      projectSlug: { type: 'string' as const, description: 'Required when scope = "project".' },
      limit: { type: 'number' as const, description: 'Max results (default 10, max 50)' },
      detail: {
        type: 'string' as const,
        enum: ['metadata', 'summary', 'full'],
        description: 'Detail level: "metadata" (frontmatter), "summary" (excerpt, default), "full" (body+frontmatter).',
      },
    },
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  if (!input.query && !input.path) {
    return {
      content: [{ type: 'text' as const, text: 'Provide either `query` or `path`.' }],
      isError: true,
    };
  }
  if (input.scope === 'project' && !input.projectSlug) {
    return {
      content: [{ type: 'text' as const, text: 'projectSlug is required when scope = "project".' }],
      isError: true,
    };
  }

  let queryText = input.query ?? '';
  let anchorPath: string | undefined;

  if (!queryText && input.path) {
    if (!(await ctx.vault.exists(input.path))) {
      return {
        content: [{ type: 'text' as const, text: `Note not found: ${input.path}` }],
        isError: true,
      };
    }
    const raw = await ctx.vault.read(input.path);
    const { data, body } = parseNote(raw);
    const fm = data as Record<string, unknown>;
    const title = typeof fm.title === 'string' ? fm.title : '';
    const tldr = typeof fm.tldr === 'string' ? fm.tldr : '';
    queryText = [title, tldr, body.slice(0, 800)].filter(Boolean).join('\n');
    anchorPath = input.path;
  }

  const projectRoot = ctx.config.projectRoot ?? process.cwd();
  const store = openHybridStoreFromConfig(ctx.config, projectRoot);
  try {
    const result = await store.search(queryText, {
      topK: input.limit,
      scope: input.scope,
      projectSlug: input.projectSlug,
      noteType: input.note_type,
    });

    const filtered = anchorPath ? result.hits.filter((h) => h.docId !== anchorPath) : result.hits;

    const results = await Promise.all(
      filtered.map(async (h) => {
        const item: Record<string, unknown> = {
          path: h.docId,
          title: typeof h.metadata.title === 'string' ? h.metadata.title : h.docId,
          type: typeof h.metadata.type === 'string' ? h.metadata.type : 'unknown',
          excerpt: h.excerpt,
          updated_at: h.updated_at,
          scores: {
            rrf: round(h.scores.rrf),
            recency: round(h.scores.recency),
            final: round(h.scores.final),
            ...(h.scores.keywordRank !== undefined && { keyword_rank: h.scores.keywordRank }),
            ...(h.scores.semanticSim !== undefined && { semantic_sim: round(h.scores.semanticSim) }),
          },
        };

        if (input.detail === 'metadata' || input.detail === 'full') {
          try {
            const raw = await ctx.vault.read(h.docId);
            const { data, body } = parseNote(raw);
            item.frontmatter = data;
            if (input.detail === 'full') item.body = body;
          } catch {
            /* skip — note may have been deleted between index and read */
          }
        }
        return item;
      }),
    );

    const payload: Record<string, unknown> = {
      search_mode: result.searchMode,
      results,
    };
    if (result.degradationNote) payload.degradation_note = result.degradationNote;

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...payload,
                hint: 'Try broadening the query, removing scope filters, or running `karpathy maintenance --populate-fts` if the FTS index is empty.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    };
  } finally {
    store.close();
  }
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
