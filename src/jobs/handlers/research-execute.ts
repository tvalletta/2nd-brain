// D3: Research-execute handler. Fires only after explicit user approval —
// either via parse-slack-reply, a queue edit, or the MCP `approve_research` tool.
//
// G2: budget-gated and tier-aware, matching the pattern established by
// topic-refresh.ts / glossary-synthesize.ts. `depth` maps to an LLM tier
// (light → fast, medium → medium, heavy → heavy); one call is reserved from
// the daily budget before any real work happens, and — when granted — a
// fresh client for that tier is constructed via createLLMFromConfig instead
// of always using ctx.llm's default tier.

import { z } from 'zod';
import type { JobHandler } from '../types.js';
import { executeResearch } from '../../intelligence/research-execute.js';
import { createWebSearchFromConfig } from '../../intelligence/web-search.js';
import { createBudgetTrackerFromConfig, type BudgetTier } from '../../shared/budget.js';
import { createLLMFromConfig } from '../../enrichment/llm-factory.js';
import { resolveStateDir } from '../../config/defaults.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('research-execute');

const Payload = z
  .object({
    slug: z.string(),
    depth: z.enum(['light', 'medium', 'heavy']),
    notePath: z.string().optional(),
  })
  .passthrough();

const DEPTH_TO_TIER: Record<'light' | 'medium' | 'heavy', BudgetTier> = {
  light: 'fast',
  medium: 'medium',
  heavy: 'heavy',
};

export const researchExecuteHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    const tier = DEPTH_TO_TIER[payload.depth];

    // G2: reserve one call from the daily budget before doing any real work.
    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!(await budget.tryReserve(tier))) {
      log.info('research-execute skipped: daily budget exhausted', {
        slug: payload.slug,
        depth: payload.depth,
        tier,
        remaining: budget.remaining(tier),
      });
      return; // queue row stays pending+decided; next drain cycle (or manual CLI) retries
    }

    // G2: tier-appropriate model instead of always using ctx.llm's default tier.
    const stateDir = resolveStateDir(ctx.config);
    const llm = createLLMFromConfig(ctx.config, stateDir, tier);

    await executeResearch(
      { vault: ctx.vault, llm, config: ctx.config },
      payload.slug,
      { depth: payload.depth, notePath: payload.notePath, search: createWebSearchFromConfig(ctx.config) },
    );
  },
};
