import { createMCPContext } from './context.js';
import { startHttpMcpServer, type HttpMcpServerHandle } from './http-transport.js';
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
 * Runs a set of independent teardown/cleanup steps such that a rejection
 * in one can never prevent the others from running -- in this module,
 * that property is what guarantees the daemon lock (and, if bound, the
 * watcher lock) is always released even when e.g. `http.close()` throws.
 * Each step is wrapped individually (via `Promise.allSettled`), every
 * failure is logged, and -- once all steps have run -- the first failure
 * (or an `AggregateError` of all of them) is rethrown so callers still
 * observe that teardown was not fully clean.
 *
 * Exported standalone so the exception-safety property itself has direct,
 * mock-free unit coverage (test/mcp/daemon.test.ts) without needing to
 * fake failures inside the real `startHttpMcpServer`/watcher/lock
 * dependencies, which are themselves written to swallow their own
 * errors defensively and so can't be forced to reject in an integration
 * test without brittle module mocking.
 */
export async function runTeardownSteps(steps: Array<() => void | Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));

  for (const err of errors) {
    log.error('daemon teardown step failed', { error: err.message });
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'daemon teardown encountered multiple errors');
  }
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
 *
 * Exception safety: once the daemon lock is acquired, every resource
 * created afterward (`http`, `vw`, the two intervals) is tracked in
 * mutable outer-scope bindings and torn down through the single
 * `teardown()` closure below -- reachable from three places that can each
 * fire independently and in any order: the returned `handle.close()`, the
 * `SIGTERM`/`SIGINT` handlers (registered immediately after the lock is
 * acquired, before startup begins, so a signal arriving mid-startup still
 * routes here instead of falling through to Node's default handler), and
 * the startup `catch` block below (so a failure partway through startup
 * -- e.g. `EADDRINUSE` -- releases whatever was already acquired instead
 * of leaking the daemon lock for the rest of the process's life).
 * `teardown()` itself is idempotent (`closed` latch) and exception-safe
 * (`runTeardownSteps`): every step runs regardless of whether an earlier
 * one threw.
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

  // Mutable, possibly-partial state from here on -- `teardown()` must be
  // safe to call at any point from this line forward, including before
  // any of these are assigned (see the module-level doc comment above).
  let http: HttpMcpServerHandle | undefined;
  let vw: VaultWatcherHandle | null = null;
  let iv: NodeJS.Timeout | undefined;
  let idleIv: NodeJS.Timeout | undefined;
  let closed = false;

  async function teardown(): Promise<void> {
    if (closed) return;
    closed = true;
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    if (iv) clearInterval(iv);
    if (idleIv) clearInterval(idleIv);
    await runTeardownSteps([
      () => http?.close(),
      () => vw?.stop(),
      () => vw?.release(),
      () => releaseLock(),
    ]);
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
  // Registered before startup begins: a SIGTERM/SIGINT arriving mid-
  // startup must still route to teardown() rather than fall through to
  // Node's default handler and leak whatever had already started.
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  try {
    http = await startHttpMcpServer({
      ctx,
      host: opts.host ?? ctx.config.daemon.host,
      port: opts.port ?? ctx.config.daemon.port,
      sessionIdleTimeoutMs: ctx.config.daemon.sessionIdleTimeoutMs,
      authToken: ctx.config.daemon.authToken,
    });

    vw = await startVaultWatcher(ctx);

    // Scheduler tick: replaces the standalone launchd `com.karpathy.tick`
    // job for this project. Re-entrancy guard (`tickInFlight`) prevents a
    // slow tick from overlapping the next timer fire; `runSchedulerTick`
    // itself also takes the global job-runner lock (Fix E, §27) as a
    // second, cross-process layer of protection.
    let tickInFlight = false;
    iv = setInterval(() => {
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
    // The HTTP server's listening socket is what keeps this process
    // alive; these timers are periodic maintenance, not liveness anchors.
    iv.unref?.();

    const httpHandle = http;
    idleIv = setInterval(() => {
      httpHandle.sweepIdle();
    }, ctx.config.daemon.sessionIdleTimeoutMs);
    idleIv.unref?.();
  } catch (err) {
    // Startup failed partway through -- release whatever was already
    // acquired/started (Important 2) instead of leaking the daemon lock
    // (and, if it got that far, the watcher lock) for the rest of the
    // process's life.
    await teardown().catch((teardownErr) => {
      log.error('daemon startup cleanup (after failed start) also failed', {
        error: (teardownErr as Error).message,
      });
    });
    throw err;
  }

  log.info('daemon started', { url: http.url, pid: process.pid });

  return {
    port: http.port,
    url: http.url,
    close: teardown,
  };
}
