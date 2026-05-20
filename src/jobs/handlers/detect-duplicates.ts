import type { JobHandler, Job, JobContext } from '../types.js';
import { detectDuplicates, writeDuplicateReview } from '../../review/duplicate-detector.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-duplicates');

export const detectDuplicatesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectDuplicates(context.vault);

    for (const candidate of candidates) {
      await writeDuplicateReview(context.vault, candidate);
    }

    log.info('Duplicate detection complete', { found: candidates.length });
  },
};
