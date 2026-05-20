import type { JobHandler, Job, JobContext } from '../types.js';
import { rebuildAllBacklinks, updateBacklinksForFile } from '../../maintenance/backlinks.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const updateBacklinksHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const layout = layoutFromConfig(context.config);
    if (job.targetPath) {
      const allPaths = await context.vault.listMarkdownFiles(layout.wiki);
      await updateBacklinksForFile(context.vault, job.targetPath, allPaths);
    } else {
      await rebuildAllBacklinks(context.vault, layout);
    }
  },
};
