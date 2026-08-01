// Sub-project C — MCP path for archive-queue resolution (G3, G4). Mirrors
// reconcile-entities.ts's read/apply-decision shape.
//
// Without arguments: returns pending queue entries (up to 10).
// With { id, decision, supersededByPath? }: applies the decision via
// applyArchiveDecision (archive/supersede mutate the target note; keep/skip
// only touch the queue).

import { z } from 'zod';
import type { MCPContext } from '../context.js';
import {
  readArchiveQueue,
  pendingArchiveEntries,
  applyArchiveDecision,
} from '../../maintenance/archive-queue.js';
import { layoutFromConfig } from '../../vault/paths.js';

const MAX_ENTRIES_RETURNED = 10;

const InputSchema = z.object({
  id: z.string().optional(),
  decision: z.enum(['archive', 'keep', 'supersede', 'skip']).optional(),
  supersededByPath: z.string().optional(),
}).strict();

export const definition = {
  name: 'resolve_archive_candidate',
  description:
    'Manage the archive queue (rot-scan candidates awaiting human review). Call with no arguments ' +
    'to see up to 10 pending candidates. Call with { id, decision } to apply a decision: "archive" ' +
    'flips status to archived (and project_status for project pages); "supersede" archives the note ' +
    'and records supersededByPath in its superseded_by list (supersededByPath required, must exist); ' +
    '"keep" dismisses the candidate without changing the note; "skip" hides it from future archivist ' +
    'runs. Run karpathy archivist for an interactive walkthrough.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' as const, description: 'Entry id to resolve' },
      decision: {
        type: 'string' as const,
        enum: ['archive', 'keep', 'supersede', 'skip'],
        description: 'Resolution decision',
      },
      supersededByPath: {
        type: 'string' as const,
        description: 'Replacement note path (required when decision is "supersede")',
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
    const queue = await readArchiveQueue(ctx.vault, layout);
    const pending = pendingArchiveEntries(queue).slice(0, MAX_ENTRIES_RETURNED);
    if (pending.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Archive queue is empty — no pending candidates.' }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ pending: pending.length, total: queue.entries.length, entries: pending }, null, 2),
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

  if (input.decision === 'supersede' && !input.supersededByPath) {
    return {
      content: [{ type: 'text' as const, text: 'supersededByPath is required when decision is "supersede"' }],
      isError: true,
    };
  }

  const queue = await readArchiveQueue(ctx.vault, layout);
  const entry = queue.entries.find((e) => e.id === input.id);
  if (!entry) {
    return {
      content: [{ type: 'text' as const, text: `Entry not found: ${input.id}` }],
      isError: true,
    };
  }

  if (input.decision === 'supersede' && !(await ctx.vault.exists(input.supersededByPath!))) {
    return {
      content: [{ type: 'text' as const, text: `Replacement path does not exist: ${input.supersededByPath}` }],
      isError: true,
    };
  }

  const resolved = await applyArchiveDecision(ctx.vault, entry, input.decision, input.supersededByPath, layout);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ message: `Entry marked as ${input.decision}`, entry: resolved }, null, 2),
    }],
  };
}
