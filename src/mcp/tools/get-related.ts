// B3: Always-on related notes.
//
// Given a note path or free-text query, return semantically-related notes
// ranked by `α · sim + β · recency` (B4). The MCP host (Claude Code, Cursor)
// can call this tool freely during a session to keep relevant priors in
// context.

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import { parseNote } from '../../vault/frontmatter.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import { retrieve } from '../../intelligence/retrieval.js';

const InputSchema = z.object({
  path: z.string().optional().describe('Vault-relative path to use as the query anchor'),
  query: z.string().optional().describe('Free-text query (used if path is omitted)'),
  topK: z.number().int().positive().max(50).default(5),
  scope: z.enum(['vault', 'this-week', 'project']).default('vault'),
  projectSlug: z.string().optional(),
});

export const definition = {
  name: 'get_related',
  description:
    'Semantic similarity search using Bedrock-Titan embeddings with recency boost (α·similarity + β·recency). ' +
    'Best for conceptual/thematic queries where keywords miss the point. ' +
    'Requires active AWS credentials — returns a clear message and suggests search_vault as fallback when credentials are expired. ' +
    'Provide either a vault note path (uses its title + body as query) or a free-text query.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, description: 'Vault-relative path (e.g. "wiki/concepts/fsrs.md")' },
      query: { type: 'string' as const, description: 'Free-text query (alternative to path)' },
      topK: { type: 'number' as const, description: 'Max results (default 5, max 50)' },
      scope: {
        type: 'string' as const,
        enum: ['vault', 'this-week', 'project'],
        description: 'Restrict the search pool',
      },
      projectSlug: { type: 'string' as const, description: 'Required when scope = "project"' },
    },
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  if (!input.path && !input.query) {
    return {
      content: [{ type: 'text' as const, text: 'Provide either `path` or `query`.' }],
      isError: true,
    };
  }

  const projectRoot = ctx.config.projectRoot ?? process.cwd();
  const store = openStoreFromConfig(ctx.config, projectRoot);
  try {
    let queryText = input.query ?? '';
    if (!queryText && input.path) {
      const raw = await ctx.vault.read(input.path);
      const { data, body } = parseNote(raw);
      const fm = data as Record<string, unknown>;
      const tldr = typeof fm.tldr === 'string' ? fm.tldr : '';
      const title = typeof fm.title === 'string' ? fm.title : '';
      queryText = [title, tldr, body.slice(0, 800)].filter(Boolean).join('\n');
    }

    const oneWeekAgo = Date.now() - 7 * 86400_000;
    const filter = (() => {
      if (input.scope === 'this-week') {
        return (h: { updated_at: string }) => new Date(h.updated_at).getTime() >= oneWeekAgo;
      }
      if (input.scope === 'project') {
        const slug = input.projectSlug;
        if (!slug) return undefined;
        return (h: { metadata: Record<string, unknown> }) => h.metadata.project_slug === slug;
      }
      return undefined;
    })();

    let hits;
    try {
      hits = await retrieve({ store, config: ctx.config }, queryText, {
        topK: input.topK,
        filter,
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isCredentialError =
        msg.includes('credentials') ||
        msg.includes('ExpiredToken') ||
        msg.includes('UnrecognizedClient') ||
        msg.includes('AccessDenied');
      if (isCredentialError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Semantic search unavailable: AWS credentials expired or missing. Use `search_vault` for keyword search instead.',
            },
          ],
        };
      }
      throw err;
    }

    // Don't return the anchor doc itself.
    const anchorPath = input.path;
    const filtered = anchorPath ? hits.filter((h) => h.doc_id !== anchorPath) : hits;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            filtered.map((h) => ({
              path: h.doc_id,
              chunk_index: h.chunk_index,
              text: h.text.slice(0, 400),
              metadata: h.metadata,
              updated_at: h.updated_at,
              scores: {
                rerank: Number(h.rerankScore.toFixed(4)),
                recency: Number(h.recencyScore.toFixed(4)),
                final: Number(h.finalScore.toFixed(4)),
              },
            })),
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    store.close();
  }
}
