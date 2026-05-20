import { createLogger } from '../shared/logger.js';

const log = createLogger('watcher');

export interface FileWatcher {
  start(): void;
  stop(): void;
}

export async function createFileWatcher(
  watchPaths: string[],
  onFile: (filePath: string) => Promise<void>,
): Promise<FileWatcher> {
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
      await onFile(filePath);
    } catch (err) {
      log.error('Watcher handler failed', { filePath, error: (err as Error).message });
    }
  });

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
