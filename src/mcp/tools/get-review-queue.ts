import { listReviewItems } from '../../review/review-queue.js';
import type { MCPContext } from '../context.js';

export const definition = {
  name: 'get_review_queue',
  description: 'List items pending human review (contradictions, duplicates). Returns review items with status.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export async function handle(_args: Record<string, unknown>, ctx: MCPContext) {
  const items = await listReviewItems(ctx.vault);

  if (items.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Review queue is empty.' }] };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
  };
}
