import type { JobHandler, Job, JobContext } from '../types.js';
import { rebuildWikiIndex } from '../../maintenance/indexes.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const rebuildIndexHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    await rebuildWikiIndex(context.vault, layoutFromConfig(context.config));
  },
};
