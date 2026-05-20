import type { JobHandler } from '../types.js';
import { runDecayScan } from '../../intelligence/decay-scan.js';

export const decayScanHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.decay.enabled) return;
    await runDecayScan({ vault: ctx.vault, config: ctx.config, enqueue: ctx.enqueue });
  },
};
