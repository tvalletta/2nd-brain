// B2: Topic-refresh job handler.
//
// Phase 1: budget-gated. Reserves one `medium`-tier LLM call before invoking
// `refreshTopic`. If the daily budget is exhausted, the job is skipped (and
// will be picked up again the next time the threshold gate fires — usually
// after the day rolls over). The pending_evidence queue is left intact, so
// no information is lost when we defer.

import type { JobHandler } from '../types.js';
import { refreshTopic } from '../../intelligence/topic-refresh.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import { createBudgetTrackerFromConfig } from '../../shared/budget.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('topic-refresh');

export const topicRefreshHandler: JobHandler = {
  async execute(job, ctx) {
    if (!job.targetPath) {
      log.warn('topic-refresh job missing targetPath');
      return;
    }

    // Reserve from the daily budget. On refusal, log + return — the linker's
    // mark-dirty trail is preserved so the next ingest will retry the gate.
    const budget = createBudgetTrackerFromConfig(ctx.config, ctx.projectRoot);
    if (!budget.tryReserve('medium')) {
      log.info('topic-refresh skipped: daily medium-tier budget exhausted', {
        notePath: job.targetPath,
        remaining: budget.remaining('medium'),
      });
      return;
    }

    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      await refreshTopic(
        { vault: ctx.vault, llm: ctx.llm, store, config: ctx.config },
        job.targetPath,
      );
    } finally {
      store.close();
    }
  },
};
