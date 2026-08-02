// Phase 0: reflection budget tracker.
//
// Daily-rolling LLM call budget by tier (`fast`/`medium`/`heavy`). Handlers
// `tryReserve(tier)` before issuing an LLM call; if the budget is exhausted
// the call is skipped and the handler can fall back to a cheaper path or
// re-enqueue the job for tomorrow.
//
// State persists at `.karpathy/state/budget.json`. The day key is the local
// ISO date (YYYY-MM-DD); transitioning across midnight resets the counters
// lazily on first read.
//
// Concurrency: Fix E's queue-runner lock (`src/jobs/runner.ts`) now ensures
// only one job-queue drain runs at a time across processes, which covers the
// overwhelming majority of `tryReserve` callers. The narrower remaining race
// — a synchronous CLI path (e.g. `karpathy review analyze`) invoked outside
// the job queue at the same moment a drain is in progress, both racing
// between `budget.json`'s load and flush — is handled by Fix H: `tryReserve`
// (and `reset`) re-read state and serialize their read-modify-write via a
// `createFileLock(lockDir)` acquire/release under a `'budget'` key whenever
// `lockDir` is supplied. Across projects the counters are independent —
// that's intentional, the budget is per-project.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './logger.js';
import { createFileLock, type FileLock } from '../jobs/lock.js';
import { LockError } from './errors.js';

const log = createLogger('budget');

/** Fix H: dedicated key on the shared per-project `lockDir` — distinct
 *  namespace from the runner's per-`targetPath` locks and Fix E's
 *  `'queue-runner'` key, so no collisions. */
const BUDGET_LOCK_KEY = 'budget';
/** Bounded-wait retry defaults — budget critical sections are a single small
 *  JSON read+write, so a short, tight retry loop (~500ms total) is enough. */
const BUDGET_LOCK_MAX_ATTEMPTS = 25;
const BUDGET_LOCK_RETRY_MS = 20;

/**
 * Fix H: serialize a read-modify-write critical section across tracker
 * instances/processes sharing the same `lockDir`. `FileLock.acquire` throws
 * `LockError` immediately (rather than blocking) when a *different*
 * `FileLock` instance already holds the key, so contention is handled here
 * with a short bounded retry instead of surfacing as an error. If the lock
 * is still contended after the retry budget, this proceeds unlocked rather
 * than denying the reservation or hanging indefinitely — budget tracking is
 * a soft rate-limit, not correctness-critical data.
 */
async function withBudgetLock<T>(fileLock: FileLock | null, fn: () => T): Promise<T> {
  if (!fileLock) return fn();
  for (let attempt = 1; attempt <= BUDGET_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const release = await fileLock.acquire(BUDGET_LOCK_KEY);
      try {
        return fn();
      } finally {
        await release();
      }
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
      if (attempt === BUDGET_LOCK_MAX_ATTEMPTS) {
        log.warn('budget lock contended past retry budget; proceeding unlocked', {
          attempts: BUDGET_LOCK_MAX_ATTEMPTS,
        });
        return fn();
      }
      await new Promise((resolve) => setTimeout(resolve, BUDGET_LOCK_RETRY_MS));
    }
  }
  /* istanbul ignore next -- unreachable: loop above always returns or throws */
  return fn();
}

export type BudgetTier = 'fast' | 'medium' | 'heavy';

export interface BudgetLimits {
  fast: number;
  medium: number;
  heavy: number;
}

interface BudgetState {
  date: string; // YYYY-MM-DD
  used: { fast: number; medium: number; heavy: number };
}

export interface BudgetTracker {
  /** Reserve one call for `tier`; resolves false if the day's budget is exhausted. */
  tryReserve(tier: BudgetTier): Promise<boolean>;
  /** Read the remaining budget for a tier without reserving. */
  remaining(tier: BudgetTier): number;
  /** Snapshot of today's usage. */
  snapshot(): BudgetState;
  /** Wipe today's counters (used by tests / manual reset). */
  reset(): Promise<void>;
}

function todayKey(now: Date = new Date()): string {
  // Use local-date so midnight rollovers feel correct to the user.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyState(): BudgetState {
  return { date: todayKey(), used: { fast: 0, medium: 0, heavy: 0 } };
}

function loadState(filePath: string): BudgetState {
  if (!existsSync(filePath)) return emptyState();
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as BudgetState;
    if (parsed?.date !== todayKey()) {
      // Day has rolled over.
      return emptyState();
    }
    // Defensive: ensure all keys exist even if file was hand-edited.
    return {
      date: parsed.date,
      used: {
        fast: parsed.used?.fast ?? 0,
        medium: parsed.used?.medium ?? 0,
        heavy: parsed.used?.heavy ?? 0,
      },
    };
  } catch (err) {
    log.warn('budget state corrupt; resetting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyState();
  }
}

function persistState(filePath: string, state: BudgetState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export interface CreateBudgetTrackerOptions {
  /** Absolute path to `.karpathy/state/budget.json`. */
  statePath: string;
  /** Per-tier daily limits. */
  limits: BudgetLimits;
  /** When false, every reservation succeeds (legacy / unbounded mode). */
  enabled: boolean;
  /**
   * Fix H: optional lock directory. When set, `tryReserve`/`reset`'s
   * read-modify-write is serialized across processes via
   * `createFileLock(lockDir)` under a `'budget'` key, and re-reads committed
   * state from disk before mutating — so two tracker instances (independent
   * processes, or independent in-process trackers) racing between load and
   * flush no longer clobber each other's reservations. Omit for backward
   * compat (no locking, matches pre-Fix-H behavior).
   */
  lockDir?: string;
}

export function createBudgetTracker(opts: CreateBudgetTrackerOptions): BudgetTracker {
  let state = loadState(opts.statePath);
  const fileLock = opts.lockDir ? createFileLock(opts.lockDir) : null;

  function refreshIfRolledOver() {
    if (state.date !== todayKey()) state = emptyState();
  }

  return {
    async tryReserve(tier) {
      if (!opts.enabled) return true;
      return withBudgetLock(fileLock, () => {
        // Re-read from disk inside the lock so concurrent tracker instances
        // observe each other's committed reservations instead of clobbering
        // them with a stale in-memory count from construction time.
        state = loadState(opts.statePath);
        refreshIfRolledOver();
        const limit = opts.limits[tier];
        if (state.used[tier] >= limit) {
          log.info('budget exhausted', { tier, limit, used: state.used[tier] });
          return false;
        }
        state.used[tier] += 1;
        persistState(opts.statePath, state);
        return true;
      });
    },
    remaining(tier) {
      if (!opts.enabled) return Number.POSITIVE_INFINITY;
      refreshIfRolledOver();
      return Math.max(0, opts.limits[tier] - state.used[tier]);
    },
    snapshot() {
      refreshIfRolledOver();
      return { date: state.date, used: { ...state.used } };
    },
    async reset() {
      return withBudgetLock(fileLock, () => {
        state = emptyState();
        persistState(opts.statePath, state);
      });
    },
  };
}

/** Build the canonical budget state path under the project's state dir. */
export function defaultBudgetPath(projectRoot: string, stateDir: string): string {
  return join(projectRoot, stateDir, 'budget.json');
}

/** Build the canonical lock dir under the project root (Fix H). Mirrors
 *  `defaultBudgetPath`'s `projectRoot`-relative convention rather than
 *  `resolveLockDir(config)`'s reliance on `config.projectRoot`, since callers
 *  of `createBudgetTrackerFromConfig` pass `projectRoot` explicitly and it
 *  may differ from (or be unset on) `config.projectRoot`. */
export function defaultBudgetLockDir(projectRoot: string, lockDir: string): string {
  return join(projectRoot, lockDir);
}

/**
 * Convenience constructor that derives all options from a `KarpathyConfig`.
 * Handlers can call this without knowing about state-dir conventions.
 */
export function createBudgetTrackerFromConfig(
  config: import('../config/schema.js').KarpathyConfig,
  projectRoot: string,
): BudgetTracker {
  const budget = config.intelligence.budget;
  return createBudgetTracker({
    statePath: defaultBudgetPath(projectRoot, config.stateDir),
    enabled: budget.enabled,
    limits: {
      fast: budget.llmCallsPerDay.fast,
      medium: budget.llmCallsPerDay.medium,
      heavy: budget.llmCallsPerDay.heavy,
    },
    lockDir: defaultBudgetLockDir(projectRoot, config.lockDir),
  });
}
