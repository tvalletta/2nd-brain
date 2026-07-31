import type { JobHandler, Job, JobContext } from '../types.js';
import { detectDuplicates, writeDuplicateReview } from '../../review/duplicate-detector.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-duplicates');

export const detectDuplicatesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectDuplicates(context.vault);

    for (const candidate of candidates) {
      await writeDuplicateReview(context.vault, context.config, context.projectRoot, candidate);
    }

    await appendLogEntry(
      context.vault,
      { kind: 'review:duplicates', message: `${candidates.length} candidates flagged` },
      layoutFromConfig(context.config),
    );

    log.info('Duplicate detection complete', { found: candidates.length });
  },
};
