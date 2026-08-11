import { Worker } from 'node:worker_threads';
import { createLogger, type Logger } from '../shared/logger.js';

export interface WatchdogHandle {
  stop(): Promise<void>;
}

export function startWatchdog(opts: {
  heartbeatMs: number;
  timeoutMs: number;
  workerPath: string;
  log?: Logger;
  workerFactory?: (path: string, o: { workerData: unknown }) => Worker;
  now?: () => number;
}): WatchdogHandle {
  const log = opts.log ?? createLogger('watchdog');
  const now = opts.now ?? Date.now;
  const factory = opts.workerFactory ?? ((p, o) => new Worker(p, o));
  const sab = new SharedArrayBuffer(8);
  const hb = new BigInt64Array(sab);
  Atomics.store(hb, 0, BigInt(now())); // initial beat BEFORE the worker starts (no false-fire at t=0)
  const beat = setInterval(() => Atomics.store(hb, 0, BigInt(now())), opts.heartbeatMs);
  beat.unref?.();
  let stopping = false;
  let worker: Worker;
  const spawn = () => {
    worker = factory(opts.workerPath, {
      workerData: { sab, timeoutMs: opts.timeoutMs, checkIntervalMs: opts.heartbeatMs },
    });
    worker.unref?.();
    worker.on('exit', (code) => {
      if (stopping) return;
      log.warn('watchdog worker exited unexpectedly — respawning', { code });
      spawn();
    });
    worker.on('error', (err) => log.error('watchdog worker error', { error: (err as Error).message }));
  };
  spawn();
  return {
    async stop() {
      stopping = true;
      clearInterval(beat);
      await worker.terminate();
    },
  };
}
