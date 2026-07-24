import type { JobHandler, Job, JobContext } from '../types.js';
import { detectContradictions, writeContradictionReview } from '../../review/contradiction-detector.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:detect-contradictions');

export const detectContradictionsHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const candidates = await detectContradictions(context.vault);

    for (const candidate of candidates) {
      await writeContradictionReview(context.vault, candidate);
    }

    await appendLogEntry(
      context.vault,
      { kind: 'review:contradictions', message: `${candidates.length} candidates flagged` },
      layoutFromConfig(context.config),
    );

    log.info('Contradiction detection complete', { found: candidates.length });
  },
};
