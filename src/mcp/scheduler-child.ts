import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnLowPriority } from '../shared/low-priority.js';
import { createLogger, type Logger } from '../shared/logger.js';

/**
 * Runs `karpathy intel tick` as an isolated, low-priority, detached child
 * process instead of on the daemon's own serving event loop. Guards against
 * overlapping ticks (skip while the previous child is still within its
 * runtime budget) and against a runaway child (kill past `maxRuntimeMs`,
 * then spawn a fresh one on the same `tick()` call).
 */
export interface SchedulerChildRunner {
  tick(): void;
  current(): { child: ChildProcess; startedAt: number } | null;
  stop(): void;
}

export function createSchedulerChildRunner(opts: {
  scriptPath: string;
  projectRoot: string;
  maxRuntimeMs: number;
  spawn?: (command: string, args: string[], o: SpawnOptions) => ChildProcess;
  now?: () => number;
  log?: Logger;
}): SchedulerChildRunner {
  const spawn = opts.spawn ?? spawnLowPriority;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? createLogger('scheduler-child');
  let tracked: { child: ChildProcess; startedAt: number } | null = null;

  function tick(): void {
    if (tracked && tracked.child.exitCode === null && !tracked.child.killed) {
      const runtime = now() - tracked.startedAt;
      if (runtime < opts.maxRuntimeMs) {
        log.info('scheduler tick skipped — previous child still running', { pid: tracked.child.pid, runtime });
        return;
      }
      log.warn('scheduler child exceeded maxRuntime — killing', { pid: tracked.child.pid, runtime });
      tracked.child.kill('SIGKILL');
      tracked = null;
    }
    const child = spawn(process.execPath, [opts.scriptPath, 'intel', 'tick', '--project-root', opts.projectRoot], {
      detached: true,
      stdio: 'ignore',
      cwd: opts.projectRoot,
    });
    child.unref();
    const entry = { child, startedAt: now() };
    tracked = entry;
    child.on('exit', (code) => {
      log.info('scheduler child exited', { pid: child.pid, code });
      if (tracked === entry) tracked = null;
    });
    // An unhandled 'error' event (e.g. ENOENT if `scriptPath` doesn't
    // exist, or a spawn-level EAGAIN) would otherwise throw uncaught and
    // crash the daemon -- exactly the failure mode this whole isolation
    // effort exists to prevent. Mirrors the 'exit' handler's identity
    // guard so a stale listener from a since-replaced child can't clear
    // tracking for the current one.
    child.on('error', (err) => {
      log.error('scheduler child spawn error', { pid: child.pid, error: (err as Error).message });
      if (tracked === entry) tracked = null;
    });
  }

  return {
    tick,
    current: () => tracked,
    stop: () => {
      tracked = null;
    },
  };
}
