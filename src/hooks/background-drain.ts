import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:background-drain');

/**
 * Spawns a detached child process to drain the job queue.
 * Returns immediately — the child survives the parent exiting.
 */
export function spawnBackgroundDrain(): void {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const script = resolve(thisDir, '../../dist/bin/karpathy.js');

    const child = spawn(process.execPath, [script, 'drain-queue'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    log.info('Background drain spawned', { pid: child.pid });
  } catch (err) {
    log.warn('Failed to spawn background drain', { error: (err as Error).message });
  }
}
