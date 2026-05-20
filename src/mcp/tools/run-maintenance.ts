import type { MCPContext } from '../context.js';

export const definition = {
  name: 'run_maintenance',
  description:
    'Run deterministic maintenance: update backlinks and rebuild wiki index. Call after write operations to keep the vault consistent.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export async function handle(_args: Record<string, unknown>, ctx: MCPContext) {
  const processed = await ctx.runDeterministicJobs();
  return {
    content: [{ type: 'text' as const, text: `Maintenance complete. ${processed} job(s) processed.` }],
  };
}
