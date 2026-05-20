import type { JobHandler, Job, JobContext } from '../types.js';
import { detectMergeCandidates } from '../../compilation/entity-merger.js';
import { refreshQueue } from '../../maintenance/reconciliation-queue.js';
import { createLogger } from '../../shared/logger.js';
import { layoutFromConfig } from '../../vault/paths.js';

const log = createLogger('handler:detect-entity-dupes');

export const detectEntityDupesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const layout = layoutFromConfig(context.config);
    const candidates = await detectMergeCandidates(context.vault);

    const added = await refreshQueue(context.vault, candidates, layout);

    log.info('Entity dupe detection complete', {
      detected: candidates.length,
      newlyQueued: added,
    });
  },
};
