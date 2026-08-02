// B2b: Glossary threshold synthesis.
//
// Fires when a concept's mention count crosses
// `intelligence.richness.glossarySynthesisThreshold` (see compile-entities.ts).
// Budget-gated on the `fast` tier — this is a short, single-paragraph
// rollup, not a full evidence-grounded refresh like topic-refresh.

import type { JobHandler } from '../types.js';
import { createLLMFromConfig } from '../../enrichment/llm-factory.js';
import { createBudgetTrackerFromConfig } from '../../shared/budget.js';
import { resolveStateDir } from '../../config/defaults.js';
import { synthesizeConceptEntry } from '../../maintenance/concept-glossary.js';
import { TransientLLMError } from '../../shared/errors.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('glossary-synthesize');

export const glossarySynthesizeHandler: JobHandler = {
  async execute(job, ctx) {
    const conceptName = job.payload.conceptName as string | undefined;
    if (!conceptName) {
      log.warn('glossary-synthesize: missing conceptName');
      return;
    }
    if (!ctx.config.intelligence.richness.enabled) return;

    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!(await budget.tryReserve('fast'))) {
      log.info('glossary-synthesize skipped: fast-tier budget exhausted', { conceptName });
      return; // no queue to preserve — next ingest that grows this concept re-fires the gate naturally
    }

    const stateDir = resolveStateDir(ctx.config);
    const llm = createLLMFromConfig(ctx.config, stateDir, 'fast');
    try {
      await synthesizeConceptEntry(ctx.vault, ctx.config.layout, conceptName, llm);
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      log.warn('glossary-synthesize failed', { conceptName, error: (err as Error).message });
    }
  },
};
