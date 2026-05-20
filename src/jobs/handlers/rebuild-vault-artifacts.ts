// Job handler: rebuild-vault-artifacts — A4 maintenance.
//
// 1. Rebuilds index.md (catalogue projection).
// 2. Pins the latest digest's hot topics + pending research candidates into
//    the CLAUDE.md hot cache so every session starts informed.
//
// log.md is append-only and updated by callers; not rebuilt here.

import { join } from 'node:path';
import type { JobHandler } from '../types.js';
import { rebuildVaultIndex } from '../../maintenance/vault-index.js';
import { injectHotCache } from '../../intelligence/hot-cache-injector.js';
import { createHotCacheManager } from '../../session/hot-cache.js';

export const rebuildVaultArtifactsHandler: JobHandler = {
  async execute(_job, ctx) {
    await rebuildVaultIndex(ctx.vault, ctx.config.layout);

    const hotCache = createHotCacheManager(join(ctx.vaultPath, ctx.config.hotCachePath));
    await injectHotCache(ctx.vault, hotCache, ctx.config.layout, ctx.projectRoot);
  },
};
