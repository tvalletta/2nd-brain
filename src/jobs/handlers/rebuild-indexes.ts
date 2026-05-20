import type { JobHandler, Job, JobContext } from '../types.js';
import { rebuildAllIndexes } from '../../maintenance/indexes.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:rebuild-indexes');

export const rebuildIndexesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    log.info('Rebuilding all indexes');

    const totalEntries = await rebuildAllIndexes(context.vault, layoutFromConfig(context.config));

    log.info('All indexes rebuilt', { totalEntries });
  },
};
