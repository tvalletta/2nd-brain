import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';

/** Pure decision: is the last heartbeat older than the allowed timeout? */
export function shouldTrip(lastBeatMs: number, nowMs: number, timeoutMs: number): boolean {
  return nowMs - lastBeatMs > timeoutMs;
}

// Worker entry — runs ONLY when this module is loaded as a Worker with workerData.
const wd = workerData as { sab: SharedArrayBuffer; timeoutMs: number; checkIntervalMs: number } | null;
if (wd && wd.sab) {
  const hb = new BigInt64Array(wd.sab);
  const timer = setInterval(() => {
    const last = Number(Atomics.load(hb, 0));
    const nowMs = Date.now();
    if (shouldTrip(last, nowMs, wd.timeoutMs)) {
      writeSync(2, `[watchdog] main loop unresponsive for ${nowMs - last}ms — SIGKILL pid ${process.pid}\n`);
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* already dying */ }
    }
  }, wd.checkIntervalMs);
  timer.unref?.();
}
