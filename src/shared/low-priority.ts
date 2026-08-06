import { accessSync, constants } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setPriority } from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('shared:low-priority');

/**
 * Candidate install locations for the `taskpolicy` binary. The plan doc
 * (`docs/superpowers/plans/2026-08-06-shared-mcp-daemon.md`) specifies
 * `/usr/bin/taskpolicy`, but real macOS installs ship it at
 * `/usr/sbin/taskpolicy` (verified via `which taskpolicy` on Darwin
 * 25.6.0) — checking both keeps the documented path while ensuring the
 * QoS wiring actually engages on real machines instead of silently
 * always falling back.
 */
const TASKPOLICY_CANDIDATES = ['/usr/bin/taskpolicy', '/usr/sbin/taskpolicy'];

/** True if a usable `taskpolicy` binary is present and executable on this machine. */
export function taskpolicyAvailable(): boolean {
  for (const path of TASKPOLICY_CANDIDATES) {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

/**
 * Builds the `{ command, args }` pair that runs `command args...` at macOS
 * background QoS via `taskpolicy -b`, falling back to the bare invocation
 * when `taskpolicy` isn't available (e.g. non-macOS).
 *
 * `availableOverride` defaults to `taskpolicyAvailable()` and is injectable
 * for tests.
 */
export function buildLowPriorityInvocation(
  command: string,
  args: string[],
  availableOverride: boolean = taskpolicyAvailable(),
): { command: string; args: string[] } {
  if (availableOverride) {
    return { command: 'taskpolicy', args: ['-b', '--', command, ...args] };
  }
  return { command, args };
}

/**
 * Spawns `command args...` wrapped in `taskpolicy -b` (macOS background QoS)
 * when available, otherwise spawns it directly. Fire-and-forget callers
 * (e.g. the Stop-hook background drain) only track the returned
 * `ChildProcess` — never its own argv — so the argv0 change this introduces
 * when `taskpolicy` is used is transparent to them.
 */
export function spawnLowPriority(
  command: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcess {
  const inv = buildLowPriorityInvocation(command, args);
  return spawn(inv.command, inv.args, opts);
}

/**
 * Best-effort: lowers this process's own scheduling priority (a proxy for
 * macOS background QoS when `taskpolicy` isn't applicable, e.g. for the
 * daemon's own process rather than a spawned child). Never throws —
 * `os.setPriority` can fail under sandboxing/permission restrictions, and
 * callers should treat this as advisory only.
 */
export function applySelfLowPriority(nice?: number): void {
  try {
    setPriority(0, nice ?? 5);
  } catch (err) {
    log.debug('applySelfLowPriority failed (non-fatal)', { error: (err as Error).message });
  }
}
