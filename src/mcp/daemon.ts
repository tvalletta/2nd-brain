import { createMCPContext } from './context.js';
import { startHttpMcpServer } from './http-transport.js';
import { startVaultWatcher, type VaultWatcherHandle } from './vault-watcher.js';
import { runSchedulerTick } from '../intelligence/scheduler-tick.js';
import { applySelfLowPriority } from '../shared/low-priority.js';
import { createFileLock } from '../jobs/lock.js';
import { resolveLockDir, resolveStateDir } from '../config/defaults.js';
import { LockError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mcp-daemon');

/** Cross-process advisory lock key: at most one daemon per project root. */
const DAEMON_LOCK_KEY = 'mcp-daemon';

export interface DaemonHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface RunDaemonOptions {
  projectRoot: string;
  port?: number;
  host?: string;
}

/**
 * Starts the shared MCP daemon: one long-lived process serving MCP over
 * HTTP to every window against this project, owning the single vault
 * watcher, and running the scheduler tick internally in place of the
 * per-window launchd `intel tick`.
 *
 * Single-instance design decision: a second `runDaemon` call racing the
 * same project root's `mcp-daemon` file lock (see `createFileLock`) is an
 * expected steady state -- e.g. a second Claude Code window starting up
 * against a project a daemon is already running for -- not an exceptional
 * failure. Rather than reject the returned promise (which would force
 * every caller, including the CLI's top-level `main().catch()` fatal-error
 * handler, to special-case this one non-fatal condition), this returns a
 * well-typed no-op `DaemonHandle`: `port: -1` and `url: ''` as sentinels
 * (never a real bound port/URL), `close()` resolving immediately. No port
 * is bound and nothing is started. Callers that only care about "is a
 * daemon now reachable" can check `port > 0`.
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<DaemonHandle> {
  applySelfLowPriority(5);

  const ctx = await createMCPContext(opts.projectRoot);

  const lock = createFileLock(resolveLockDir(ctx.config));
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lock.acquire(DAEMON_LOCK_KEY);
  } catch (err) {
    if (err instanceof LockError) {
      log.info('daemon already running — skipping start', {
        projectRoot: ctx.config.projectRoot,
      });
      return {
        port: -1,
        url: '',
        async close() {
          // Nothing was started; nothing to tear down.
        },
      };
    }
    throw err;
  }

  const http = await startHttpMcpServer({
    ctx,
    host: opts.host ?? ctx.config.daemon.host,
    port: opts.port ?? ctx.config.daemon.port,
    sessionIdleTimeoutMs: ctx.config.daemon.sessionIdleTimeoutMs,
    authToken: ctx.config.daemon.authToken,
  });

  const vw: VaultWatcherHandle | null = await startVaultWatcher(ctx);

  // Scheduler tick: replaces the standalone launchd `com.karpathy.tick`
  // job for this project. Re-entrancy guard (`tickInFlight`) prevents a
  // slow tick from overlapping the next timer fire; `runSchedulerTick`
  // itself also takes the global job-runner lock (Fix E, §27) as a second,
  // cross-process layer of protection.
  let tickInFlight = false;
  const iv = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runSchedulerTick({ config: ctx.config, stateDir: resolveStateDir(ctx.config) })
      .catch((err) => {
        log.error('scheduler tick failed', { error: (err as Error).message });
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, ctx.config.daemon.tickIntervalMs);
  // The HTTP server's listening socket is what keeps this process alive;
  // these timers are periodic maintenance, not liveness anchors.
  iv.unref?.();

  const idleIv = setInterval(() => {
    http.sweepIdle();
  }, ctx.config.daemon.sessionIdleTimeoutMs);
  idleIv.unref?.();

  let closed = false;

  /**
   * Shared teardown, used both by the exported `handle.close()` (no
   * `process.exit` -- tests call this directly) and the signal handlers
   * below (which call this, then exit). Idempotent: a signal arriving
   * after an explicit `close()` (or vice versa) is a no-op on the second
   * call.
   */
  async function teardown(): Promise<void> {
    if (closed) return;
    closed = true;
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    clearInterval(iv);
    clearInterval(idleIv);
    await http.close();
    vw?.stop();
    await vw?.release();
    await releaseLock();
  }

  function onSignal(signal: string): void {
    teardown()
      .catch((err) => {
        log.error('daemon shutdown failed', { signal, error: (err as Error).message });
      })
      .finally(() => {
        process.exit(0);
      });
  }
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  log.info('daemon started', { url: http.url, pid: process.pid });

  return {
    port: http.port,
    url: http.url,
    close: teardown,
  };
}
