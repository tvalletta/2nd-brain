import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:finalize-session');

export const finalizeSessionHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    // Find source summaries still in progress (not yet 'linked' or 'logged')
    const summaryPaths = await context.vault.listMarkdownFiles(context.config.layout.sources);
    let updated = 0;

    for (const path of summaryPaths) {
      try {
        const content = await context.vault.read(path);
        const { data, body } = parseNote(content);

        const status = data.ingest_status as string;
        if (status === 'linked' || status === 'extracted' || status === 'summarized') {
          data.ingest_status = 'logged';
          data.updated_at = nowISO();
          const result = serializeNote(data, body);
          await context.vault.atomicWrite(path, result);
          updated++;
        }
      } catch (err) {
        log.warn('Failed to finalize source summary', { path, error: (err as Error).message });
      }
    }

    log.info('Session finalized', { updated });

    // Cascade: rebuild index
    await context.enqueue({
      type: 'rebuild-index',
      trigger: 'cascade',
      priority: 10,
      dedupeKey: 'index:wiki',
    });
  },
};
