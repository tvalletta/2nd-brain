import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldTrip } from '../../src/mcp/watchdog-worker.js';

describe('shouldTrip', () => {
  it('trips only when the heartbeat is older than the timeout', () => {
    expect(shouldTrip(1000, 1000 + 30001, 30000)).toBe(true);
    expect(shouldTrip(1000, 1000 + 30000, 30000)).toBe(false);
    expect(shouldTrip(1000, 1000 + 100, 30000)).toBe(false);
  });

  it('importing the module does not start the worker loop (workerData is null in main thread)', () => {
    // no throw, no hang — the entry is guarded
    expect(typeof shouldTrip).toBe('function');
  });
});

// Real Worker-thread coverage. `shouldTrip` above only exercises the pure
// decision function in the main thread (`workerData` is null there, so the
// interval-creation branch never runs) -- it can't catch a bug in the
// worker-entry branch itself. Requires the REAL BUILT
// `dist/mcp/watchdog-worker.js` (same precedent as
// test/bin/intel-tick-exit.test.ts spawning `dist/bin/karpathy.js`): a
// `node:worker_threads` Worker always evaluates its target file as its own
// module, so there is no meaningful "import straight from src/" equivalent
// the way daemon.ts's other statically-imported dependencies have.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER_PATH = resolve(ROOT, 'dist/mcp/watchdog-worker.js');

describe('watchdog worker entry (real Worker thread)', () => {
  // Regression test for a real bug found via this task's manual daemon
  // smoke test: the interval driving the heartbeat check was `.unref()`'d,
  // which is correct for a timer on the MAIN process (kept alive by the
  // HTTP server's listening socket regardless) but wrong here -- this
  // worker thread has no other handle, so un-refing its only interval left
  // nothing keeping its event loop alive. It exited immediately (code 0)
  // right after spawning, before ever checking the heartbeat even once,
  // which made `startWatchdog`'s "respawn on unexpected exit" logic
  // respawn it again immediately -- an unthrottled, tight respawn loop
  // (observed live at ~12ms/cycle) that would pin a CPU core indefinitely
  // in production the moment `daemon.watchdogEnabled` (default `true`) took
  // effect. `Worker.terminate()` is a hard stop regardless of refs, so
  // fixing this (dropping `.unref()`) doesn't block clean shutdown.
  it('stays alive on its own once spawned — does not exit immediately (unref regression)', async () => {
    const sab = new SharedArrayBuffer(8);
    const hb = new BigInt64Array(sab);
    Atomics.store(hb, 0, BigInt(Date.now())); // fresh beat -- must never trip below
    const worker = new Worker(WORKER_PATH, {
      workerData: { sab, timeoutMs: 30_000, checkIntervalMs: 20 },
    });
    let exited = false;
    worker.on('exit', () => {
      exited = true;
    });
    try {
      // Several real check-interval ticks' worth of wall-clock time — long
      // enough that the pre-fix bug (immediate exit) would already have
      // flipped `exited` to true well before this resolves.
      await new Promise((r) => setTimeout(r, 300));
      expect(exited).toBe(false);
    } finally {
      await worker.terminate();
    }
  }, 10_000);

  // End-to-end trip behavior, in an ISOLATED CHILD PROCESS rather than a
  // Worker spawned directly in this test's own process: `workerData`
  // deliberately calls `process.kill(process.pid, 'SIGKILL')` on trip, and
  // `worker_threads` share their owning process's PID -- calling this
  // in-process would SIGKILL the vitest test runner itself. Spawning a
  // throwaway child process that creates its own worker keeps that
  // self-inflicted SIGKILL confined to the child.
  it('a genuinely stale heartbeat trips and SIGKILLs its own (isolated) process', async () => {
    const script = [
      "const { Worker } = require('node:worker_threads');",
      'const sab = new SharedArrayBuffer(8);',
      'const hb = new BigInt64Array(sab);',
      'Atomics.store(hb, 0, BigInt(Date.now() - 10_000));', // already 10s stale
      `new Worker(${JSON.stringify(WORKER_PATH)}, { workerData: { sab, timeoutMs: 50, checkIntervalMs: 10 } });`,
    ].join('\n');

    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('child did not exit within 8s'));
        }, 8_000);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolveExit({ code, signal });
        });
        child.on('error', reject);
      },
    );

    expect(result.signal).toBe('SIGKILL');
  }, 10_000);
});
