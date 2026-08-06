# Shared MCP Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 22 per-window stdio MCP servers + the `com.karpathy.tick` launchd job into ONE long-lived, low-priority, sleep-aware HTTP daemon that serves MCP to all Claude Code windows and runs the watcher + scheduler internally (~920 MB → ~60 MB idle).

**Architecture:** A single `karpathy mcp-daemon` process runs an MCP Streamable-HTTP server on `127.0.0.1:<port>/mcp` (one MCP session per window/subagent, all sharing one `ctx`), owns the single file watcher, and runs the scheduler on an internal `setInterval`. stdio transport stays intact as fallback. See design: `docs/superpowers/specs/2026-08-06-shared-mcp-daemon-design.md`.

**Tech Stack:** Node 24, TypeScript (ESM, strict), `@modelcontextprotocol/sdk@1.29.0` (`StreamableHTTPServerTransport` / client `StreamableHTTPClientTransport`), `node:http`, better-sqlite3, launchd, Vitest, tsup.

## Global Constraints

- ESM only — all relative imports end in `.js`. Never use `require`.
- `pnpm build && pnpm lint && pnpm test` must all pass before every commit. Lint is `tsc --noEmit` (strict).
- Never hardcode absolute personal paths in committed source (`/Users/valletta/...`). The plist is a **template** with `{{PORT}}`/`{{PROJECT_ROOT}}`/`{{HEAP_MB}}` placeholders filled at install time.
- Reuse existing primitives: `createFileLock` (`src/jobs/lock.ts`), `createMCPContext` (`src/mcp/context.ts`), `resolveLockDir`/`resolveStateDir` (`src/config/defaults.ts`), `createLogger` (`src/shared/logger.ts`).
- The §27 resource-boundedness locks/caps stand — do not weaken them. The global runner lock (Fix E) already serializes drains; the daemon relies on it.
- Baseline before starting: `pnpm test` = 1321 tests / 157 files, green.
- Bind loopback only (`127.0.0.1`), never `0.0.0.0`.

---

## File structure

**Create:**
- `src/mcp/create-server.ts` — `createMcpServer(ctx)` factory (the 4 request handlers), shared by stdio + HTTP.
- `src/intelligence/scheduler-tick.ts` — `runSchedulerTick(deps)` (tick body, no `process.exit`) + `powerState()` gating.
- `src/shared/low-priority.ts` — `spawnLowPriority()` + `applySelfLowPriority()`.
- `src/mcp/vault-watcher.ts` — `startVaultWatcher(ctx)` (extracted from `server.ts`), shared by stdio + daemon.
- `src/mcp/http-transport.ts` — `startHttpMcpServer(opts)` (node:http, session registry, `/mcp`, `/health`).
- `src/mcp/daemon.ts` — `runDaemon(opts)` entry.
- `bin/com.karpathy.daemon.plist` — launchd template.
- Tests mirroring each under `test/`.

**Modify:**
- `src/config/schema.ts` — add `daemon` config section.
- `src/mcp/server.ts` — use `createMcpServer` + `startVaultWatcher` (dedupe; stdio behavior unchanged).
- `src/bin/intel-command.ts` — `tick` case delegates to `runSchedulerTick`.
- `src/bin/karpathy.ts` — add `mcp-daemon`, `daemon install`, `daemon status` commands.
- `src/hooks/background-drain.ts` — spawn drain child via `spawnLowPriority`.
- `specs/specification.md`, `CLAUDE.md` — docs (§28).

---

## Task 1: `daemon` config section

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema.test.ts` (add cases)

**Interfaces:**
- Produces: `config.daemon: { host: string; port: number; tickIntervalMs: number; sessionIdleTimeoutMs: number; heapMb: number; authToken?: string }` with defaults `{ host: "127.0.0.1", port: 8765, tickIntervalMs: 300000, sessionIdleTimeoutMs: 1800000, heapMb: 512, authToken: undefined }`.

- [ ] **Step 1: Write the failing test** — in `test/config/schema.test.ts`:
```ts
it('applies daemon defaults when unset', () => {
  const cfg = KarpathyConfigSchema.parse({ defaults: { vaultPath: '/v' } }).defaults ?? KarpathyConfigSchema.parse({ vaultPath: '/v' });
  // use whatever the file's existing parse helper is; assert:
  expect(cfg.daemon.host).toBe('127.0.0.1');
  expect(cfg.daemon.port).toBe(8765);
  expect(cfg.daemon.tickIntervalMs).toBe(300000);
  expect(cfg.daemon.sessionIdleTimeoutMs).toBe(1800000);
  expect(cfg.daemon.heapMb).toBe(512);
  expect(cfg.daemon.authToken).toBeUndefined();
});
```
(Match the file's existing schema-parse test pattern — find how other sections like `intelligence` are asserted and mirror it.)

- [ ] **Step 2: Run to verify it fails** — `pnpm test test/config/schema.test.ts` → FAIL (`daemon` undefined).

- [ ] **Step 3: Implement** — add to the config schema (mirror the style of the existing `ingest`/`intelligence` sub-schemas):
```ts
daemon: z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(8765),
  tickIntervalMs: z.number().int().positive().default(300_000),
  sessionIdleTimeoutMs: z.number().int().positive().default(1_800_000),
  heapMb: z.number().int().positive().default(512),
  authToken: z.string().optional(),
}).default({}),
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test test/config/schema.test.ts` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(daemon): add daemon config section"`

---

## Task 2: `createMcpServer(ctx)` factory (dedupe server wiring)

**Files:**
- Create: `src/mcp/create-server.ts`
- Modify: `src/mcp/server.ts:33-55` (replace inline `new Server(...)` + 4 `setRequestHandler` calls with the factory)
- Test: `test/mcp/create-server.test.ts`

**Interfaces:**
- Consumes: `MCPContext` (`src/mcp/context.ts`), `TOOL_DEFINITIONS`, `handleToolCall`, `RESOURCE_DEFINITIONS`, `handleResourceRead`, `buildInstructions`.
- Produces: `export function createMcpServer(ctx: MCPContext): Server` — a fully-wired MCP `Server` (ListTools/CallTool/ListResources/ReadResource handlers + instructions from `ctx.config.layout`). No transport connected.

- [ ] **Step 1: Write the failing test**:
```ts
import { createMcpServer } from '../../src/mcp/create-server.js';
it('wires a server that lists the tool definitions', async () => {
  const ctx = makeFakeCtx(); // minimal: { config: { layout: DEFAULT_LAYOUT, ... } }
  const server = createMcpServer(ctx);
  // The SDK Server exposes registered handlers indirectly; assert construction + that
  // ListTools returns TOOL_DEFINITIONS by invoking the handler the same way server.ts does.
  expect(server).toBeDefined();
});
```
(If the SDK doesn't expose handlers for direct assertion, assert `createMcpServer(ctx)` returns a `Server` instance and that a subsequent `server.connect(new InMemoryTransport())` + a `tools/list` round-trip returns `TOOL_DEFINITIONS`. Use the SDK's in-memory transport pair if available; otherwise keep the construction assertion and cover behavior in Task 5's integration test.)

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement** — move lines 33-55 of `server.ts` into:
```ts
// src/mcp/create-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPContext } from './context.js';
import { TOOL_DEFINITIONS } from './tools/index.js';
import { handleToolCall } from './tools/router.js';
import { RESOURCE_DEFINITIONS, handleResourceRead } from './resources.js';
import { buildInstructions } from './instructions.js';

export function createMcpServer(ctx: MCPContext): Server {
  const server = new Server(
    { name: 'karpathy', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} }, instructions: buildInstructions(ctx.config.layout) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request.params, ctx));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCE_DEFINITIONS }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => handleResourceRead(request.params, ctx));
  return server;
}
```
Then in `server.ts` replace lines 33-55 with `const server = createMcpServer(ctx);` (keep the `import` cleanup).

- [ ] **Step 4: Run** — `pnpm test test/mcp/` → PASS; existing stdio server tests still green.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `feat(mcp): extract createMcpServer factory shared by stdio + http`

---

## Task 3: `startVaultWatcher(ctx)` (dedupe watcher wiring)

**Files:**
- Create: `src/mcp/vault-watcher.ts`
- Modify: `src/mcp/server.ts:112-167` (replace inline watcher block with the helper)
- Test: `test/mcp/vault-watcher.test.ts`

**Interfaces:**
- Consumes: `MCPContext`, `acquireWatcherLock`/`createFileWatcher` (`src/ingest/watcher.ts`), `ingestFile`, `resolveLockDir`.
- Produces: `export async function startVaultWatcher(ctx: MCPContext): Promise<VaultWatcherHandle | null>` where
```ts
export interface VaultWatcherHandle { stop(): void; release(): Promise<void>; }
```
Returns `null` when `ingest.watchEnabled` is false OR the watcher lock is held by another live process (same skip semantics as today). The returned handle's `stop()` stops chokidar; `release()` releases the watcher lock.

- [ ] **Step 1: Write the failing test** — assert that with a pre-held live watcher lock, `startVaultWatcher(ctx)` returns `null` (mirror `test/ingest/watcher-lock.test.ts`'s lock-holding setup); and with the lock free + `watchEnabled:true`, it returns a handle whose `stop`/`release` are callable. Use a temp vault dir.

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement** — lift the exact logic from `server.ts:112-167` into `startVaultWatcher(ctx)`: `if (!watchEnabled) return null;` → `acquireWatcherLock(resolveLockDir(ctx.config))` → if `!acquired` return null → build `watchPaths`, `enqueueFtsSync`, `createFileWatcher(...)` with the same `onFile/onChange/onUnlink`, `watcher.start()`, and return `{ stop: () => watcher.stop(), release: watcherLock.release }`. Then in `server.ts`, replace the block with:
```ts
const vw = await startVaultWatcher(ctx);
if (vw) {
  watcher = { stop: vw.stop } as unknown as FileWatcher; // or store vw directly
  releaseWatcherLock = vw.release;
  server.onclose = () => { void shutdown('server-onclose'); };
}
```
(Adjust `server.ts`'s `watcher`/`releaseWatcherLock` variables to hold the handle; keep `shutdown()` semantics identical.)

- [ ] **Step 4: Run** — `pnpm test test/mcp/ test/ingest/` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `refactor(mcp): extract startVaultWatcher shared by stdio + daemon`

---

## Task 4: `runSchedulerTick(deps)` + power-gating (extract tick body)

**Files:**
- Create: `src/intelligence/scheduler-tick.ts`
- Modify: `src/bin/intel-command.ts:241-294` (`tick` case delegates)
- Test: `test/intelligence/scheduler-tick.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `resolveStateDir`, `resolveLockDir`, `createFsAdapter`, `createJobQueue`, `tickScheduler`, `defaultSchedule`, `createJobRunner`, `createHandlerRegistry`, `createLLMFromConfig`, `maybeRunAutoBackfill`, `importNewCursorSessions`.
- Produces:
```ts
export const HEAVY_SCHEDULED_JOBS = ['decay-scan','digest-weekly','research-propose','rot-scan'] as const;
export interface PowerState { onBattery: boolean; thermallyConstrained: boolean; }
export async function powerState(): Promise<PowerState>; // wraps `pmset -g batt` / `pmset -g therm`; best-effort, defaults to unconstrained on error/non-macOS
export interface SchedulerTickResult { fired: {type:string;reason:string}[]; skipped: string[]; processed: number; heavyDeferred: boolean; }
export async function runSchedulerTick(deps: { config: KarpathyConfig; stateDir: string; powerState?: () => Promise<PowerState> }): Promise<SchedulerTickResult>;
```
- Behavior: identical to today's `tick` body (backfill + cursor import + createJobQueue + tickScheduler + runner.runAll) EXCEPT (a) no `process.exit`; (b) when `powerState()` reports `onBattery || thermallyConstrained`, the schedule passed to `tickScheduler` is filtered to exclude `HEAVY_SCHEDULED_JOBS` and `heavyDeferred:true` is returned (light `sync-fts-index` etc. still fire and drain).

- [ ] **Step 1: Write the failing test**:
```ts
it('defers heavy scheduled jobs when on battery', async () => {
  const deps = { config: makeConfig(tmpVault, tmpState), stateDir: tmpState,
                 powerState: async () => ({ onBattery: true, thermallyConstrained: false }) };
  const res = await runSchedulerTick(deps);
  expect(res.heavyDeferred).toBe(true);
  // none of HEAVY_SCHEDULED_JOBS appear in res.fired
  expect(res.fired.map(f=>f.type).some(t => HEAVY_SCHEDULED_JOBS.includes(t as any))).toBe(false);
});
it('runs full schedule on AC power and returns processed count', async () => {
  const res = await runSchedulerTick({ config, stateDir, powerState: async () => ({ onBattery:false, thermallyConstrained:false }) });
  expect(res.heavyDeferred).toBe(false);
  expect(typeof res.processed).toBe('number');
});
```
(Build `config`/`stateDir` with temp dirs the way existing intelligence tests do.)

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement** — move `intel-command.ts:242-292` (minus `process.exit`) into `runSchedulerTick`, returning the result object. Add `powerState()` using `execFile('pmset',['-g','batt'])` / `['-g','therm']` parsed best-effort (try/catch → unconstrained). Filter the schedule when constrained:
```ts
const constrained = ps.onBattery || ps.thermallyConstrained;
const schedule = defaultSchedule({ reviewEnabled: config.maintenance.reviewEnabled })
  .filter(s => !constrained || !HEAVY_SCHEDULED_JOBS.includes(s.type));
```
(Confirm `defaultSchedule` returns an array with a `.type` per entry; adapt the filter to its actual shape.)

- [ ] **Step 4: Modify `intel-command.ts` `tick` case** to:
```ts
case 'tick': {
  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  const res = await runSchedulerTick({ config, stateDir });
  const fired = res.fired.map(f => `${f.type} (${f.reason})`).join(', ') || 'nothing';
  process.stdout.write(`Scheduler tick: fired ${fired}; skipped ${res.skipped.length}; drained ${res.processed} job(s)${res.heavyDeferred ? ' [heavy deferred: low power]' : ''}.\n`);
  process.exit(0);
}
```

- [ ] **Step 5: Run** — `pnpm test test/intelligence/scheduler-tick.test.ts` + existing intel tests → PASS.
- [ ] **Step 6: `pnpm build && pnpm lint`** → green.
- [ ] **Step 7: Commit** — `feat(scheduler): extract runSchedulerTick with power-gating; intel tick delegates`

---

## Task 5: `low-priority.ts` + wire the Stop-hook drain child

**Files:**
- Create: `src/shared/low-priority.ts`
- Modify: `src/hooks/background-drain.ts` (spawn via helper)
- Test: `test/shared/low-priority.test.ts`, extend `test/hooks/background-drain.test.ts`

**Interfaces:**
- Produces:
```ts
export function taskpolicyAvailable(): boolean;  // stat /usr/bin/taskpolicy
export function buildLowPriorityInvocation(command: string, args: string[]): { command: string; args: string[] };
  // -> taskpolicy present: { command: 'taskpolicy', args: ['-b','--', command, ...args] }; else { command, args }
export function spawnLowPriority(command: string, args: string[], opts: SpawnOptions): ChildProcess;
export function applySelfLowPriority(nice?: number): void; // os.setPriority(0, nice ?? 5), try/catch
```

- [ ] **Step 1: Write the failing test**:
Signature: `buildLowPriorityInvocation(command: string, args: string[], availableOverride?: boolean)` — `availableOverride` defaults to `taskpolicyAvailable()`; injectable for tests.
```ts
it('wraps in taskpolicy -b when available', () => {
  const inv = buildLowPriorityInvocation('node', ['x.js'], /*availableOverride*/ true);
  expect(inv).toEqual({ command: 'taskpolicy', args: ['-b', '--', 'node', 'x.js'] });
});
it('falls back to direct invocation when taskpolicy missing', () => {
  const inv = buildLowPriorityInvocation('node', ['x.js'], /*availableOverride*/ false);
  expect(inv).toEqual({ command: 'node', args: ['x.js'] });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** the helper as specified; `spawnLowPriority` composes `buildLowPriorityInvocation` then `spawn`.
- [ ] **Step 4: Wire `background-drain.ts`** — replace the `spawn(process.execPath, [script,'drain-queue'], {...})` call with `spawnLowPriority(process.execPath, [script,'drain-queue'], {...})`. Keep detached/unref and all Fix-B throttle logic intact.
- [ ] **Step 5: Extend `background-drain.test.ts`** — assert the drain child is spawned through the low-priority path (spy on `spawnLowPriority` or assert the invocation the module uses).
- [ ] **Step 6: Run** — `pnpm test test/shared/ test/hooks/` → PASS.
- [ ] **Step 7: `pnpm build && pnpm lint`** → green.
- [ ] **Step 8: Commit** — `feat(perf): low-priority spawn helper; run Stop-hook drain at background QoS`

---

## Task 6: `http-transport.ts` — session registry, routing, `/health`

**Files:**
- Create: `src/mcp/http-transport.ts`
- Test: `test/mcp/http-transport.test.ts`

**Interfaces:**
- Consumes: `createMcpServer` (Task 2), `MCPContext`, `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/streamableHttp.js`), `node:http`, `node:crypto` `randomUUID`.
- Produces:
```ts
export interface HttpMcpServerOptions { ctx: MCPContext; host: string; port: number; sessionIdleTimeoutMs: number; authToken?: string; now?: () => number; }
export interface HttpMcpServerHandle { port: number; url: string; sessionCount(): number; sweepIdle(): number; close(): Promise<void>; }
export async function startHttpMcpServer(opts: HttpMcpServerOptions): Promise<HttpMcpServerHandle>;
```
- Behavior (SDK v1.29 stateful pattern):
  - `http.createServer` on `opts.host:opts.port`; resolve actual port (for `port:0`) via `server.address()`.
  - `GET /health` → 200 JSON `{ status:'ok', pid, version:'0.1.0', uptimeSec, sessions, watcherActive:<caller-set flag or omit here>, lastTickAt:null }`. (`/health` need not know watcher/tick — daemon can expose a richer one; keep this transport-level health minimal: status, pid, uptimeSec, sessions.)
  - `POST /mcp`: read body; if `authToken` set, require `Authorization: Bearer <token>` else 401. If no `mcp-session-id` header AND body is an `initialize` request → create `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => sessions.set(sid, entry) })`, `const server = createMcpServer(ctx); await server.connect(transport);` then `await transport.handleRequest(req, res, body)`. Set `transport.onclose = () => sessions.delete(sid)`. If `mcp-session-id` present → look up; unknown → 404 JSON-RPC error; else `transport.handleRequest(req,res,body)` and bump `lastActivityAt`.
  - `GET /mcp` and `DELETE /mcp`: route to the session's `transport.handleRequest`.
  - `sweepIdle()`: close+delete sessions whose `lastActivityAt < now() - sessionIdleTimeoutMs`; return count. (The daemon owns the interval that calls it; the transport just exposes it for testability.)
  - `close()`: close all session transports, then `httpServer.close()`.
  - Follow the exact request-handling shape in the SDK's `streamableHttp.d.ts` example (lines ~33-43): `sessionIdGenerator`, `transport.handleRequest(req, res, parsedBody)`.

- [ ] **Step 1: Write the failing test** (integration-style, real loopback, ephemeral port):
```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
it('serves two concurrent MCP clients from one server and cleans up sessions', async () => {
  const ctx = await makeRealCtx(tmpProjectRoot); // createMCPContext against a temp vault+config
  const h = await startHttpMcpServer({ ctx, host: '127.0.0.1', port: 0, sessionIdleTimeoutMs: 60000 });
  const mk = async () => { const c = new Client({name:'t',version:'1'}); await c.connect(new StreamableHTTPClientTransport(new URL(h.url))); return c; };
  const [a, b] = await Promise.all([mk(), mk()]);
  const ta = await a.listTools(); const tb = await b.listTools();
  expect(ta.tools.length).toBeGreaterThan(0);
  expect(tb.tools.length).toBe(ta.tools.length);
  expect(h.sessionCount()).toBe(2);
  await a.close(); await b.close();
  await h.close();
});
it('GET /health returns session count', async () => {
  const h = await startHttpMcpServer({ ctx, host:'127.0.0.1', port:0, sessionIdleTimeoutMs: 60000 });
  const r = await fetch(`http://127.0.0.1:${h.port}/health`); const j = await r.json();
  expect(j.status).toBe('ok'); expect(typeof j.pid).toBe('number');
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** `http-transport.ts` per the interface + SDK pattern above.
- [ ] **Step 4: Run** — `pnpm test test/mcp/http-transport.test.ts` → PASS (two clients, one server).
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `feat(mcp): streamable-http transport with per-session registry + health`

---

## Task 7: `daemon.ts` + `mcp-daemon` CLI (wire it all)

**Files:**
- Create: `src/mcp/daemon.ts`
- Modify: `src/bin/karpathy.ts` (add `mcp-daemon` command)
- Test: `test/mcp/daemon.test.ts`

**Interfaces:**
- Consumes: `createMCPContext`, `startHttpMcpServer` (Task 6), `startVaultWatcher` (Task 3), `runSchedulerTick` (Task 4), `applySelfLowPriority` (Task 5), `createFileLock`/`resolveLockDir`, `config.daemon`.
- Produces: `export async function runDaemon(opts: { projectRoot: string; port?: number; host?: string }): Promise<DaemonHandle>` where
```ts
export interface DaemonHandle { port: number; url: string; close(): Promise<void>; }
```
- Behavior:
  1. `applySelfLowPriority(5)`.
  2. `ctx = await createMCPContext(projectRoot)`.
  3. Single-instance: `const release = await createFileLock(resolveLockDir(ctx.config)).acquire('mcp-daemon')` — on `LockError`, log `daemon already running` and return/exit 0.
  4. `const http = await startHttpMcpServer({ ctx, host: opts.host ?? ctx.config.daemon.host, port: opts.port ?? ctx.config.daemon.port, sessionIdleTimeoutMs: ctx.config.daemon.sessionIdleTimeoutMs, authToken: ctx.config.daemon.authToken })`.
  5. `const vw = await startVaultWatcher(ctx)` (always the single watcher).
  6. Scheduler: `let tickInFlight = false; const iv = setInterval(async () => { if (tickInFlight) return; tickInFlight = true; try { await runSchedulerTick({ config: ctx.config, stateDir: resolveStateDir(ctx.config) }); } catch(e){ log.error(...) } finally { tickInFlight = false; } }, ctx.config.daemon.tickIntervalMs); iv.unref?.()` — plus `const idleIv = setInterval(() => http.sweepIdle(), ctx.config.daemon.sessionIdleTimeoutMs)`.
  7. Graceful shutdown (`SIGTERM`,`SIGINT`): `clearInterval(iv); clearInterval(idleIv); await http.close(); vw?.stop(); await vw?.release(); await release(); process.exit(0)`.
  8. Return `{ port: http.port, url: http.url, close }` for tests.
- CLI: in `karpathy.ts`, add `case 'mcp-daemon':` → parse `--port`/`--project-root` (reuse `parseProjectRootArg`) → `await runDaemon({ projectRoot, port })`. Do NOT `process.exit` (long-lived).

- [ ] **Step 1: Write the failing test** — boot `runDaemon({ projectRoot: tmp, port: 0 })`, hit `/health`, connect one client, call `search` (or `vault_status`), assert a result, then `await handle.close()` and assert the port is freed (a second `startHttpMcpServer` on the same explicit port would succeed — or just assert close resolves and `/health` now refuses). Also assert a **second** `runDaemon` while the first holds the lock returns without binding (single-instance).

- [ ] **Step 2: Run to verify it fails** — module not found.
- [ ] **Step 3: Implement** `daemon.ts` + the CLI case per the interface.
- [ ] **Step 4: Run** — `pnpm test test/mcp/daemon.test.ts` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Manual smoke** — `node dist/bin/karpathy.js mcp-daemon --port 0 --project-root "$PWD"` in one shell; `curl 127.0.0.1:<port>/health` in another; Ctrl-C → clean exit. (Record the observed RSS for the design's ~60 MB claim.)
- [ ] **Step 7: Commit** — `feat(mcp): mcp-daemon entry — http + watcher + scheduler in one low-priority process`

---

## Task 8: launchd plist template + `daemon install` / `daemon status`

**Files:**
- Create: `bin/com.karpathy.daemon.plist` (template with `{{PORT}}`,`{{PROJECT_ROOT}}`,`{{HEAP_MB}}`)
- Modify: `src/bin/karpathy.ts` (add `daemon install` + `daemon status`)
- Test: `test/bin/daemon-install.test.ts` (template rendering only — no real launchctl)

**Interfaces:**
- Produces: `renderDaemonPlist({ port, projectRoot, heapMb, scriptPath }): string` (pure, testable); `daemon install` writes it to `~/Library/LaunchAgents/com.karpathy.daemon.plist` and prints the manual `launchctl load` + config-migration steps (does NOT auto-edit `~/.claude*` — that's the runbook). `daemon status` GETs `http://<host>:<port>/health` and prints it.

- [ ] **Step 1: Write the failing test** — `renderDaemonPlist({port:8765,projectRoot:'/p',heapMb:512,scriptPath:'/p/bin/karpathy-with-env.sh'})` contains `<string>mcp-daemon</string>`, `ProcessType`→`Adaptive`, `LowPriorityIO`→true, `Nice`→5, `--max-old-space-size=512`, and **no** `StartInterval`/`WakeInterval`/`StartCalendarInterval`.
- [ ] **Step 2: Run to verify it fails** — function not found.
- [ ] **Step 3: Implement** `renderDaemonPlist` (string template = the plist from design §9) + the two CLI subcommands.
- [ ] **Step 4: Run** — `pnpm test test/bin/daemon-install.test.ts` → PASS.
- [ ] **Step 5: `pnpm build && pnpm lint`** → green.
- [ ] **Step 6: Commit** — `feat(daemon): plist template + daemon install/status commands`

---

## Task 9: Docs — spec §28 + CLAUDE.md

**Files:** Modify `specs/specification.md` (new `## 28. Shared MCP daemon`), `CLAUDE.md` (Resource-boundedness section + spec pointer + test-count line).

- [ ] **Step 1** — Add spec §28 summarizing: the daemon (http transport, one process, sessions), retirement of `com.karpathy.tick`, the three NFRs (efficient/sleep-aware/low-priority) and how they're met, and the reversible rollout. Match existing spec tone.
- [ ] **Step 2** — Update `CLAUDE.md`: add the `mcp-daemon`/`daemon install`/`daemon status` commands, the `daemon` config block, note the stdio fallback, and bump the test-count line to the new total.
- [ ] **Step 3: `pnpm build && pnpm lint && pnpm test`** → all green.
- [ ] **Step 4: Commit** — `docs: shared MCP daemon (spec §28 + CLAUDE.md)`

---

## Task 10 (manual runbook — executed by operator, not a coding task): rollout

Not a TDD task — a checklist to run after Tasks 1-9 land and are reviewed:

1. **Claim a port** via the `control-center` skill; set `config.daemon.port` (or pass `--port`).
2. `pnpm build`; `karpathy daemon install`; fill the plist port; `launchctl load ~/Library/LaunchAgents/com.karpathy.daemon.plist`; `karpathy daemon status` → healthy.
3. **Pilot:** back up `~/.claude.json` and `~/.claude/settings.json`; change ONLY those windows you'll test to `"carpathi": { "type":"http", "url":"http://127.0.0.1:<port>/mcp" }`; open 2 windows + a subagent; verify `search`/hot-cache work and `ps` shows **one** `mcp-daemon` and no new stdio `server.js`.
4. **Flip:** migrate both config files fully; `launchctl unload` + move `com.karpathy.tick.plist` aside (`.bak`).
5. **Verify:** post-reboot, `ps` shows one daemon; `fileproviderd`/OneDrive calm; `.karpathy/logs/daemon.err.log` clean; RSS ≈ target.
6. **Rollback (if needed):** restore config `.bak`; re-enable `com.karpathy.tick.plist`; the stdio `server.js` still works.

---

## Self-review (author checklist — completed)

- **Spec coverage:** daemon/http (T6,T7) · sessions (T6) · shared watcher (T3) · internal scheduler + power-gating (T4) · efficiency/heap/low-prio (T5,T7,T8) · sleep-aware plist (T8) · config (T1) · stdio fallback preserved (T2,T3 keep server.ts working) · reversible rollout (T10) · docs (T9). All §-requirements mapped.
- **Placeholders:** none (`{{PORT}}` etc. are intentional plist template tokens filled by `daemon install`).
- **Type consistency:** `createMcpServer(ctx)` (T2) consumed by T6; `startVaultWatcher(ctx)→VaultWatcherHandle` (T3) consumed by T7; `runSchedulerTick(deps)→SchedulerTickResult` (T4) consumed by T7; `startHttpMcpServer(opts)→HttpMcpServerHandle` (T6) consumed by T7; `spawnLowPriority`/`applySelfLowPriority` (T5) consumed by T7 + background-drain. Names consistent across tasks.
