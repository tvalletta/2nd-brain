// Self-pacing scheduler for the intelligence pipeline.
//
// Persists last-fire timestamps in `.karpathy/state/intel-scheduler.json` and
// exposes a single "tick" entrypoint that fires whatever is due.
// The user wires `karpathy intel tick` to any external cron (system cron,
// launchd, a Claude Code hook) at any frequency — typically every 15-60 min.
// The scheduler itself decides what's actually due, so cron resolution doesn't
// matter as long as it's at least as fine-grained as the smallest interval.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JobCreateInput, JobType } from '../jobs/types.js';
import { atomicWrite } from '../shared/fs-utils.js';

export interface ScheduledJob {
  /** Job type to fire. */
  type: JobType;
  /** Human-readable cadence label (only used for logs / diagnostics). */
  cadence: string;
  /** Minimum seconds between fires. Set to e.g. 86400 for daily, 604800 for weekly. */
  intervalSec: number;
  /** Job priority. */
  priority?: number;
  /** Dedupe key to avoid stacking pending jobs. */
  dedupeKey?: string;
  /** Optional payload. */
  payload?: Record<string, unknown>;
}

export interface SchedulerState {
  lastFire: Record<string, string>; // ISO timestamps keyed by job type
  [k: string]: unknown; // preserve extra keys (e.g. autoBackfillCompletedAt) through read/write cycles
}

export interface TickResult {
  fired: { type: string; reason: string }[];
  skipped: { type: string; reason: string }[];
}

const STATE_FILENAME = 'intel-scheduler.json';

export function defaultSchedule(): ScheduledJob[] {
  return [
    {
      // Hybrid-search FTS5 keyword index sync. Cheap (~56ms stat walk for 22k
      // files + ~8ms per changed file), so it runs on a 5-minute cadence —
      // matches OneDrive/VoiceInk/Plaud arrival latency. Requires the intel
      // tick cron to fire at least every 5 minutes.
      type: 'sync-fts-index',
      cadence: 'every-5-min',
      intervalSec: 300,
      priority: 100,
      dedupeKey: 'sync-fts-index',
    },
    {
      type: 'decay-scan',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 95,
      dedupeKey: 'decay-scan',
    },
    {
      type: 'research-propose',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 90,
      dedupeKey: 'research-propose',
    },
    {
      type: 'rot-scan',
      cadence: 'weekly',
      intervalSec: 7 * 86_400,
      priority: 95,
      dedupeKey: 'rot-scan',
    },
    {
      type: 'digest-weekly',
      cadence: 'weekly',
      intervalSec: 7 * 86_400,
      priority: 90,
      dedupeKey: 'digest-weekly',
    },
    {
      type: 'rebuild-vault-artifacts',
      cadence: 'daily',
      intervalSec: 86_400,
      priority: 92,
      dedupeKey: 'rebuild-vault-artifacts',
    },
  ];
}

export function readSchedulerState(stateDir: string): SchedulerState {
  const path = join(stateDir, STATE_FILENAME);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Spread the full file so extra keys (e.g. autoBackfillCompletedAt written
    // by maybeRunAutoBackfill) survive the tickScheduler read/write cycle.
    return { ...parsed, lastFire: (parsed['lastFire'] as Record<string, string>) ?? {} };
  } catch {
    return { lastFire: {} };
  }
}

export async function writeSchedulerState(stateDir: string, state: SchedulerState): Promise<void> {
  const path = join(stateDir, STATE_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(state, null, 2));
}

export interface TickDeps {
  stateDir: string;
  schedule?: ScheduledJob[];
  enqueue: (input: JobCreateInput) => Promise<unknown>;
  /** Override `now`; used by tests. */
  nowMs?: number;
}

export async function tickScheduler(deps: TickDeps): Promise<TickResult> {
  const schedule = deps.schedule ?? defaultSchedule();
  const nowMs = deps.nowMs ?? Date.now();
  const state = readSchedulerState(deps.stateDir);
  const fired: TickResult['fired'] = [];
  const skipped: TickResult['skipped'] = [];

  for (const job of schedule) {
    const lastIso = state.lastFire[job.type];
    const lastMs = lastIso ? new Date(lastIso).getTime() : 0;
    const dueAtMs = lastMs + job.intervalSec * 1000;

    if (lastMs && nowMs < dueAtMs) {
      const minutesLeft = Math.ceil((dueAtMs - nowMs) / 60_000);
      skipped.push({ type: job.type, reason: `not due (${minutesLeft}m left)` });
      continue;
    }

    await deps.enqueue({
      type: job.type,
      payload: job.payload ?? {},
      priority: job.priority ?? 50,
      trigger: 'timer',
      dedupeKey: job.dedupeKey ?? job.type,
    });
    state.lastFire[job.type] = new Date(nowMs).toISOString();
    fired.push({ type: job.type, reason: lastIso ? `interval elapsed (${job.cadence})` : 'first run' });
  }

  await writeSchedulerState(deps.stateDir, state);
  return { fired, skipped };
}
