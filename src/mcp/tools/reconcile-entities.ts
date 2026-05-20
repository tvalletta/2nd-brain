// §22.3 — MCP path for curator reconciliation.
//
// Without arguments: returns pending queue entries (up to 10).
// With { id, decision, newName? }: applies the decision and, for merge/rename,
// runs mergeEntities + backlink/index rebuilds.

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readReconciliationQueue,
  resolveEntry,
  pendingEntries,
} from '../../maintenance/reconciliation-queue.js';
import {
  mergeEntities,
} from '../../compilation/entity-merger.js';
import { rebuildAllBacklinks } from '../../maintenance/backlinks.js';
import { rebuildAllIndexes } from '../../maintenance/indexes.js';
import { layoutFromConfig } from '../../vault/paths.js';

const MAX_ENTRIES_RETURNED = 10;

const InputSchema = z.object({
  id: z.string().optional(),
  decision: z.enum(['merge', 'rename', 'skip', 'manual']).optional(),
  newName: z.string().optional(),
}).strict();

export const definition = {
  name: 'reconcile_entities',
  description:
    'Manage the entity reconciliation queue. Call with no arguments to see up to 10 pending ' +
    'candidates (duplicate/variant entity pairs). Call with { id, decision } to apply a decision: ' +
    '"merge" merges source into target and rewrites backlinks; "rename" merges with a new canonical ' +
    'name; "skip" hides the entry from future curator runs; "manual" marks it resolved for manual handling. ' +
    'Run karpathy curator for an interactive walkthrough.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' as const, description: 'Entry id to resolve' },
      decision: {
        type: 'string' as const,
        enum: ['merge', 'rename', 'skip', 'manual'],
        description: 'Resolution decision',
      },
      newName: {
        type: 'string' as const,
        description: 'New canonical name (required when decision is "rename")',
      },
    },
    required: [] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const layout = layoutFromConfig(ctx.config);

  // -- Read-only: return pending entries -----------------------------------
  if (!input.id) {
    const queue = await readReconciliationQueue(ctx.vault, layout);
    const pending = pendingEntries(queue).slice(0, MAX_ENTRIES_RETURNED);
    if (pending.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Reconciliation queue is empty — no pending candidates.',
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          pending: pending.length,
          total: queue.entries.length,
          entries: pending,
        }, null, 2),
      }],
    };
  }

  // -- Apply a decision ----------------------------------------------------
  if (!input.decision) {
    return {
      content: [{ type: 'text' as const, text: 'decision is required when id is provided' }],
      isError: true,
    };
  }

  if (input.decision === 'rename' && !input.newName) {
    return {
      content: [{ type: 'text' as const, text: 'newName is required when decision is "rename"' }],
      isError: true,
    };
  }

  // For merge/rename, execute the merge before marking resolved.
  if (input.decision === 'merge' || input.decision === 'rename') {
    const queue = await readReconciliationQueue(ctx.vault, layout);
    const entry = queue.entries.find((e) => e.id === input.id);
    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: `Entry not found: ${input.id}` }],
        isError: true,
      };
    }

    // Validate both paths still exist.
    if (!(await ctx.vault.exists(entry.sourcePath))) {
      return {
        content: [{ type: 'text' as const, text: `Source path no longer exists: ${entry.sourcePath}` }],
        isError: true,
      };
    }
    if (!(await ctx.vault.exists(entry.targetPath))) {
      return {
        content: [{ type: 'text' as const, text: `Target path no longer exists: ${entry.targetPath}` }],
        isError: true,
      };
    }

    const mergeResult = await mergeEntities(entry.sourcePath, entry.targetPath, ctx.vault);
    await rebuildAllBacklinks(ctx.vault, layout);
    await rebuildAllIndexes(ctx.vault);

    const resolved = await resolveEntry(ctx.vault, input.id, input.decision, input.newName, layout);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: `Merged "${entry.sourceName}" → "${entry.targetName}"`,
          aliasesAdded: mergeResult.aliasesAdded,
          wikilinksRewritten: mergeResult.wikilinksRewritten,
          entry: resolved,
        }, null, 2),
      }],
    };
  }

  // skip / manual — just update the queue entry.
  const resolved = await resolveEntry(ctx.vault, input.id, input.decision, input.newName, layout);
  if (!resolved) {
    return {
      content: [{ type: 'text' as const, text: `Entry not found: ${input.id}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ message: `Entry marked as ${input.decision}`, entry: resolved }, null, 2),
    }],
  };
}
