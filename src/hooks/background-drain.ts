import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir } from '../shared/fs-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:background-drain');

/** Default `ingest.stopDrainMinIntervalMs` — see src/config/schema.ts. */
export const DEFAULT_STOP_DRAIN_MIN_INTERVAL_MS = 30_000;

export interface BackgroundDrainOptions {
  /** Resolved lock dir (`resolveLockDir(config)`) — checked for a live `__drain__` holder. */
  lockDir: string;
  /** Resolved state dir (`resolveStateDir(config)`) — home of the last-spawn timestamp file. */
  stateDir: string;
  /** Minimum time between spawns, in ms. Defaults to `ingest.stopDrainMinIntervalMs`'s own default. */
  minIntervalMs?: number;
}

/**
 * Fix B: every Stop hook (end of every turn, across every concurrently
 * running Claude Code session) previously called this unconditionally,
 * spawning a fresh `drain-queue` Node process each time — even when one was
 * already running, or had just run moments ago. Two independent, cheap
 * pre-checks make a spawn redundant and skip it:
 *
 * 1. The `__drain__` lock (`src/bin/karpathy.ts`'s `drainQueueCommand`,
 *    acquired via the same `src/jobs/lock.ts` FileLock used everywhere else
 *    in this codebase) is already held by a live PID — that process will
 *    drain the whole queue itself, so stacking another is pure waste.
 * 2. A spawn happened within the last `minIntervalMs` (default 30s,
 *    `ingest.stopDrainMinIntervalMs`), recorded in `<stateDir>/state/
 *    last-drain.json` — collapses the common case of several Stop hooks
 *    firing in quick succession (e.g. rapid turns in one session).
 *
 * Neither check risks stranding work: the scheduled `intel tick` (launchd,
 * every 5 min) drains the queue regardless of what Stop hooks decide to do.
 */
export async function spawnBackgroundDrain(opts: BackgroundDrainOptions): Promise<void> {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_STOP_DRAIN_MIN_INTERVAL_MS;

  try {
    if (await isDrainLockHeldByLiveProcess(opts.lockDir)) {
      log.info('Skipping background drain — a drain is already in progress');
      return;
    }
    if (await spawnedRecently(opts.stateDir, minIntervalMs)) {
      log.info('Skipping background drain — spawned within the throttle interval', {
        minIntervalMs,
      });
      return;
    }
  } catch (err) {
    // Pre-checks are best-effort. A filesystem hiccup here should never
    // block draining the queue — fall through and spawn as before.
    log.warn('Background-drain pre-checks failed; spawning anyway', {
      error: (err as Error).message,
    });
  }

  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const script = resolve(thisDir, '../../dist/bin/karpathy.js');

    const child = spawn(process.execPath, [script, 'drain-queue'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    log.info('Background drain spawned', { pid: child.pid });
    await recordSpawn(opts.stateDir);
  } catch (err) {
    log.warn('Failed to spawn background drain', { error: (err as Error).message });
  }
}

/**
 * Mirrors `src/jobs/lock.ts`'s own lock-file naming (`lockFilePath`) for the
 * `__drain__` key without needing a `FileLock` instance (which would try to
 * acquire/mutate it) — this is a read-only liveness peek.
 */
async function isDrainLockHeldByLiveProcess(lockDir: string): Promise<boolean> {
  const lockPath = join(lockDir, '__drain__.lock');
  let content: string;
  try {
    content = await readFile(lockPath, 'utf-8');
  } catch {
    return false; // no lock file — nothing running
  }
  try {
    const { pid } = JSON.parse(content) as { pid: number };
    process.kill(pid, 0);
    return true; // still alive
  } catch {
    return false; // dead PID, or unparseable — treat as not held
  }
}

interface LastDrainState {
  lastSpawnAt: number;
}

function lastDrainStatePath(stateDir: string): string {
  // `stateDir` is already the resolved `.karpathy/state` directory
  // (`resolveStateDir(config)`) — same convention as `job-queue.json`
  // living directly inside it (src/mcp/context.ts).
  return join(stateDir, 'last-drain.json');
}

async function spawnedRecently(stateDir: string, minIntervalMs: number): Promise<boolean> {
  if (minIntervalMs <= 0) return false;
  try {
    const raw = await readFile(lastDrainStatePath(stateDir), 'utf-8');
    const { lastSpawnAt } = JSON.parse(raw) as LastDrainState;
    if (typeof lastSpawnAt !== 'number') return false;
    return Date.now() - lastSpawnAt < minIntervalMs;
  } catch {
    return false; // no state file yet — first spawn is never throttled
  }
}

async function recordSpawn(stateDir: string): Promise<void> {
  const statePath = lastDrainStatePath(stateDir);
  try {
    await ensureDir(dirname(statePath));
    const state: LastDrainState = { lastSpawnAt: Date.now() };
    await writeFile(statePath, JSON.stringify(state), 'utf-8');
  } catch (err) {
    log.warn('Failed to record background-drain spawn timestamp', {
      error: (err as Error).message,
    });
  }
}
