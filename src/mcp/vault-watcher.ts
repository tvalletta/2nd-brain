import { join, relative } from 'node:path';
import type { MCPContext } from './context.js';
import { createFileWatcher, acquireWatcherLock } from '../ingest/watcher.js';
import { ingestFile } from '../ingest/pipeline.js';
import { createLogger } from '../shared/logger.js';
import { resolveLockDir } from '../config/defaults.js';

const log = createLogger('vault-watcher');

/**
 * Handle returned by `startVaultWatcher` — the caller stops chokidar and
 * releases the cross-process watcher lock together on shutdown.
 */
export interface VaultWatcherHandle {
  stop(): void;
  release(): Promise<void>;
}

/**
 * Starts the single vault-wide file watcher (Fix A): acquires the
 * cross-process advisory lock so only one MCP server instance (or, once the
 * HTTP daemon ships, the daemon) watches the vault at a time, then wires up
 * chokidar via `createFileWatcher` with auto-ingest + FTS-sync handlers.
 *
 * Extracted from `src/mcp/server.ts` verbatim (same lock/skip semantics,
 * same watch paths, same handlers) so both the stdio server and the
 * upcoming HTTP daemon start the watcher from one place.
 *
 * Returns `null` when `ingest.watchEnabled` is `false`, or when the watcher
 * lock is already held by another live process — in both cases the caller
 * does not start a watcher and relies on the lock-holder (or the scheduled
 * `intel tick`) instead.
 */
export async function startVaultWatcher(ctx: MCPContext): Promise<VaultWatcherHandle | null> {
  if (!ctx.config.ingest.watchEnabled) {
    return null;
  }

  const lockDir = resolveLockDir(ctx.config);
  const watcherLock = await acquireWatcherLock(lockDir);

  if (!watcherLock.acquired) {
    log.info('Watcher lock held by another MCP server instance — skipping watcher startup');
    return null;
  }

  const watchPaths = ctx.config.ingest.watchPaths.map((p) => join(ctx.config.vaultPath, p));

  const enqueueFtsSync = async (filePath: string, deleted = false) => {
    if (!filePath.endsWith('.md')) return;
    const rel = relative(ctx.config.vaultPath, filePath);
    if (rel.startsWith('..')) return;
    await ctx.enqueueJob({
      type: 'sync-fts-index',
      payload: deleted ? { deletedFile: rel } : { file: rel },
      trigger: 'file-watcher',
      priority: 100,
      dedupeKey: `sync-fts-index:${rel}`,
    });
  };

  const watcher = await createFileWatcher(watchPaths, {
    async onFile(filePath) {
      try {
        const result = await ingestFile(filePath, ctx.vault, ctx.config.layout);
        log.info('Auto-ingested new file', {
          rawPath: result.rawPath,
          summary: result.sourceSummaryPath,
        });
      } catch (err) {
        log.error('Auto-ingest failed', { filePath, error: (err as Error).message });
      }
      await enqueueFtsSync(filePath);
    },
    async onChange(filePath) {
      await enqueueFtsSync(filePath);
    },
    async onUnlink(filePath) {
      await enqueueFtsSync(filePath, true);
    },
  });
  watcher.start();

  return {
    stop: () => watcher.stop(),
    release: watcherLock.release!,
  };
}
