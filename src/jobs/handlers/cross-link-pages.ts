import type { JobHandler, Job, JobContext } from '../types.js';
import { crossLinkPages } from '../../compilation/cross-linker.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:cross-link-pages');

export const crossLinkPagesHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const pagePaths = job.payload.pagePaths as string[] | undefined;
    if (!pagePaths || pagePaths.length === 0) {
      throw new Error('cross-link-pages: no pagePaths in payload');
    }

    log.info('Cross-linking pages', { pageCount: pagePaths.length });

    // 1. Call crossLinkPages
    const result = await crossLinkPages(pagePaths, { vault: context.vault });

    log.info('Cross-linking complete', {
      linksInserted: result.linksInserted,
      pagesUpdated: result.pagesUpdated.length,
    });

    // 2. Cascade: enqueue 'update-backlinks' for all updated pages
    for (const page of result.pagesUpdated) {
      await context.enqueue({
        type: 'update-backlinks',
        targetPath: page,
        trigger: 'cascade',
        priority: 10,
        dedupeKey: `backlinks:${page}`,
      });
    }

    // 3. Cascade: enqueue 'rebuild-indexes' (with dedup key so it only runs once)
    await context.enqueue({
      type: 'rebuild-indexes',
      trigger: 'cascade',
      priority: 15,
      dedupeKey: 'rebuild-indexes',
    });

    // 4. Intelligence: re-embed touched pages and refresh their TL;DRs.
    // Both handlers self-skip when not applicable (no body / cooldown).
    if (context.config.intelligence.tldr.enabled) {
      for (const page of result.pagesUpdated) {
        await context.enqueue({
          type: 'tldr-update',
          targetPath: page,
          trigger: 'cascade',
          priority: 65,
          dedupeKey: `tldr:${page}`,
        });
      }
    }
    for (const page of result.pagesUpdated) {
      await context.enqueue({
        type: 'embedding-index',
        targetPath: page,
        trigger: 'cascade',
        priority: 45,
        dedupeKey: `embed:page:${page}`,
      });
    }

    // 5. Intelligence: rebuild vault root index after pages have been updated.
    await context.enqueue({
      type: 'rebuild-vault-artifacts',
      trigger: 'cascade',
      priority: 92,
      dedupeKey: 'rebuild-vault-artifacts',
    });
  },
};
