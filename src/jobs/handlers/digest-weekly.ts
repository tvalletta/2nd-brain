// B1: Weekly hot-topics digest job handler.

import type { JobHandler } from '../types.js';
import { runWeeklyDigest } from '../../intelligence/digest.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import { layoutFromConfig } from '../../vault/paths.js';

export const digestWeeklyHandler: JobHandler = {
  async execute(_job, ctx) {
    if (!ctx.config.intelligence.digest.enabled) return;
    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      await runWeeklyDigest(
        { vault: ctx.vault, llm: ctx.llm, store },
        {
          windowDays: ctx.config.intelligence.digest.windowDays,
          minClusterSize: ctx.config.intelligence.digest.minClusterSize,
          maxClusters: ctx.config.intelligence.digest.maxClusters,
          layout: layoutFromConfig(ctx.config),
        },
      );
    } finally {
      store.close();
    }
  },
};
