# Shared MCP Daemon — Design Spec

**Date:** 2026-08-06
**Status:** Design (pre-implementation)
**Author:** Tom Valletta + Claude Opus 4.8
**Related:** `specs/specification.md` §27 (resource-boundedness fixes), `docs/superpowers/plans/2026-06-26-carpathi-mcp-reliability.md`, memory `project-crash-root-cause`

---

## 1. Context & motivation

A root-cause audit of the Mac crashes (memory-pressure / swap-compressor panics) found that Carpathi is not the primary hog, but it is a live aggravator. The specific waste this spec targets:

- **stdio MCP forces one server process per client.** Measured live: **22 concurrent `dist/mcp/server.js` processes** (one per Claude Code window *and per subagent/Task*), totalling **~920 MB RSS idle**.
- Per-process RSS is **~39–44 MB**, of which a bare `node` on this machine is **~33 MB** (the runtime floor) — i.e. the Carpathi app itself is only **~6 MB** of idle state; the watcher-holder adds ~5 MB. **~80% of every process is the Node runtime, duplicated 22×.**
- Separately, a `launchd` `StartInterval` job (`com.karpathy.tick`, every 5 min) spawns a fresh `node` to run the scheduler, and fires a **catch-up burst on wake** from sleep.
- The §27 fixes already made this *safe* (single-watcher lock, global runner lock, job caps, bounded memory). This spec removes the *redundancy*: **collapse 22 stdio servers + the periodic tick spawn into exactly one long-lived, low-priority daemon.**

Expected result: **~920 MB → ~60 MB** idle, one process, no periodic spawns, no wake-catchup.

### 1.1 Why not Rust (recorded decision)

Rust's advantage here is a tiny idle footprint (~5 MB vs Node's ~40 MB). That value scaled with **process count** — it was compelling at ×22 (~800 MB), but this design reduces the count to **one**, where Rust saves only ~35–45 MB on a machine that crashes from a 51 GB Python process. The cost is disqualifying: the daemon is the front door to the entire TypeScript system (better-sqlite3 embeddings + FTS5, hybrid search/RRF, the job queue and every LLM-enrichment handler, config, vault adapter, protected-regions, frontmatter). A Rust daemon would either reimplement all of it (a multi-month rewrite producing two codebases, since the Claude Code hooks and CLI remain TS) or shell back out to Node per call (re-introducing the spawn we are eliminating). The hot path is already native C (SQLite), so Rust would not speed up the I/O-bound workload. **Consolidation is the substitute for Rust, not a complement.** (A future full rewrite could revisit this; out of scope here.)

## 2. Goals & non-goals

**Goals**
1. One long-lived Carpathi process serves MCP to all Claude Code windows/subagents over local HTTP.
2. That process owns the single file watcher and runs the 5-minute scheduler internally, retiring `com.karpathy.tick`.
3. Every Carpathi background process is **extremely efficient** (near-zero idle cost), **sleep-aware** (never runs during sleep, never wakes the machine, no catch-up storm), and **low-priority** (background QoS + low-priority I/O).
4. Fully **reversible**: stdio transport stays intact as fallback; rollout is piloted; rollback is a one-line config revert.

**Non-goals**
- Rewriting any Carpathi logic in another language (see §1.1).
- Changing tool behavior, the vault model, or the job system semantics (the §27 locks/caps stand as-is).
- Multi-machine / networked access (loopback only).
- Auth beyond an optional local bearer token (single-user personal machine).

## 3. Requirements

### Functional
- **FR-1** A `karpathy mcp-daemon` entry point starts an HTTP server on `127.0.0.1:<port>/mcp` speaking MCP Streamable HTTP.
- **FR-2** N concurrent clients (windows + subagents) each get an isolated MCP **session** but share one process, config, SQLite handle lifecycle, and FTS index.
- **FR-3** The daemon runs exactly one file watcher (reusing the Fix-A watcher lock as a guard).
- **FR-4** The daemon runs the scheduler on an internal interval (default 300 s), calling the same tick logic the CLI uses, guarded by the Fix-E global runner lock and a re-entrancy guard.
- **FR-5** A `GET /health` endpoint reports liveness, session count, uptime, last tick, watcher status.
- **FR-6** Graceful shutdown on SIGTERM/SIGINT: stop accepting sessions, close transports, stop watcher, clear the scheduler interval, release locks, exit 0.
- **FR-7** Single-instance: a second daemon instance must detect the first and exit without disruption.
- **FR-8** The existing **stdio** transport (`dist/mcp/server.js`) remains fully functional and unchanged as a fallback.

### Non-functional (the three explicit asks)
- **NFR-1 (efficient)** Idle CPU ≈ 0 (no busy loops; event-driven only). Idle RSS ≤ ~80 MB. V8 heap capped. No unbounded in-process caches.
- **NFR-2 (sleep-aware)** Never holds a power assertion, never `caffeinate`s, never schedules a wake. Frozen during sleep; on wake fires **one** coalesced tick (no backlog), gated by `lastFire`.
- **NFR-3 (low-priority)** launchd `ProcessType = Adaptive` + `LowPriorityIO = true` + `Nice = 5`. Any transient spawned worker (e.g. the Stop-hook drain) runs at background QoS (`taskpolicy -b` / `os.setPriority`).

## 4. Architecture / end state

```
                         ┌─────────────────────────────────────────────┐
  Claude Code window 1 ──┤ HTTP session A (mcp-session-id: A)            │
  Claude Code window 2 ──┤ HTTP session B                               │
  subagent of window 2 ──┤ HTTP session C   ← all share ONE process     │
        ...          ────┤ HTTP session …                              │
                         │                                             │
                         │   com.karpathy.daemon  (launchd, Adaptive)  │
                         │   ┌──────────────┬───────────────┬────────┐ │
                         │   │ HTTP transport│ file watcher  │scheduler│ │
                         │   │ (StreamableHTTP)│ (1 instance) │setInterval│
                         │   └───────┬────────┴──────┬────────┴───┬────┘ │
                         │           └─ shared ctx (config, vault,│      │
                         │              lazy SQLite, job queue) ──┘      │
                         └─────────────────────────────────────────────┘
                                        │
                              .karpathy/state (one queue, one budget,
                               locks) + vault on OneDrive
```

Before: 22 stdio servers (1 watcher) + `com.karpathy.tick` StartInterval spawns. After: this one process.

## 5. Component breakdown

Each component has one purpose, a defined interface, and explicit dependencies; each is independently testable.

| Component | File (new/changed) | Responsibility | Depends on |
|-----------|--------------------|----------------|------------|
| **HTTP transport + session registry** | `src/mcp/http-transport.ts` (new) | node:http server on loopback; route `POST/GET/DELETE /mcp` by `mcp-session-id`; `GET /health`; per-session `Server`+`StreamableHTTPServerTransport`; session lifecycle & cleanup | `@modelcontextprotocol/sdk` StreamableHTTP, shared `ctx`, tool defs/router |
| **Daemon entry** | `src/mcp/daemon.ts` (new) | Build `ctx` once; acquire single-instance lock; start HTTP transport + watcher + scheduler interval; wire graceful shutdown; apply `os.setPriority` | http-transport, watcher, scheduler, lock |
| **Scheduler tick (extracted)** | `src/intelligence/scheduler-tick.ts` (new) or exported from existing tick | `runSchedulerTick(deps)` — the tick body without `process.exit`; power-gating hook | queue, runner, `tickScheduler`, global runner lock |
| **CLI wiring** | `src/bin/karpathy.ts`, `src/bin/intel-command.ts` (changed) | Add `mcp-daemon` command; `intel tick` reuses `runSchedulerTick` then exits | daemon.ts, scheduler-tick |
| **Low-priority spawn helper** | `src/shared/low-priority.ts` (new) | Wrap a child spawn in `taskpolicy -b` when available; set `os.setPriority`; single place for QoS policy | node:child_process |
| **launchd daemon plist** | `bin/com.karpathy.daemon.plist` (new, installed to `~/Library/LaunchAgents`) | KeepAlive daemon, Adaptive QoS, LowPriorityIO, Nice, no StartInterval/Wake | karpathy-with-env.sh |
| **Config migration** | scripted/manual (docs) | Point `carpathi` MCP entries at `type:http`; back up; retire tick plist | control-center (port) |

The existing `src/mcp/server.ts` (stdio) is refactored only to **extract** the shared tool-registration/handler wiring into a helper both transports call — no behavioral change to the stdio path.

## 6. Transport & session contract (API)

Uses the MCP SDK `StreamableHTTPServerTransport` in **stateful** mode.

### Endpoints (all on `http://127.0.0.1:<port>`)
| Method | Path | Purpose | Headers |
|--------|------|---------|---------|
| `POST` | `/mcp` | JSON-RPC requests. An `initialize` with **no** `mcp-session-id` creates a session; the response sets `mcp-session-id`. Subsequent requests must send that header. | `mcp-session-id` (after init), optional `Authorization: Bearer` |
| `GET` | `/mcp` | Opens the server→client SSE stream for notifications (e.g. `tools/list_changed`). | `mcp-session-id` |
| `DELETE` | `/mcp` | Ends a session; server tears down the transport. | `mcp-session-id` |
| `GET` | `/health` | Liveness/diagnostics (see below). | none |

### Session registry (data model)
```ts
interface DaemonSession {
  id: string;                       // mcp-session-id (randomUUID)
  server: Server;                   // MCP SDK Server wired to shared ctx
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastActivityAt: number;
}
// module state in http-transport.ts
const sessions = new Map<string, DaemonSession>();
```
- On `initialize` w/o session id: create transport with `sessionIdGenerator: () => randomUUID()`, connect a fresh `Server` (registers the same tool defs, routes `CallTool` → `handleToolCall(ctx, …)`), store in `sessions`, set `onclose` to delete from the map.
- Route by `mcp-session-id`; unknown id → HTTP 404 + JSON-RPC error (client re-initializes).
- **Idle sweep:** a low-frequency timer (e.g. every 5 min) closes sessions with `lastActivityAt` older than `sessionIdleTimeoutMs` (default 30 min) — prevents leaks if a client vanishes without `DELETE`. (Claude Code re-initializes automatically on next use.)

### `/health` response
```json
{ "status": "ok", "pid": 12345, "version": "0.1.0", "uptimeSec": 3600,
  "sessions": 7, "watcherActive": true, "lastTickAt": "2026-08-06T14:05:00.000Z",
  "queuePending": 0 }
```

### Shared context
`ctx` (config, vault adapter, session-log, hot-cache, `enqueueJob`, lazy `runDeterministicJobs`) is built **once** at daemon start with a fixed `--project-root`. All sessions share it. SQLite/embedding/FTS handles stay **per-call open/close** inside tool handlers (unchanged from today) — no 2 GB-capable handle is held at idle.

## 7. Scheduler contract

`runSchedulerTick(deps): Promise<TickResult>` — extracted from today's `intel tick`:
1. `queue.load()` → `tickScheduler(...)` (enqueue due scheduled jobs) → `runner.runAll()` (drains, already guarded by the **global runner lock**, Fix E).
2. Returns counts; **never** calls `process.exit`.
3. **Power-gating (NFR-1):** before the heavy portion (LLM-enrichment drains, full FTS re-sync), consult `powerState()` (wraps `pmset -g batt` / thermal); when on battery or thermally pressured, skip the heavy jobs this cycle (the light per-file FTS sync still runs). Interactive search is never gated.

Daemon usage: `setInterval(runSchedulerTick, tickIntervalMs)` with a **re-entrancy guard** (`if (tickInFlight) return;`) so a slow tick never overlaps itself. CLI `intel tick` calls the same function then exits (manual runs still work).

## 8. Lifecycle & state machine

```
        launchd RunAtLoad / KeepAlive
                 │
             [STARTING] ── acquire single-instance lock ──┐ (lock held by live pid)
                 │                                         ▼
                 │                                    [EXIT 0] "another daemon running"
        bind 127.0.0.1:port ──(EADDRINUSE & /health ok)──▶[EXIT 0]
                 │ (EADDRINUSE & no health) → EXIT 1 → launchd throttled restart
                 ▼
             [SERVING] ⇄ sessions come/go; watcher live; setInterval ticks
                 │
        SIGTERM/SIGINT (launchd stop, logout)
                 ▼
            [DRAINING] stop new sessions, close transports, stop watcher,
                 │      clearInterval, wait for in-flight tick (bounded), release locks
                 ▼
              [EXIT 0]

  sleep  → process frozen (0 CPU) → wake → one coalesced tick (lastFire-gated)
  crash  → launchd KeepAlive{Crashed:true} restarts (ThrottleInterval 10s)
```

## 9. Efficiency, sleep, low-priority (NFR-1/2/3) — concrete

**launchd `~/Library/LaunchAgents/com.karpathy.daemon.plist`:**
```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/valletta/dev/2nd-brain/bin/karpathy-with-env.sh</string>
  <string>mcp-daemon</string>
  <string>--port</string><string>{{PORT}}</string>
  <string>--project-root</string><string>/Users/valletta/dev/2nd-brain</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Adaptive</string>   <!-- low prio when idle, responsive when serving -->
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>5</integer>
<key>EnvironmentVariables</key><dict>
  <key>NODE_OPTIONS</key><string>--max-old-space-size=512 --max-semi-space-size=8</string>
</dict>
<key>StandardErrorPath</key><string>…/.karpathy/logs/daemon.err.log</string>
<key>StandardOutPath</key><string>…/.karpathy/logs/daemon.out.log</string>
<!-- deliberately NO StartInterval, StartCalendarInterval, or WakeInterval -->
```
- **Efficient:** event-driven; `--max-old-space-size=512` bounds a runaway tool call (heap headroom is safe — `store.allSince` is windowed and FTS is batched per §27); `--max-semi-space-size=8` keeps young-gen GC cheap for a long-lived low-throughput process; idle-session sweep prevents leak growth.
- **Sleep-aware:** KeepAlive (not StartInterval) ⇒ no wake-catchup burst; no power assertions anywhere; `setInterval` pauses during sleep and fires once on wake; `lastFire` gating prevents double-runs.
- **Low-priority:** Adaptive + LowPriorityIO + Nice; `daemon.ts` also calls `os.setPriority(0, 5)` defensively at boot. `src/shared/low-priority.ts` wraps the Stop-hook drain child (`background-drain.ts`) in `taskpolicy -b` (falls back to plain spawn + `os.setPriority` if `taskpolicy` is unavailable).

## 10. Port management

- Claim a **stable** port via the `control-center` skill at install time (per the port-coordination rule); bind **loopback only**. Persist the claimed port to a small file (e.g. `.karpathy/state/daemon-port.json`) read by (a) the plist templating step and (b) the config-migration step, so the URL and the listener never drift. Offline fallback: control-center's documented default range.

## 11. Config migration (exact)

`carpathi` is currently configured as **stdio** in two files:
- `~/.claude.json` → `mcpServers.carpathi = {type:"stdio", command:"node", args:["…/dist/mcp/server.js"], env:{}}`
- `~/.claude/settings.json` → `mcpServers.carpathi = {command:"node", args:["…/dist/mcp/server.js","--project-root","…/2nd-brain"]}`

Migration (both files, after backup `*.bak`):
```json
"carpathi": { "type": "http", "url": "http://127.0.0.1:{{PORT}}/mcp" }
```
Rollback = restore the `.bak` (or revert the two entries) and re-enable the tick plist. The stdio `dist/mcp/server.js` stays on disk and functional throughout.

## 12. Error handling & failure modes

| Failure | Behaviour / mitigation |
|---------|------------------------|
| Daemon down when a window starts | Claude Code marks `carpathi` disconnected; **other tools keep working**; it auto-reconnects (5 tries, 1–16 s backoff) when the daemon returns. launchd `RunAtLoad`+`KeepAlive` keeps it up. |
| Port already bound | If `/health` on it answers as our daemon → this instance exits 0 (single-instance). Else exit 1 → launchd throttled restart. Single-instance FileLock (`mcp-daemon` key) as backstop. |
| Session client vanishes (no DELETE) | Idle sweep closes stale sessions after `sessionIdleTimeoutMs`. |
| Scheduler tick overlaps | Re-entrancy guard skips; global runner lock (Fix E) prevents cross-process concurrent drains. |
| Concurrent job-queue writes (tick vs window-triggered maintenance) | Serialized by the global runner lock; per-note writes by the per-`targetPath` lock. |
| Hung-but-alive daemon (event loop blocked) | launchd only detects crashes, not hangs. Mitigations: purely async I/O (no sync blocking in hot paths); `/health` for external probing; **future** self-watchdog (documented limitation, not in v1). |
| Daemon crash mid-tick | Job stays `pending` (crash before flush) or `completed` (after) — idempotent handlers + dedupe make re-run safe; next tick picks up. |
| Sleep during a tick | Process frozen; resumes and completes on wake. |
| Bad tool call balloons heap | `--max-old-space-size` cap → that call OOMs and is caught per-tool; daemon survives (or crashes → launchd restart), rather than taking the machine down. |

## 13. Security

Bind `127.0.0.1` only (never `0.0.0.0`). On a single-user machine, any local process could otherwise call MCP tools (vault read/limited write). Optional hardening (documented, default off): a bearer token via `Authorization` header, validated by the daemon, supplied in the client config `headers` (or `headersHelper`). Default: no token (loopback trust).

## 14. Rollout & fallback (reversible)

1. **Build** daemon + tests; `pnpm build/lint/test` green; stdio path untouched.
2. **Stand up** the daemon (claim port, install plist, `launchctl load`); verify `/health`.
3. **Pilot** (research flagged multi-client HTTP as implied-not-explicit): point **1–2 windows'** `carpathi` config at `type:http`; verify search + hot-cache work and that only **one** `mcp-daemon` process exists across those windows. Keep all other windows on stdio.
4. **Flip** the global config (both files) to `type:http`; `launchctl unload` + retire `com.karpathy.tick.plist` (the daemon now schedules). Keep both plists' `.bak`.
5. **Rollback** at any point: restore config `.bak` + re-enable the tick plist; existing stdio server binary still works.

## 15. Testing strategy

- **Unit:** session create/route/cleanup + unknown-session 404 (`http-transport`); `/health` shape; `runSchedulerTick` fires and respects the global lock + re-entrancy guard; power-gating skips heavy work on simulated battery; graceful shutdown clears interval + closes sessions + releases locks; `low-priority` helper builds correct `taskpolicy` args and falls back cleanly.
- **Integration:** boot the daemon on an ephemeral port; connect **2 concurrent** `StreamableHTTPClientTransport` clients; both `initialize` (distinct session ids) and both call `search` successfully against one process; disconnect one → its session is swept; `/health` shows the right count.
- **Regression:** all existing stdio + tool tests stay green (fallback preserved).
- **Manual pilot checklist** (step 3 above) documented in the plan.

## 16. Observability

`/health` (above); structured logs to `.karpathy/logs/daemon.{out,err}.log` (session open/close, tick start/finish + counts, watcher events summary, shutdown). Optional: a `karpathy daemon status` CLI that GETs `/health` and prints it.

## 17. Sequencing / implementation phases (dependencies)

1. **P1 — Extract `runSchedulerTick`** (pure refactor; `intel tick` delegates to it). Tests green. *No behavior change.*
2. **P2 — `http-transport.ts`** (sessions, routing, `/health`) + unit tests. Depends on P1 only for `ctx` shape.
3. **P3 — `daemon.ts`** (wire transport + watcher + scheduler interval + single-instance lock + shutdown + `os.setPriority`) + `mcp-daemon` CLI command + **integration test (2 clients)**. Depends on P1, P2.
4. **P4 — `low-priority.ts`** + apply to `background-drain` child. Independent; can land with P3.
5. **P5 — plist + port claim (control-center) + config migration + pilot** (manual). Depends on P3.
6. **P6 — Retire `com.karpathy.tick`** after pilot proves out; update `specs/specification.md` (new §28) + `CLAUDE.md`.

Each phase gated on `pnpm build && pnpm lint && pnpm test`.

## 18. Open decisions (defaults chosen)

- **QoS:** `Adaptive` (recommended) vs `Background`. Default **Adaptive** (keeps search snappy).
- **SQLite handle:** per-call open/close (chosen) vs daemon-lifetime handle (deferred optimization).
- **Auth:** none on loopback (chosen) vs optional bearer token (built, off).
- **Heap cap:** `--max-old-space-size=512` (tunable).
- **Tick interval / idle-session timeout:** 300 s / 1800 s (tunable via config).
