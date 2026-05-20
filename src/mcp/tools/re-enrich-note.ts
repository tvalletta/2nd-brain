// §23.2 — Re-enrichment of existing wiki notes via MCP.
//
// Enqueues a `re-enrich-note` job for the given note path and drains the
// queue. Returns a summary of what was processed.

import { z } from 'zod';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  notePath: z.string().describe('Vault-relative path to the wiki note to re-enrich'),
});

export const definition = {
  name: 're_enrich_note',
  description:
    'Re-run entity extraction and concept-linking on an existing wiki note. ' +
    'Use this after manually adding content to a note outside its protected regions. ' +
    'The job strips machine-managed regions, extracts entities from your human-authored ' +
    'text, links related concept pages, and updates backlinks. Protected regions are never overwritten.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      notePath: {
        type: 'string' as const,
        description: 'Vault-relative path to the wiki note (e.g. "wiki/entities/people/alice.md")',
      },
    },
    required: ['notePath'] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  if (!(await ctx.vault.exists(input.notePath))) {
    return {
      content: [{
        type: 'text' as const,
        text: `Note not found: ${input.notePath}`,
      }],
      isError: true,
    };
  }

  await ctx.enqueueJob({
    type: 're-enrich-note',
    targetPath: input.notePath,
    payload: { notePath: input.notePath },
    trigger: 'cli',
    priority: 55,
    dedupeKey: `re-enrich:${input.notePath}`,
  });

  const processed = await ctx.runDeterministicJobs();

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        message: `Re-enrichment complete for ${input.notePath}`,
        jobsProcessed: processed,
      }, null, 2),
    }],
  };
}
