import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startWatchdog } from '../../src/mcp/watchdog.js';

function fakeWorker() {
  const w: any = new EventEmitter();
  w.unref = () => {};
  w.terminate = vi.fn().mockResolvedValue(0);
  return w;
}

describe('startWatchdog', () => {
  it('spawns the worker with sab + timeout + checkInterval in workerData', () => {
    let captured: any;
    const workerFactory = vi.fn((_p, o) => {
      captured = o;
      return fakeWorker();
    });
    const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
    expect(workerFactory).toHaveBeenCalledWith('/w.js', expect.anything());
    expect(captured.workerData.timeoutMs).toBe(30000);
    expect(captured.workerData.checkIntervalMs).toBe(1000);
    expect(captured.workerData.sab).toBeInstanceOf(SharedArrayBuffer);
    return wd.stop();
  });

  it('the heartbeat interval advances the shared timestamp', async () => {
    vi.useFakeTimers();
    let captured: any;
    const wd = startWatchdog({
      heartbeatMs: 1000,
      timeoutMs: 30000,
      workerPath: '/w.js',
      now: () => Date.now(),
      workerFactory: (_p, o) => {
        captured = o;
        return fakeWorker();
      },
    });
    const hb = new BigInt64Array(captured.workerData.sab);
    const first = Number(Atomics.load(hb, 0)); // initial beat set before worker spawn
    vi.advanceTimersByTime(1000);
    expect(Number(Atomics.load(hb, 0))).toBeGreaterThanOrEqual(first);
    await wd.stop();
    vi.useRealTimers();
  });

  it('respawns the worker if it exits unexpectedly', () => {
    const workers: any[] = [];
    const workerFactory = vi.fn(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
    workers[0].emit('exit', 1);
    expect(workerFactory).toHaveBeenCalledTimes(2);
    return wd.stop();
  });

  it('stop() clears the heartbeat and terminates the worker without respawning', async () => {
    const workers: any[] = [];
    const workerFactory = vi.fn(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    });
    const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
    await wd.stop();
    expect(workers[0].terminate).toHaveBeenCalled();
    workers[0].emit('exit', 0); // exit during stop must NOT respawn
    expect(workerFactory).toHaveBeenCalledTimes(1);
  });
});
