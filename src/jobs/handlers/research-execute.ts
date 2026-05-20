// D3: Research-execute handler. Fires only after explicit user approval —
// either via parse-slack-reply, a queue edit, or the MCP `approve_research` tool.

import { z } from 'zod';
import type { JobHandler } from '../types.js';
import { executeResearch } from '../../intelligence/research-execute.js';
import { createWebSearchFromConfig } from '../../intelligence/web-search.js';

const Payload = z
  .object({
    slug: z.string(),
    depth: z.enum(['light', 'medium', 'heavy']),
    notePath: z.string().optional(),
  })
  .passthrough();

export const researchExecuteHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    await executeResearch(
      { vault: ctx.vault, llm: ctx.llm, config: ctx.config },
      payload.slug,
      { depth: payload.depth, notePath: payload.notePath, search: createWebSearchFromConfig(ctx.config) },
    );
  },
};
