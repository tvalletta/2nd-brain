import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:classify-source');

export const classifySourceHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('classify-source: no targetPath');

    const content = await context.vault.read(summaryPath);
    const { data, body } = parseNote(content);

    // Update ingest status
    data.ingest_status = 'classified';
    data.updated_at = nowISO();

    const updated = serializeNote(data, body);
    await context.vault.atomicWrite(summaryPath, updated);

    const sourceHash = (data.source_hash as string) ?? '';
    const contentCategory = (data.content_category as string) ?? '';
    log.info('Source classified', { path: summaryPath, sourceType: data.source_type, contentCategory });

    if (contentCategory === 'meeting-notes') {
      // Meeting transcripts get structured extraction + meeting note creation
      await context.enqueue({
        type: 'summarize-meeting',
        targetPath: summaryPath,
        payload: { rawPath: data.source_path, sourceHash },
        trigger: 'cascade',
        priority: 40,
        dedupeKey: `meeting-summarize:${sourceHash}`,
      });
    } else {
      // All other content: generic summarization
      await context.enqueue({
        type: 'summarize-source',
        targetPath: summaryPath,
        payload: { rawPath: data.source_path, sourceHash },
        trigger: 'cascade',
        priority: 50,
        dedupeKey: `summarize:${sourceHash}`,
      });
    }

    // Rich entity extraction runs for all content categories
    await context.enqueue({
      type: 'extract-entities-rich',
      targetPath: summaryPath,
      payload: { rawPath: data.source_path, sourceHash },
      trigger: 'cascade',
      priority: 50,
      dedupeKey: `extract:${sourceHash}`,
    });
  },
};
