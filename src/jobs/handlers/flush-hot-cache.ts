import { join } from 'node:path';
import type { JobHandler, Job, JobContext } from '../types.js';
import { createHotCacheManager } from '../../session/hot-cache.js';

export const flushHotCacheHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const claudeMdPath = join(context.vaultPath, 'CLAUDE.md');
    const cache = createHotCacheManager(claudeMdPath);
    await cache.flush();
  },
};
