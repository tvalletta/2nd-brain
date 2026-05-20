import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import type { MCPContext } from '../context.js';

const DetailLevel = z.enum(['metadata', 'summary', 'full']).default('summary');

const InputSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe('Vault-relative paths of notes to read (max 20)'),
  detail: DetailLevel.describe('Detail level: "metadata" (frontmatter only), "summary" (frontmatter + first 200 chars), "full" (everything)'),
});

export const definition = {
  name: 'batch_get_notes',
  description:
    'Read multiple notes in a single call. Use detail levels to control token cost: "metadata" for frontmatter only, "summary" for frontmatter + excerpt, "full" for everything.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      paths: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Vault-relative paths (max 20)',
      },
      detail: {
        type: 'string' as const,
        enum: ['metadata', 'summary', 'full'],
        description: 'Detail level (default: summary)',
      },
    },
    required: ['paths'] as const,
  },
};

interface NoteResult {
  path: string;
  frontmatter: Record<string, unknown>;
  body?: string;
  excerpt?: string;
  error?: string;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const results: NoteResult[] = [];

  for (const path of input.paths) {
    try {
      const raw = await ctx.vault.read(path);
      const { data, body } = parseNote(raw);

      const result: NoteResult = { path, frontmatter: data };

      if (input.detail === 'full') {
        result.body = body;
      } else if (input.detail === 'summary') {
        // Use prompt_summary for session notes, otherwise first 200 chars of body
        const summary = (data.prompt_summary as string) || (data.outcome_summary as string);
        if (summary) {
          result.excerpt = summary.slice(0, 200);
        } else {
          // Strip headings and get first meaningful content
          const stripped = body.replace(/^#{1,6}\s.*$/gm, '').trim();
          result.excerpt = stripped.slice(0, 200) + (stripped.length > 200 ? '...' : '');
        }
      }
      // metadata: frontmatter only, no body or excerpt

      results.push(result);
    } catch (err) {
      results.push({
        path,
        frontmatter: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
  };
}
