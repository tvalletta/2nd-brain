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
// Concurrency: a single Karpathy project runs one queue at a time
// (`FileLock` ensures it), so a JSON-on-disk counter is sufficient. Across
// projects the counters are independent — that's intentional, the budget is
// per-project.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('budget');

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
  /** Reserve one call for `tier`; returns false if the day's budget is exhausted. */
  tryReserve(tier: BudgetTier): boolean;
  /** Read the remaining budget for a tier without reserving. */
  remaining(tier: BudgetTier): number;
  /** Snapshot of today's usage. */
  snapshot(): BudgetState;
  /** Wipe today's counters (used by tests / manual reset). */
  reset(): void;
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
}

export function createBudgetTracker(opts: CreateBudgetTrackerOptions): BudgetTracker {
  let state = loadState(opts.statePath);

  function refreshIfRolledOver() {
    if (state.date !== todayKey()) state = emptyState();
  }

  return {
    tryReserve(tier) {
      if (!opts.enabled) return true;
      refreshIfRolledOver();
      const limit = opts.limits[tier];
      if (state.used[tier] >= limit) {
        log.info('budget exhausted', { tier, limit, used: state.used[tier] });
        return false;
      }
      state.used[tier] += 1;
      persistState(opts.statePath, state);
      return true;
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
    reset() {
      state = emptyState();
      persistState(opts.statePath, state);
    },
  };
}

/** Build the canonical budget state path under the project's state dir. */
export function defaultBudgetPath(projectRoot: string, stateDir: string): string {
  return join(projectRoot, stateDir, 'budget.json');
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
  });
}
