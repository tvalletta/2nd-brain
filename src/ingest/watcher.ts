import { createLogger } from '../shared/logger.js';
import { createFileLock } from '../jobs/lock.js';
import { LockError } from '../shared/errors.js';

const log = createLogger('watcher');

/** Lock key for the cross-process single-watcher advisory lock (Fix A). */
export const WATCHER_LOCK_KEY = 'watcher';

export interface WatcherLockResult {
  /** Whether this call took ownership of the lock. */
  acquired: boolean;
  /** Release function — non-null iff `acquired` is true. Idempotent-safe: call once on shutdown. */
  release: (() => Promise<void>) | null;
}

/**
 * Cross-process advisory lock so only ONE MCP server instance runs a file
 * watcher over the vault at a time. Every Claude Code window spawns its own
 * MCP server (`src/mcp/server.ts`); without this, N concurrently-running
 * windows each started a redundant chokidar watcher over the same
 * OneDrive-backed folders, live-driving `fileproviderd`/OneDrive CPU usage
 * with N-fold redundant filesystem event + polling activity.
 *
 * Reuses `createFileLock` (`src/jobs/lock.ts`) as-is — no changes needed
 * there, since its existing cross-process staleness rule (a lock file whose
 * recorded PID is no longer alive via `process.kill(pid, 0)`) already
 * implements "a dead holder's lock is free to take over".
 *
 * Returns `{ acquired: false, release: null }` (rather than throwing) when a
 * live process already holds the lock — the caller's job in that case is to
 * skip starting a watcher entirely, not to treat it as an error.
 */
export async function acquireWatcherLock(lockDir: string): Promise<WatcherLockResult> {
  const lock = createFileLock(lockDir);
  try {
    const release = await lock.acquire(WATCHER_LOCK_KEY);
    return { acquired: true, release };
  } catch (err) {
    if (err instanceof LockError) {
      return { acquired: false, release: null };
    }
    throw err;
  }
}

export interface FileWatcher {
  start(): void;
  stop(): void;
}

export interface WatcherHandlers {
  /** Called for `add` events — typically forwards to the ingest pipeline. */
  onFile: (filePath: string) => Promise<void>;
  /** Optional: called for `change` events (file modified in place). */
  onChange?: (filePath: string) => Promise<void>;
  /** Optional: called for `unlink` events (file deleted). */
  onUnlink?: (filePath: string) => Promise<void>;
}

export async function createFileWatcher(
  watchPaths: string[],
  handlersOrOnFile: WatcherHandlers | ((filePath: string) => Promise<void>),
): Promise<FileWatcher> {
  const handlers: WatcherHandlers =
    typeof handlersOrOnFile === 'function' ? { onFile: handlersOrOnFile } : handlersOrOnFile;

  // Lazy-load chokidar
  const { watch } = await import('chokidar');

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  });

  watcher.on('add', async (filePath) => {
    log.info('File detected', { filePath });
    try {
      await handlers.onFile(filePath);
    } catch (err) {
      log.error('Watcher add handler failed', { filePath, error: (err as Error).message });
    }
  });

  if (handlers.onChange) {
    watcher.on('change', async (filePath) => {
      log.info('File changed', { filePath });
      try {
        await handlers.onChange!(filePath);
      } catch (err) {
        log.error('Watcher change handler failed', {
          filePath,
          error: (err as Error).message,
        });
      }
    });
  }

  if (handlers.onUnlink) {
    watcher.on('unlink', async (filePath) => {
      log.info('File removed', { filePath });
      try {
        await handlers.onUnlink!(filePath);
      } catch (err) {
        log.error('Watcher unlink handler failed', {
          filePath,
          error: (err as Error).message,
        });
      }
    });
  }

  return {
    start() {
      log.info('File watcher started', { paths: watchPaths });
    },
    stop() {
      watcher.close();
      log.info('File watcher stopped');
    },
  };
}
