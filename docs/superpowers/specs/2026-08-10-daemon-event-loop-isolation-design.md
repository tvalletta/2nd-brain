# Daemon Event-Loop Isolation + Watchdog — Design Spec

**Date:** 2026-08-10
**Status:** Design (pre-implementation)
**Author:** Tom Valletta + Claude Opus 4.8
**Related:** `specs/specification.md` §28 (shared MCP daemon), `docs/superpowers/specs/2026-08-06-shared-mcp-daemon-design.md`, `docs/superpowers/plans/2026-08-06-shared-mcp-daemon.md`, memory `project-crash-root-cause`

---

## 1. Context & motivation

The shared MCP daemon (§28) consolidated ~22 stdio servers + the launchd tick into one process. On 2026-08-07, an attempt to retire the launchd `com.karpathy.tick` job exposed a real defect:

- The daemon runs the scheduler drain **inline on the same Node event loop that serves MCP** (`src/mcp/daemon.ts` — `setInterval` → `await runSchedulerTick(...)` → `runner.runAll()` → job handlers).
- Job handlers do **synchronous** `better-sqlite3` work (FTS, embeddings, store queries). A single-threaded event loop cannot serve HTTP/MCP, answer `GET /health`, or fire timers while a synchronous native call runs.
- A heavy scheduled job pegged the daemon at **94% CPU and blocked everything** — MCP requests from all windows, `/health`, and even the 120 s job-timeout (its callback cannot run on a blocked loop). Recovery required a manual `launchctl kickstart -k`.

The launchd tick had shielded the daemon by running these jobs in a **separate process**. Retiring it removed that shield. This spec restores the shield *inside the daemon's ownership* and adds an auto-recovery safety net, so the daemon becomes stable, robust, and reliable enough to be the sole process.

**Two blocking sources exist:** (1) the scheduler drain [the incident], and (2) in principle a pathological tool-call query (e.g. an unusually heavy `search`). Component 1 eliminates (1). Component 2 auto-recovers from (2) or any unforeseen main-loop block.

## 2. Goals & non-goals

**Goals**
1. No scheduler job ever executes on the daemon's serving event loop.
2. The daemon stays `/health`-responsive and serves MCP *while* heavy background jobs run.
3. If the serving loop ever blocks anyway (>threshold), the daemon auto-restarts with no human intervention.
4. A runaway/stuck background drain cannot stall scheduling forever or waste CPU indefinitely.
5. `com.karpathy.tick` can finally be retired safely (the daemon owns scheduling via an isolated child).
6. Fully reversible; existing §27/§28 locks, caps, and behavior unchanged.

**Non-goals**
- Moving tool-call SQLite into worker threads (the "Full isolation" option) — deferred; §27 already bounds tool queries (topK-limited `search`, deprecated `search_vault`), so the watchdog is sufficient coverage for the rare tool-call case. Revisit only if the watchdog fires in practice.
- Any change to job semantics, the queue, the global runner lock, or memory bounds.
- Rewriting in another language (see §28.1.1).

## 3. Requirements

### Functional
- **FR-1** The daemon's scheduler interval spawns `karpathy intel tick` as a **detached, low-priority child process** (via `spawnLowPriority`, Task 5) instead of running `runSchedulerTick` inline. The daemon does no heavy scheduler work on its own loop.
- **FR-2** **Overlap guard:** if the previous scheduler child is still running when the interval fires, the daemon does not spawn another.
- **FR-3** **Runaway cap:** if a scheduler child has been running longer than `daemon.schedulerChildMaxRuntimeMs`, the daemon SIGKILLs it (releasing its locks via stale-PID reclaim) before spawning a fresh one.
- **FR-4** A **worker-thread watchdog** monitors main-loop liveness via a `SharedArrayBuffer` heartbeat and, if the loop is stale by more than `daemon.watchdogTimeoutMs`, force-terminates the process (`process.kill(process.pid, 'SIGKILL')`) so launchd restarts it.
- **FR-5** The watchdog is armed after startup and torn down first on graceful shutdown; if the watchdog worker exits unexpectedly it is re-spawned.
- **FR-6** `daemon.watchdogEnabled` (default `true`) can disable the watchdog without code change.
- **FR-7** All of §27/§28 (global `queue-runner` lock, job caps, memory bounds, single-instance `mcp-daemon` lock, single watcher, stdio fallback) remain intact.

### Non-functional (stable / robust / reliable)
- **NFR-1 (stable)** `/health` and MCP tool calls remain responsive (<1 s) while a background drain runs — proven by an integration test that runs a deliberately slow job in the child and asserts `/health` still answers.
- **NFR-2 (robust)** No single stuck/spinning/OOM background job can wedge the daemon: it runs in an isolated child (crash/OOM/spin cannot touch the serving loop), and is runtime-capped (FR-3).
- **NFR-3 (reliable)** Any main-loop block >`watchdogTimeoutMs` self-heals via watchdog → SIGKILL → launchd restart, with a stderr diagnostic recording why.

## 4. Architecture / end state

```
                    ┌──────────────────────────────────────────────────────────┐
  Claude windows ──▶│  daemon (com.karpathy.daemon)  — one persistent process   │
                    │                                                          │
                    │  MAIN THREAD (serving loop)                              │
                    │   ├─ HTTP/MCP transport + /health   (NEVER heavy SQLite) │
                    │   ├─ single vault watcher                               │
                    │   ├─ heartbeat: Atomics.store(sab, Date.now()) every 1s │
                    │   └─ scheduler setInterval ──► spawn low-prio CHILD ─────┼──► `karpathy intel tick`
                    │        (overlap guard + runtime cap; never inline)       │     (own process: drain →
                    │                                                          │      LLM/FTS/embedding/sync SQLite,
                    │  WATCHDOG WORKER THREAD                                   │      §27 queue-runner lock)
                    │   └─ every checkInterval: read sab via Atomics;          │
                    │      if stale > watchdogTimeoutMs → SIGKILL own process  │
                    └──────────────────────────────────────────────────────────┘
                                     │ SIGKILL → launchd KeepAlive{Crashed} restart
```

Before: scheduler drain ran inline on the serving loop (could block it). After: drain runs in an isolated, runtime-capped child; a separate watchdog thread guarantees recovery if the loop ever blocks.

## 5. Component breakdown (file structure)

| Component | File (new/changed) | Responsibility | Depends on |
|-----------|--------------------|----------------|------------|
| **Scheduler child runner** | `src/mcp/scheduler-child.ts` (new) | Spawn `intel tick` as a detached low-prio child on demand; overlap guard; runtime cap kill; expose current child | `spawnLowPriority` (Task 5), `node:child_process` |
| **Watchdog (main side)** | `src/mcp/watchdog.ts` (new) | Create the SAB, run the heartbeat interval, spawn the watchdog worker, re-spawn on exit, stop() | `node:worker_threads` |
| **Watchdog worker** | `src/mcp/watchdog-worker.ts` (new, tsup entry) | Own-loop check of the SAB heartbeat via `Atomics`; on stale → stderr diagnostic + `process.kill(pid,'SIGKILL')` | `node:worker_threads` |
| **Daemon wiring** | `src/mcp/daemon.ts` (changed) | Use scheduler-child instead of inline `runSchedulerTick`; start/stop watchdog + heartbeat; teardown ordering | the three above |
| **Config** | `src/config/schema.ts` (changed) | `daemon.watchdogEnabled/watchdogTimeoutMs/watchdogHeartbeatMs/schedulerChildMaxRuntimeMs` | — |
| **Build** | `tsup.config` (changed) | Add `watchdog-worker` as a build entry so `dist/mcp/watchdog-worker.js` exists for `new Worker(path)` | — |

Each unit is independently testable: `scheduler-child.ts` with an injected `spawn`; `watchdog.ts` with an injected clock/worker factory; `watchdog-worker.ts`'s decision function pure-tested with an injected `now`/`kill`.

## 6. Component 1 — Scheduler child runner (`scheduler-child.ts`)

### Interface
```ts
export interface SchedulerChildOptions {
  scriptPath: string;         // absolute path to dist/bin/karpathy.js
  projectRoot: string;        // ctx.projectRoot — child cwd
  maxRuntimeMs: number;       // daemon.schedulerChildMaxRuntimeMs
  spawn?: typeof spawnLowPriority; // injectable for tests (default: spawnLowPriority)
  now?: () => number;         // injectable clock (default Date.now)
  log?: Logger;
}
export interface SchedulerChildRunner {
  tick(): void;               // called on each daemon interval; spawns iff allowed
  current(): { child: ChildProcess; startedAt: number } | null;
  stop(): void;               // stop tracking (does NOT kill a detached running child)
}
export function createSchedulerChildRunner(opts: SchedulerChildOptions): SchedulerChildRunner;
```

### Behavior of `tick()`
1. If a tracked child exists and is still running (`child.exitCode === null`):
   - If `now() - startedAt >= maxRuntimeMs` → `child.kill('SIGKILL')`, log `scheduler child exceeded maxRuntime — killed` (its `queue-runner`/note locks are reclaimed by the next holder via stale-PID detection), clear tracking, then fall through to spawn a fresh one.
   - Else → log `scheduler tick skipped — previous child still running` and return (overlap guard).
2. Spawn: `spawn(process.execPath, [scriptPath, 'intel', 'tick'], { detached: true, stdio: 'ignore', cwd: projectRoot })`, `child.unref()`, record `{ child, startedAt: now() }`, and `child.on('exit', ...)` to clear tracking + log the exit code.

### Rationale / notes
- **Reuses the proven `intel tick`** (the same command the launchd tick ran for months) — no new drain path. The child does backfill + cursor-import + `tickScheduler` + `runAll` in its own process; its synchronous SQLite/LLM work is fully off the daemon's loop.
- **Coordination:** the child's `runAll` acquires the §27 global `queue-runner` lock; a manual CLI `intel tick` or any other drainer coordinates through the same lock. No double-drain.
- **Project root:** the child resolves config/stateDir the same way the launchd tick did (global `~/.karpathy/config.json` + `cwd`). Implementation must verify `intel tick` operates on the daemon's project when spawned with `cwd: projectRoot`; if resolution is not reliably cwd-based, add a `--project-root` pass-through to the `intel tick` CLI case (small, additive).
- **Low priority:** `spawnLowPriority` wraps `taskpolicy -b` (Task 5), so the child runs at background QoS.

### Daemon change
Replace the current inline block:
```ts
// OLD (daemon.ts): let tickInFlight=false; setInterval(async()=>{ ...await runSchedulerTick(...)... })
```
with:
```ts
const scheduler = createSchedulerChildRunner({
  scriptPath: <dist/bin/karpathy.js>, projectRoot: ctx.projectRoot,
  maxRuntimeMs: ctx.config.daemon.schedulerChildMaxRuntimeMs, log,
});
const iv = setInterval(() => scheduler.tick(), ctx.config.daemon.tickIntervalMs);
iv.unref();
```
Remove the `runSchedulerTick` import from `daemon.ts` (it stays the CLI `intel tick` implementation, unchanged). Kick one `scheduler.tick()` shortly after startup is optional (the launchd tick had `RunAtLoad`); default: wait one interval (avoids a heavy drain during boot).

## 7. Component 2 — Watchdog (`watchdog.ts` + `watchdog-worker.ts`)

### Main side (`watchdog.ts`)
```ts
export interface WatchdogOptions {
  heartbeatMs: number;        // daemon.watchdogHeartbeatMs (default 1000)
  timeoutMs: number;          // daemon.watchdogTimeoutMs (default 30000)
  workerPath: string;         // absolute path to dist/mcp/watchdog-worker.js
  log?: Logger;
  workerFactory?: (path: string, opts: WorkerOptions) => Worker; // injectable for tests
}
export interface WatchdogHandle { stop(): Promise<void>; }
export function startWatchdog(opts: WatchdogOptions): WatchdogHandle;
```
- Create `const sab = new SharedArrayBuffer(8); const hb = new BigInt64Array(sab);` and set an initial beat `Atomics.store(hb, 0, BigInt(Date.now()))` **before** creating the worker (no false-fire at t=0).
- Start `const beat = setInterval(() => Atomics.store(hb, 0, BigInt(Date.now())), heartbeatMs); beat.unref();` — this write is the only thing that stops when the main loop blocks.
- Spawn the worker: `workerFactory(workerPath, { workerData: { sab, timeoutMs, checkIntervalMs: heartbeatMs } })`; `worker.unref()`.
- On worker `'exit'` (unexpected, i.e. not during `stop()`): log `watchdog worker exited unexpectedly — respawning` and re-create it (protection must survive a worker crash).
- `stop()`: mark stopping, `clearInterval(beat)`, `await worker.terminate()`.

### Worker side (`watchdog-worker.ts`)
- Read `{ sab, timeoutMs, checkIntervalMs }` from `workerData`; wrap `sab` in a `BigInt64Array`.
- `setInterval(() => { const last = Number(Atomics.load(hb, 0)); const age = Date.now() - last; if (age > timeoutMs) trip(age); }, checkIntervalMs)`.
- `trip(age)`: write a synchronous diagnostic to fd 2 (`fs.writeSync(2, \`[watchdog] main loop unresponsive for ${age}ms — SIGKILL pid ${process.pid}\n\`)`) then `process.kill(process.pid, 'SIGKILL')`. SIGKILL is uncatchable and terminates the whole process even if the main thread is in a native call → launchd `KeepAlive{Crashed:true}` restarts a fresh daemon.
- Factor the decision as a pure, testable function: `shouldTrip(lastBeatMs, nowMs, timeoutMs): boolean`.

### Daemon wiring
- After startup completes: `const watchdog = ctx.config.daemon.watchdogEnabled ? startWatchdog({ heartbeatMs, timeoutMs, workerPath }) : null;`
- Teardown: call `await watchdog?.stop()` **first** in `runTeardownSteps` (before closing http / releasing locks) so it can't fire during a clean shutdown, then the existing steps.

### Why SharedArrayBuffer + Atomics
`postMessage` heartbeats would ride the worker's message queue; more importantly a blocked main loop can't `postMessage`. A `SharedArrayBuffer` timestamp is written by the main loop's heartbeat interval and read by the worker's independent loop with no cross-thread scheduling — the worker sees staleness the instant the main loop stops beating.

## 8. Config contract (`daemon` additions)

```jsonc
"daemon": {
  // ...existing: host, port, tickIntervalMs, sessionIdleTimeoutMs, heapMb, authToken
  "watchdogEnabled": true,            // FR-6 kill switch
  "watchdogTimeoutMs": 30000,         // main-loop-stale threshold before SIGKILL
  "watchdogHeartbeatMs": 1000,        // heartbeat + worker check cadence
  "schedulerChildMaxRuntimeMs": 600000 // 10 min: kill a runaway/stuck scheduler child
}
```
All optional/defaulted, backward-compatible (mirrors §28's `DaemonConfigSchema` wiring, incl. `PartialDaemonConfigSchema`).

## 9. Lifecycle / state machine

```
 startup → applySelfLowPriority → ctx → single-instance lock → http transport → vault watcher
         → scheduler interval (child runner) → set initial heartbeat → start watchdog worker → SERVING

 SERVING:
   every tickIntervalMs → scheduler.tick():  spawn child (unless overlap) / kill+respawn if child > maxRuntime
   every heartbeatMs     → main writes Date.now() to SAB
   watchdog worker loop  → reads SAB; stale > timeoutMs → SIGKILL self

 SIGTERM/SIGINT (graceful) → teardown: watchdog.stop() FIRST → clearInterval(scheduler) → http.close()
                             → watcher stop/release → release mcp-daemon lock → exit 0
                             (detached scheduler child is left to finish; it's independent)

 SIGKILL (watchdog or launchd) → launchd KeepAlive{Crashed:true} → fresh daemon
```

## 10. Failure modes

| Failure | Behaviour / mitigation |
|---------|------------------------|
| Scheduled job spins/blocks (today's incident) | Runs in the **child**, not the serving loop → daemon stays responsive. Child is runtime-capped (FR-3) → SIGKILL'd after `schedulerChildMaxRuntimeMs`; next interval spawns a fresh one. |
| Scheduled job OOMs | Child crashes in isolation; job stays pending, retried next cycle; daemon unaffected. |
| Pathological tool-call query blocks the loop | Watchdog detects stale heartbeat → SIGKILL → launchd restart (auto-recovery). Diagnostic in `daemon.err.log`. |
| Watchdog false positive | Only fires if the loop is genuinely stale >`watchdogTimeoutMs` (30 s) — with heavy work off-loop this should never happen in normal serving; a 30 s block *is* a fault worth restarting. Tunable; disableable via `watchdogEnabled`. |
| Watchdog worker itself crashes | Main side re-spawns it on `'exit'`; protection restored. If re-spawn also fails, daemon still serves (logs the loss of protection). |
| Overlapping scheduler children | Overlap guard skips spawning while one runs. |
| Child holds `queue-runner` lock then is SIGKILL'd | Lock file's PID is now dead → reclaimed by the next holder via §27 stale-PID detection. |
| Graceful shutdown races the watchdog | `watchdog.stop()` runs first in teardown; heartbeat interval cleared; worker terminated. |
| `dist/mcp/watchdog-worker.js` missing | Build must include it as a tsup entry; startup logs and (config permitting) proceeds without the watchdog rather than crashing (fail-open on the safety net, not the daemon). |

## 11. Interaction with existing code

- **`daemon.ts` (Task 7):** the inline `runSchedulerTick` + `tickInFlight` block is replaced by the scheduler-child runner; `runTeardownSteps` gains `watchdog.stop()` (first) and keeps the existing http/watcher/lock steps; the detached scheduler child is intentionally **not** killed on shutdown.
- **`runSchedulerTick` (Task 4):** unchanged — remains the CLI `intel tick` body, now invoked only as a child process.
- **`spawnLowPriority` (Task 5):** reused verbatim for the scheduler child.
- **§27 locks/caps:** untouched; the child still takes the global `queue-runner` lock.
- **Retiring `com.karpathy.tick`:** now safe (rollout §14) — the daemon-spawned child is the isolated equivalent.

## 12. Security
No change. Loopback-only HTTP; the watchdog worker and scheduler child are local, no new surface. `process.kill(self, SIGKILL)` targets only the daemon's own pid.

## 13. Testing strategy

- **`scheduler-child.ts` (unit, injected `spawn`+`now`):** `tick()` spawns `intel tick` with `detached/cwd/low-prio`; a second `tick()` while the child "runs" (fake `exitCode===null`) does **not** spawn (overlap); a child past `maxRuntimeMs` is `kill('SIGKILL')`'d and a fresh one spawned; `stop()` clears tracking without killing.
- **`watchdog-worker.ts` (unit, pure):** `shouldTrip(last, now, timeout)` true iff `now-last>timeout`; a table of cases.
- **`watchdog.ts` (unit, injected worker factory + clock):** sets initial heartbeat before worker creation; heartbeat interval writes the SAB; re-spawns worker on unexpected `'exit'`; `stop()` clears interval + terminates worker and suppresses re-spawn.
- **Integration — isolation (NFR-1):** boot a daemon (real, `port:0`) whose scheduler child runs a **deliberately slow** job (a test fixture job that sleeps/holds sync work ~3 s); assert `GET /health` and a `listTools` call **return promptly during** that window (proves serving is not blocked). Confirm the child is a separate pid.
- **Integration — watchdog recovery (NFR-3):** add a **test-only** guarded path that blocks the main loop synchronously beyond `watchdogTimeoutMs` (short timeout in the test, e.g. 500 ms) with an injected `kill` capturing the SIGKILL; assert `shouldTrip` fires and the injected kill is invoked. (End-to-end real-SIGKILL-then-launchd-restart is verified manually in rollout, not in CI.)
- **Regression:** full suite green; stdio + all §27/§28 tests unaffected.

## 14. Rollout & reversibility

1. Merge + `pnpm build`; `launchctl kickstart -k gui/$(id -u)/com.karpathy.daemon` to load the new code. Verify `/health` ok.
2. **Verify isolation live:** trigger/await a heavy scheduled drain (or wait for one) and confirm `/health` + a `search` stay responsive throughout, and the drain runs as a separate `karpathy intel tick` pid.
3. **Verify watchdog live (optional):** temporarily lower `watchdogTimeoutMs`, hit a test-only block, confirm the daemon SIGKILLs + launchd restarts (diagnostic in `daemon.err.log`), then restore the timeout.
4. **Retire the tick (now safe):** `launchctl unload ~/Library/LaunchAgents/com.karpathy.tick.plist` + `mv …tick.plist{,.retired}`. The daemon-spawned child now owns scheduling.
5. **Rollback:** restore `…tick.plist.retired` + `launchctl load` (re-enables the separate-process tick), and/or `launchctl kickstart -k` on the prior daemon build. Full stdio rollback (restore `*.pre-daemon.bak` configs) remains available.

## 15. Sequencing / phases (for the plan)

1. **P1** — config additions (`watchdogEnabled/watchdogTimeoutMs/watchdogHeartbeatMs/schedulerChildMaxRuntimeMs`).
2. **P2** — `scheduler-child.ts` + unit tests (injected spawn/now).
3. **P3** — `watchdog-worker.ts` (+ pure `shouldTrip`) + `watchdog.ts` + tsup entry + unit tests.
4. **P4** — wire both into `daemon.ts` (replace inline tick; start/stop watchdog; teardown order) + integration tests (isolation, watchdog decision).
5. **P5** — docs (spec §28 addendum + CLAUDE.md) + rollout runbook.
Each phase gated on `pnpm build && pnpm lint && pnpm test`.

## 16. Open decisions (defaults chosen)
- **Scheduler isolation = child process** (not worker_thread): full process isolation, reuses the proven `intel tick`, and the global lock already coordinates it. (Chosen.)
- **Watchdog timeout = 30 s**, heartbeat = 1 s, child max runtime = 10 min (all tunable).
- **Tool-call SQLite stays on the main loop** (bounded by §27; watchdog covers the rare pathological case). Worker-thread-izing tool SQLite is a deferred future phase, not in scope.
- **Watchdog fail-open:** if the worker can't start, the daemon still serves (logs the gap) rather than refusing to boot.
