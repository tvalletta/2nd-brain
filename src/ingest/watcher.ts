import { createLogger } from '../shared/logger.js';

const log = createLogger('watcher');

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
