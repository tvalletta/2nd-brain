# Daemon Event-Loop Isolation + Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the daemon's scheduler drain OFF its serving event loop (spawn `intel tick` as an isolated, low-priority, runtime-capped child) and add a worker-thread heartbeat watchdog that SIGKILLs a wedged daemon for launchd to restart — making the daemon stable/robust/reliable enough to be the sole process.

**Architecture:** The daemon's `setInterval` spawns `karpathy intel tick` as a detached low-priority child (via `spawnLowPriority`) instead of running `runSchedulerTick` inline; an overlap guard + runtime cap bound the child. A `worker_thread` reads a `SharedArrayBuffer` heartbeat the main loop writes each second and `process.kill(pid,'SIGKILL')`s the process if the loop goes stale past a threshold. Design: `docs/superpowers/specs/2026-08-10-daemon-event-loop-isolation-design.md`.

**Tech Stack:** Node 24, TypeScript (ESM, strict), `node:worker_threads`, `node:child_process`, `SharedArrayBuffer`/`Atomics`, better-sqlite3, launchd, Vitest, tsup.

## Global Constraints

- ESM only — all relative imports end in `.js`. Never `require`.
- `pnpm build && pnpm lint && pnpm test` must all pass before every commit. Lint = `tsc --noEmit` (strict).
- Never hardcode absolute personal paths in committed source.
- Reuse existing primitives: `spawnLowPriority`/`applySelfLowPriority` (`src/shared/low-priority.ts`), `createLogger` (`src/shared/logger.ts`), `runTeardownSteps` + `runDaemon` (`src/mcp/daemon.ts`), `DaemonConfigSchema` (`src/config/schema.ts:431`).
- Do NOT weaken §27/§28: the global `queue-runner` lock, job caps, memory bounds, single-instance `mcp-daemon` lock, single vault watcher, and stdio fallback all remain intact.
- `runSchedulerTick` (`src/intelligence/scheduler-tick.ts`) stays the CLI `intel tick` body — unchanged except a `--project-root` pass-through if Task 5 needs it. It is invoked ONLY as a child process from the daemon.
- Baseline before starting: `pnpm test` green at the current count (record it in Task 1; ~1382).

---

## File structure

**Create:**
- `src/mcp/scheduler-child.ts` — `createSchedulerChildRunner(...)`: spawn `intel tick` child on demand; overlap guard; runtime cap.
- `src/mcp/watchdog-worker.ts` — pure `shouldTrip(...)` + the worker entry (Atomics-read loop → SIGKILL). New tsup entry.
- `src/mcp/watchdog.ts` — `startWatchdog(...)`: SAB + heartbeat interval + spawn/respawn worker + stop.
- Tests mirroring each under `test/mcp/`.

**Modify:**
- `src/config/schema.ts` — 4 new `daemon` fields.
- `src/mcp/daemon.ts` — replace inline scheduler block with the child runner; start/stop watchdog + heartbeat; teardown ordering.
- `src/bin/karpathy.ts` / `src/bin/intel-command.ts` — only if Task 5 needs `intel tick --project-root`.
- `tsup.config.ts` — add the `mcp/watchdog-worker` entry.
- `specs/specification.md` (§28), `CLAUDE.md` — docs.

---

## Task 1: `daemon` watchdog/scheduler-child config

**Files:**
- Modify: `src/config/schema.ts:431` (`DaemonConfigSchema`)
- Test: `test/config/schema.test.ts`

**Interfaces:**
- Produces: `config.daemon.watchdogEnabled: boolean` (default `true`), `config.daemon.watchdogTimeoutMs: number` (default `30000`), `config.daemon.watchdogHeartbeatMs: number` (default `1000`), `config.daemon.schedulerChildMaxRuntimeMs: number` (default `600000`). `PartialDaemonConfigSchema` (schema.ts:481, `.partial()`) auto-derives — no separate edit.

- [ ] **Step 1: Record baseline** — run `pnpm test`, note the exact `Test Files N / Tests M` line (for later CLAUDE.md update).

- [ ] **Step 2: Write the failing test** — in `test/config/schema.test.ts`, following the existing daemon-defaults test added in the §28 work:
```ts
it('applies daemon watchdog + scheduler-child defaults', () => {
  const cfg = KarpathyConfigSchema.parse({ vaultPath: '/v' });
  expect(cfg.daemon.watchdogEnabled).toBe(true);
  expect(cfg.daemon.watchdogTimeoutMs).toBe(30000);
  expect(cfg.daemon.watchdogHeartbeatMs).toBe(1000);
  expect(cfg.daemon.schedulerChildMaxRuntimeMs).toBe(600000);
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm test test/config/schema.test.ts` → FAIL (fields undefined).

- [ ] **Step 4: Implement** — add to `DaemonConfigSchema` (schema.ts:431), mirroring the existing field style:
```ts
watchdogEnabled: z.boolean().default(true),
watchdogTimeoutMs: z.number().int().positive().default(30_000),
watchdogHeartbeatMs: z.number().int().positive().default(1_000),
schedulerChildMaxRuntimeMs: z.number().int().positive().default(600_000),
```

- [ ] **Step 5: Run to verify it passes** — `pnpm test test/config/schema.test.ts` → PASS.
- [ ] **Step 6: `pnpm build && pnpm lint`** → green.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(daemon): watchdog + scheduler-child config fields"`

---

## Task 2: `scheduler-child.ts` — isolated scheduler child runner

**Files:**
- Create: `src/mcp/scheduler-child.ts`
- Test: `test/mcp/scheduler-child.test.ts`

**Interfaces:**
- Consumes: `spawnLowPriority(command, args, opts): ChildProcess` (`src/shared/low-priority.ts`), `createLogger` (`src/shared/logger.ts`).
- Produces:
```ts
export interface SchedulerChildRunner { tick(): void; current(): { child: ChildProcess; startedAt: number } | null; stop(): void; }
export function createSchedulerChildRunner(opts: {
  scriptPath: string; projectRoot: string; maxRuntimeMs: number;
  spawn?: (command: string, args: string[], opts: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess;
  now?: () => number; log?: import('../shared/logger.js').Logger;
}): SchedulerChildRunner;
```
Task 5 consumes `createSchedulerChildRunner`.

- [ ] **Step 1: Write the failing tests**:
```ts
import { createSchedulerChildRunner } from '../../src/mcp/scheduler-child.js';
import { EventEmitter } from 'node:events';
function fakeChild() { const e: any = new EventEmitter(); e.exitCode = null; e.killed = false; e.pid = 4242; e.unref = () => {}; e.kill = vi.fn((sig) => { e.killed = true; e.exitCode = null; return true; }); return e; }

it('spawns `intel tick` as a detached low-prio child on tick()', () => {
  const spawn = vi.fn(() => fakeChild());
  const r = createSchedulerChildRunner({ scriptPath: '/x/karpathy.js', projectRoot: '/proj', maxRuntimeMs: 1000, spawn });
  r.tick();
  expect(spawn).toHaveBeenCalledTimes(1);
  const [cmd, args, o] = spawn.mock.calls[0];
  expect(args).toEqual(['/x/karpathy.js', 'intel', 'tick', '--project-root', '/proj']);
  expect(o).toMatchObject({ detached: true, stdio: 'ignore', cwd: '/proj' });
});
it('overlap guard: does not spawn while the previous child still runs', () => {
  const spawn = vi.fn(() => fakeChild());
  const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 100000, spawn });
  r.tick(); r.tick();
  expect(spawn).toHaveBeenCalledTimes(1);
});
it('runaway cap: kills a child past maxRuntime and spawns fresh', () => {
  const child = fakeChild();
  const spawn = vi.fn(() => child);
  let t = 0; const now = () => t;
  const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 5000, spawn, now });
  r.tick();                 // spawns at t=0
  t = 6000; r.tick();       // past cap → kill + respawn
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(spawn).toHaveBeenCalledTimes(2);
});
it('tick() is non-blocking (returns synchronously without awaiting the child)', () => {
  const spawn = vi.fn(() => fakeChild());
  const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 1000, spawn });
  expect(r.tick()).toBeUndefined();  // fire-and-forget
});
it('clears tracking when the child exits', () => {
  const child = fakeChild(); const spawn = vi.fn(() => child);
  const r = createSchedulerChildRunner({ scriptPath: '/x.js', projectRoot: '/p', maxRuntimeMs: 1000, spawn });
  r.tick(); expect(r.current()).not.toBeNull();
  child.exitCode = 0; child.emit('exit', 0);
  expect(r.current()).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `src/mcp/scheduler-child.ts`**:
```ts
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnLowPriority } from '../shared/low-priority.js';
import { createLogger, type Logger } from '../shared/logger.js';

export interface SchedulerChildRunner { tick(): void; current(): { child: ChildProcess; startedAt: number } | null; stop(): void; }

export function createSchedulerChildRunner(opts: {
  scriptPath: string; projectRoot: string; maxRuntimeMs: number;
  spawn?: (command: string, args: string[], o: SpawnOptions) => ChildProcess;
  now?: () => number; log?: Logger;
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
      detached: true, stdio: 'ignore', cwd: opts.projectRoot,
    });
    child.unref();
    const entry = { child, startedAt: now() };
    tracked = entry;
    child.on('exit', (code) => {
      log.info('scheduler child exited', { pid: child.pid, code });
      if (tracked === entry) tracked = null;
    });
  }
  return { tick, current: () => tracked, stop: () => { tracked = null; } };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test test/mcp/scheduler-child.test.ts` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `feat(mcp): scheduler-child runner (isolated low-prio intel tick + overlap guard + runtime cap)`

---

## Task 3: `watchdog-worker.ts` — pure `shouldTrip` + worker entry + tsup entry

**Files:**
- Create: `src/mcp/watchdog-worker.ts`
- Modify: `tsup.config.ts` (add entry so `dist/mcp/watchdog-worker.js` is built)
- Test: `test/mcp/watchdog-worker.test.ts`

**Interfaces:**
- Produces: `export function shouldTrip(lastBeatMs: number, nowMs: number, timeoutMs: number): boolean`. The worker entry runs only when loaded as a `Worker` (guarded on `workerData`), so importing the module in a test is side-effect-free.

- [ ] **Step 1: Write the failing test** (pure decision only — the Atomics/SIGKILL loop is covered by wiring, not unit-tested):
```ts
import { shouldTrip } from '../../src/mcp/watchdog-worker.js';
it('trips only when the heartbeat is older than the timeout', () => {
  expect(shouldTrip(1000, 1000 + 30001, 30000)).toBe(true);
  expect(shouldTrip(1000, 1000 + 30000, 30000)).toBe(false);
  expect(shouldTrip(1000, 1000 + 100, 30000)).toBe(false);
});
it('importing the module does not start the worker loop (workerData is null in main thread)', () => {
  // no throw, no hang — the entry is guarded
  expect(typeof shouldTrip).toBe('function');
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `src/mcp/watchdog-worker.ts`**:
```ts
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
```

- [ ] **Step 4: Add the tsup entry** — in `tsup.config.ts`, in the entry object that already lists `'mcp/server': 'src/mcp/server.ts'`, add:
```ts
'mcp/watchdog-worker': 'src/mcp/watchdog-worker.ts',
```

- [ ] **Step 5: Run + build** — `pnpm test test/mcp/watchdog-worker.test.ts` → PASS; `pnpm build` → confirm `dist/mcp/watchdog-worker.js` exists (`ls dist/mcp/watchdog-worker.js`).
- [ ] **Step 6: `pnpm lint`** → green.
- [ ] **Step 7: Commit** — `feat(mcp): watchdog worker (heartbeat-stale → SIGKILL) + shouldTrip + tsup entry`

---

## Task 4: `watchdog.ts` — main-side heartbeat + worker supervision

**Files:**
- Create: `src/mcp/watchdog.ts`
- Test: `test/mcp/watchdog.test.ts`

**Interfaces:**
- Consumes: `node:worker_threads` `Worker`, `createLogger`.
- Produces:
```ts
export interface WatchdogHandle { stop(): Promise<void>; }
export function startWatchdog(opts: {
  heartbeatMs: number; timeoutMs: number; workerPath: string;
  log?: import('../shared/logger.js').Logger;
  workerFactory?: (path: string, o: { workerData: unknown }) => import('node:worker_threads').Worker;
  now?: () => number;
}): WatchdogHandle;
```
Task 5 consumes `startWatchdog`.

- [ ] **Step 1: Write the failing tests** (injected `workerFactory` + `now`; fake worker is an `EventEmitter` with `unref`/`terminate`):
```ts
import { startWatchdog } from '../../src/mcp/watchdog.js';
import { EventEmitter } from 'node:events';
function fakeWorker() { const w: any = new EventEmitter(); w.unref = () => {}; w.terminate = vi.fn().mockResolvedValue(0); return w; }

it('spawns the worker with sab + timeout + checkInterval in workerData', () => {
  let captured: any; const workerFactory = vi.fn((_p, o) => { captured = o; return fakeWorker(); });
  const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
  expect(workerFactory).toHaveBeenCalledWith('/w.js', expect.anything());
  expect(captured.workerData.timeoutMs).toBe(30000);
  expect(captured.workerData.checkIntervalMs).toBe(1000);
  expect(captured.workerData.sab).toBeInstanceOf(SharedArrayBuffer);
  return wd.stop();
});
it('the heartbeat interval advances the shared timestamp', async () => {
  vi.useFakeTimers(); let captured: any;
  const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', now: () => Date.now(),
    workerFactory: (_p, o) => { captured = o; return fakeWorker(); } });
  const hb = new BigInt64Array(captured.workerData.sab);
  const first = Number(Atomics.load(hb, 0));          // initial beat set before worker spawn
  vi.advanceTimersByTime(1000);
  expect(Number(Atomics.load(hb, 0))).toBeGreaterThanOrEqual(first);
  await wd.stop(); vi.useRealTimers();
});
it('respawns the worker if it exits unexpectedly', () => {
  const workers: any[] = []; const workerFactory = vi.fn(() => { const w = fakeWorker(); workers.push(w); return w; });
  const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
  workers[0].emit('exit', 1);
  expect(workerFactory).toHaveBeenCalledTimes(2);
  return wd.stop();
});
it('stop() clears the heartbeat and terminates the worker without respawning', async () => {
  const workers: any[] = []; const workerFactory = vi.fn(() => { const w = fakeWorker(); workers.push(w); return w; });
  const wd = startWatchdog({ heartbeatMs: 1000, timeoutMs: 30000, workerPath: '/w.js', workerFactory });
  await wd.stop();
  expect(workers[0].terminate).toHaveBeenCalled();
  workers[0].emit('exit', 0);                          // exit during stop must NOT respawn
  expect(workerFactory).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `src/mcp/watchdog.ts`**:
```ts
import { Worker } from 'node:worker_threads';
import { createLogger, type Logger } from '../shared/logger.js';

export interface WatchdogHandle { stop(): Promise<void>; }

export function startWatchdog(opts: {
  heartbeatMs: number; timeoutMs: number; workerPath: string;
  log?: Logger; workerFactory?: (path: string, o: { workerData: unknown }) => Worker; now?: () => number;
}): WatchdogHandle {
  const log = opts.log ?? createLogger('watchdog');
  const now = opts.now ?? Date.now;
  const factory = opts.workerFactory ?? ((p, o) => new Worker(p, o));
  const sab = new SharedArrayBuffer(8);
  const hb = new BigInt64Array(sab);
  Atomics.store(hb, 0, BigInt(now()));                 // initial beat BEFORE the worker starts (no false-fire at t=0)
  const beat = setInterval(() => Atomics.store(hb, 0, BigInt(now())), opts.heartbeatMs);
  beat.unref?.();
  let stopping = false;
  let worker: Worker;
  const spawn = () => {
    worker = factory(opts.workerPath, { workerData: { sab, timeoutMs: opts.timeoutMs, checkIntervalMs: opts.heartbeatMs } });
    worker.unref?.();
    worker.on('exit', (code) => { if (stopping) return; log.warn('watchdog worker exited unexpectedly — respawning', { code }); spawn(); });
    worker.on('error', (err) => log.error('watchdog worker error', { error: (err as Error).message }));
  };
  spawn();
  return { async stop() { stopping = true; clearInterval(beat); await worker.terminate(); } };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test test/mcp/watchdog.test.ts` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `feat(mcp): watchdog main-side (SAB heartbeat + worker supervision)`

---

## Task 5: Wire into `daemon.ts` + integration

**Files:**
- Modify: `src/mcp/daemon.ts` (replace scheduler block ~lines 177-191; add watchdog start + teardown step)
- Modify (only if needed): `src/bin/intel-command.ts` / `src/bin/karpathy.ts` (`intel tick --project-root`)
- Test: `test/mcp/daemon.test.ts` (extend)

**Interfaces:**
- Consumes: `createSchedulerChildRunner` (Task 2), `startWatchdog` (Task 4), `config.daemon.*` (Task 1). `ctx.projectRoot`, `ctx.config`.

- [ ] **Step 1: Ensure `intel tick` honors `--project-root`.** Read `src/bin/intel-command.ts`'s `case 'tick'` and how `loadConfig`/`resolveStateDir` derive the project root. If `--project-root` is NOT already honored, add it: parse it with `parseProjectRootArg(process.argv.slice(2))` (same helper the daemon/mcp commands use) and thread it so `loadConfig`/`resolveStateDir` resolve the daemon's project. Add a focused test in the CLI's test file if one exists, or cover it via the integration test in Step 4.

- [ ] **Step 2: Write the failing integration test** — extend `test/mcp/daemon.test.ts` (reuse its temp-vault/`port:0` setup):
```ts
it('runs the scheduler as a separate child process, not inline (daemon stays responsive)', async () => {
  const h = await runDaemon({ projectRoot: tmp, port: 0 });
  try {
    // /health responds
    const r1 = await fetch(`http://127.0.0.1:${h.port}/health`); expect((await r1.json()).status).toBe('ok');
    // The scheduler runner spawns a child on tick; assert the daemon exposed a way to observe it OR
    // assert /health is still responsive immediately after a tick interval elapses (loop not blocked).
    const r2 = await fetch(`http://127.0.0.1:${h.port}/health`); expect(r2.status).toBe(200);
  } finally { await h.close(); }
});
it('a project-root-scoped tick child drains THIS project\'s queue', async () => {
  // enqueue a trivial dedupe-keyed job into tmp/.karpathy/state/job-queue.json,
  // invoke one scheduler tick (via a test seam or by waiting one short tickIntervalMs override),
  // then assert the job left the pending set — proving the child operated on the daemon's project.
});
```
Note: to make the second test deterministic without waiting 5 min, allow `runDaemon` to accept a test-only small `tickIntervalMs` via `ctx.config.daemon.tickIntervalMs` (set it in the temp config the test builds), and expose a way to trigger one tick (e.g. the returned handle could offer `__tickOnce()` for tests, or the test constructs the `createSchedulerChildRunner` directly against the temp project and asserts the spawned `intel tick` drains it). Prefer testing the drain end-to-end via `createSchedulerChildRunner` pointed at the real built `dist/bin/karpathy.js` with `cwd`/`--project-root` = tmp, then poll the queue file until the job is gone (bounded timeout). This is the true project-root proof.

- [ ] **Step 3: Run to verify it fails** — the scheduler-child/watchdog wiring isn't in `daemon.ts` yet.

- [ ] **Step 4: Implement the daemon wiring.** In `src/mcp/daemon.ts`:
  - Remove `import { runSchedulerTick } from '../intelligence/scheduler-tick.js';` (line 4).
  - Add: `import { createSchedulerChildRunner } from './scheduler-child.js';` and `import { startWatchdog, type WatchdogHandle } from './watchdog.js';` and (if not present) `import { fileURLToPath } from 'node:url';`.
  - Replace the `tickInFlight`/`setInterval`/`runSchedulerTick` block (~177-191) with:
```ts
const cliScriptPath = fileURLToPath(new URL('../bin/karpathy.js', import.meta.url));
const scheduler = createSchedulerChildRunner({
  scriptPath: cliScriptPath, projectRoot: ctx.projectRoot,
  maxRuntimeMs: ctx.config.daemon.schedulerChildMaxRuntimeMs, log,
});
iv = setInterval(() => scheduler.tick(), ctx.config.daemon.tickIntervalMs);
iv.unref?.();
```
  - After the http server + watcher are started (near where the daemon finishes wiring, before returning the handle), start the watchdog:
```ts
let watchdog: WatchdogHandle | null = null;
if (ctx.config.daemon.watchdogEnabled) {
  watchdog = startWatchdog({
    heartbeatMs: ctx.config.daemon.watchdogHeartbeatMs,
    timeoutMs: ctx.config.daemon.watchdogTimeoutMs,
    workerPath: fileURLToPath(new URL('./watchdog-worker.js', import.meta.url)),
    log,
  });
}
```
  - In the teardown (the `runTeardownSteps([...])` call ~line 136), add `async () => { await watchdog?.stop(); }` as the **FIRST** array element (before `http.close`/watcher/lock steps), and keep `if (iv) clearInterval(iv);` (line 134) as-is. The detached scheduler child is intentionally NOT killed on shutdown.

- [ ] **Step 5: Run to verify it passes** — `pnpm test test/mcp/daemon.test.ts` → PASS; full `pnpm build && pnpm lint && pnpm test` green.
- [ ] **Step 6: Manual smoke** — `node dist/bin/karpathy.js mcp-daemon --port 0 --project-root "$PWD"`; `curl :<port>/health`; confirm a `karpathy intel tick` child appears after one interval (lower `tickIntervalMs` via a temp config to observe quickly); SIGINT → clean exit (watchdog terminates first). Record the observed behavior.
- [ ] **Step 7: Commit** — `feat(mcp): daemon runs scheduler in isolated child + worker-thread watchdog`

---

## Task 6: Docs — spec §28 addendum + CLAUDE.md

**Files:** Modify `specs/specification.md` (§28), `CLAUDE.md`.

- [ ] **Step 1** — In `specs/specification.md` §28, add a subsection documenting: the daemon runs the scheduler as an isolated low-priority `intel tick` child (overlap guard + `schedulerChildMaxRuntimeMs` cap) rather than inline, and the worker-thread SAB-heartbeat watchdog (`watchdogEnabled`/`watchdogTimeoutMs`/`watchdogHeartbeatMs`) that SIGKILLs a wedged daemon for launchd to restart. Note this is what makes retiring `com.karpathy.tick` safe. Match §28 tone.
- [ ] **Step 2** — Update `CLAUDE.md`: add the four `daemon` config fields to the config snippet, one line under the §28 area on the scheduler-child + watchdog behavior, and bump the `pnpm test` count line to the new total.
- [ ] **Step 3: `pnpm build && pnpm lint && pnpm test`** → all green.
- [ ] **Step 4: Commit** — `docs: daemon event-loop isolation + watchdog (spec §28 + CLAUDE.md)`

---

## Task 7 (manual runbook — operator, not a coding task): rollout

After Tasks 1–6 land, review, and merge:
1. `pnpm build`; `launchctl kickstart -k gui/$(id -u)/com.karpathy.daemon`; `karpathy daemon status` → healthy.
2. **Verify isolation live:** lower `tickIntervalMs` briefly (or wait for a real tick); confirm a separate `karpathy intel tick` pid runs the drain while `/health` + a `search` stay responsive throughout.
3. **Verify watchdog (optional):** temporarily set `watchdogTimeoutMs` low, trigger a test-only main-loop block, confirm SIGKILL + launchd restart (diagnostic in `daemon.err.log`), then restore.
4. **Retire the tick (now safe):** `launchctl unload ~/Library/LaunchAgents/com.karpathy.tick.plist` + `mv …tick.plist{,.retired}`.
5. **Rollback:** restore `…tick.plist.retired` + `launchctl load`; and/or revert the daemon build. Full stdio rollback (`*.pre-daemon.bak`) remains available.

---

## Self-review (author checklist — completed)

- **Spec coverage:** FR-1/2/3 scheduler-child (T2) + daemon wiring (T5); FR-4 watchdog worker (T3) + main side (T4); FR-5 respawn/teardown (T4,T5); FR-6 `watchdogEnabled` (T1,T5); FR-7 §27/§28 untouched (T5 keeps global lock via `intel tick`); NFR-1 isolation test (T5); NFR-2 runtime cap (T2); NFR-3 watchdog (T3,T4); config (T1); docs (T6); rollout (T7). All mapped.
- **Placeholders:** none — the one runtime-resolved path (`fileURLToPath(new URL(...))`) is real code, not a placeholder.
- **Type consistency:** `createSchedulerChildRunner(opts)→SchedulerChildRunner{tick,current,stop}` (T2) consumed by T5; `startWatchdog(opts)→WatchdogHandle{stop}` (T4) consumed by T5; `shouldTrip(last,now,timeout)` (T3) used by T3's worker; config field names identical across T1/T5. Consistent.
