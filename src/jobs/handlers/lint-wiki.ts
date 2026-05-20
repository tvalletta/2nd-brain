import type { JobHandler, Job, JobContext } from '../types.js';
import { lintWiki } from '../../maintenance/lint.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:lint-wiki');

export const lintWikiHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    log.info('Running wiki lint');

    // 1. Call lintWiki with autoFix enabled
    const result = await lintWiki(context.vault, { autoFix: true });

    // 2. Log results
    const counts: Record<string, number> = {};
    for (const issue of result.issues) {
      counts[issue.type] = (counts[issue.type] ?? 0) + 1;
    }

    log.info('Wiki lint complete', {
      scanned: result.scanned,
      issueCount: result.issues.length,
      autoFixed: result.autoFixed,
      ...counts,
    });
  },
};
