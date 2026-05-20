import type { JobHandler } from '../types.js';
import { runRotScan } from '../../intelligence/rot-scan.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const rotScanHandler: JobHandler = {
  async execute(_job, ctx) {
    await runRotScan(ctx.vault, { layout: layoutFromConfig(ctx.config) });
  },
};
