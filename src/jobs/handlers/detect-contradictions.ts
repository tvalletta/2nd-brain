import type { JobHandler, Job, JobContext } from '../types.js';
import { detectContradictions, writeContradictionReview } from '../../review/contradiction-detector.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-contradictions');

export const detectContradictionsHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectContradictions(context.vault);

    for (const candidate of candidates) {
      await writeContradictionReview(context.vault, candidate);
    }

    log.info('Contradiction detection complete', { found: candidates.length });
  },
};
