// D2 alt: in-session approval. Lets a Claude session approve a research
// candidate at a chosen depth without round-tripping through Slack.

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readResearchQueue,
  writeResearchQueue,
} from '../../maintenance/research-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';

const InputSchema = z.object({
  slug: z.string(),
  depth: z.enum(['light', 'medium', 'heavy', 'skip']),
});

export const definition = {
  name: 'approve_research',
  description:
    'Approve a research candidate at the chosen depth (light/medium/heavy) or skip it. Updates the research queue.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      slug: { type: 'string' as const, description: 'Candidate slug from the queue' },
      depth: {
        type: 'string' as const,
        enum: ['light', 'medium', 'heavy', 'skip'],
        description: 'Research depth to authorize',
      },
    },
    required: ['slug', 'depth'],
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const layout = layoutFromConfig(ctx.config);
  const queue = await readResearchQueue(ctx.vault, layout);
  const candidate = queue.candidates.find((c) => c.slug === input.slug);
  if (!candidate) {
    return {
      content: [{ type: 'text' as const, text: `Slug not in queue: ${input.slug}` }],
      isError: true,
    };
  }
  candidate.decision = input.depth;
  await writeResearchQueue(ctx.vault, queue, layout);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ slug: input.slug, decision: input.depth, status: candidate.status }, null, 2),
      },
    ],
  };
}
