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
  // Deliberately NOT `.unref()`'d, unlike every other timer in this
  // codebase (e.g. daemon.ts's own tick/idle-sweep intervals, which are
  // unref'd because the HTTP server's listening socket is what's supposed
  // to keep THAT process alive). This worker thread has no other handle
  // running -- unref'ing its only interval left nothing keeping the
  // worker's event loop alive, so it exited immediately (code 0) right
  // after spawning, which made `startWatchdog`'s "respawn on unexpected
  // exit" logic respawn it again immediately, forever -- a tight,
  // un-throttled respawn loop discovered live via this task's manual
  // smoke test (`node dist/bin/karpathy.js mcp-daemon`), the exact
  // resource-exhaustion failure mode §27/§28 exist to prevent. Termination
  // is via `worker.terminate()` (a hard stop, ignores refs) from
  // `WatchdogHandle.stop()`, not by letting the loop drain, so keeping
  // this ref'd doesn't block clean shutdown.
  setInterval(() => {
    const last = Number(Atomics.load(hb, 0));
    const nowMs = Date.now();
    if (shouldTrip(last, nowMs, wd.timeoutMs)) {
      writeSync(2, `[watchdog] main loop unresponsive for ${nowMs - last}ms — SIGKILL pid ${process.pid}\n`);
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* already dying */ }
    }
  }, wd.checkIntervalMs);
}
