import type { MCPContext } from '../context.js';

export const definition = {
  name: 'get_hot_cache',
  description:
    'Read the active context from CLAUDE.md — recent sessions, key entities, and quick links. Call this early in a conversation to understand recent work.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export async function handle(_args: Record<string, unknown>, ctx: MCPContext) {
  const content = await ctx.hotCache.toContext();
  return {
    content: [{ type: 'text' as const, text: content || 'Hot cache is empty. No sessions captured yet.' }],
  };
}
