// Job handler: tldr-update — runs CoD on a single note and writes the TL;DR.

import type { JobHandler } from '../types.js';
import { updateTldr } from '../../intelligence/tldr.js';

export const tldrUpdateHandler: JobHandler = {
  async execute(job, ctx) {
    if (!job.targetPath) return;
    await updateTldr({
      vault: ctx.vault,
      llm: ctx.llm,
      notePath: job.targetPath,
      options: {
        maxChars: ctx.config.intelligence.tldr.maxChars,
        cooldownDays: ctx.config.intelligence.tldr.cooldownDays,
      },
    });
  },
};
