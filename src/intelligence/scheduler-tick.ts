// Reusable scheduler-tick body, shared by the CLI (`karpathy intel tick`,
// src/bin/intel-command.ts) and the shared MCP daemon's interval timer
// (Task 7). Extracted from the old inline `tick` case so both callers get
// identical behavior: first-run backfill, Cursor session import, firing
// whatever scheduled jobs are due, and draining the queue.
//
// Adds power-gating on top of the original behavior: heavy scheduled jobs
// (LLM-calling or whole-vault-scanning) are deferred while the machine is
// on battery or thermally constrained, so a background daemon polling this
// on an interval never keeps a laptop warm/draining battery for
// non-urgent maintenance work.

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFsAdapter } from '../vault/fs-adapter.js';
import { createJobQueue } from '../jobs/queue.js';
import { createFileLock } from '../jobs/lock.js';
import { createJobRunner } from '../jobs/runner.js';
import { createHandlerRegistry } from '../jobs/handlers/index.js';
import { resolveLockDir } from '../config/defaults.js';
import { createLLMFromConfig } from '../enrichment/llm-factory.js';
import { tickScheduler, defaultSchedule, type ScheduledJob } from './scheduler.js';
import { maybeRunAutoBackfill } from './auto-backfill.js';
import { importNewCursorSessions } from '../session/import-cursor-sessions.js';
import { createLogger } from '../shared/logger.js';
import type { KarpathyConfig } from '../config/schema.js';

const log = createLogger('scheduler-tick');
const execFileAsync = promisify(execFile);

/**
 * Bounds each `pmset` probe call in `powerState()`. `execFile`'s `timeout`
 * option sends `killSignal` and rejects the promise once exceeded -- caught
 * by the existing try/catch below, which already treats any probe failure
 * as "assume unconstrained." Without this, a hung `pmset` would await
 * forever, blocking `runSchedulerTick` (and, via Task 7, the daemon's
 * scheduler interval) indefinitely.
 */
const PMSET_TIMEOUT_MS = 2000;

/**
 * Scheduled job types expensive enough (LLM calls and/or whole-vault scans)
 * that they should be deferred while the machine is on battery or
 * thermally constrained. Everything else in `defaultSchedule()` (e.g.
 * `sync-fts-index`, `rebuild-vault-artifacts`, `archive-stale-drafts`, the
 * `maintenance.reviewEnabled`-gated detect-* jobs) is cheap/deterministic
 * and still fires+drains regardless of power state.
 */
export const HEAVY_SCHEDULED_JOBS: readonly string[] = [
  'decay-scan',
  'digest-weekly',
  'research-propose',
  'rot-scan',
];

export interface PowerState {
  onBattery: boolean;
  thermallyConstrained: boolean;
}

export interface SchedulerTickResult {
  fired: { type: string; reason: string }[];
  skipped: string[];
  processed: number;
  heavyDeferred: boolean;
}

export interface RunSchedulerTickDeps {
  config: KarpathyConfig;
  stateDir: string;
  /** Test seam. Production callers rely on the default `powerState()` below. */
  powerState?: () => Promise<PowerState>;
}

/**
 * `pmset -g batt` prints a first line of either
 * `Now drawing from 'AC Power'` or `Now drawing from 'Battery Power'`.
 */
function parseBatteryOutput(stdout: string): boolean {
  return /Now drawing from\s+'Battery Power'/i.test(stdout);
}

/**
 * `pmset -g therm` prints `CPU_Speed_Limit = <0-100>` (and/or
 * `CPU_Scheduler_Limit`) once the system throttles under thermal pressure;
 * both read 100 when unconstrained, and the keys are absent entirely when
 * the system has never recorded a thermal event (`"No thermal warning
 * level has been recorded"`), which should also read as unconstrained.
 */
function parseThermalOutput(stdout: string): boolean {
  const speedLimit = stdout.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  if (speedLimit) return Number(speedLimit[1]) < 100;
  const schedulerLimit = stdout.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/);
  if (schedulerLimit) return Number(schedulerLimit[1]) < 100;
  return false;
}

/**
 * Best-effort macOS power/thermal probe via `pmset`. Defaults to fully
 * unconstrained (`{onBattery:false,thermallyConstrained:false}`) on any
 * error, timeout, or non-macOS platform -- this must never block or throw
 * on a caller. Injectable via `RunSchedulerTickDeps.powerState` so tests
 * never shell out to a real probe unless they choose to.
 */
export async function powerState(): Promise<PowerState> {
  if (process.platform !== 'darwin') {
    return { onBattery: false, thermallyConstrained: false };
  }

  let onBattery = false;
  let thermallyConstrained = false;
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], {
      timeout: PMSET_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    onBattery = parseBatteryOutput(stdout);
  } catch (err) {
    log.debug('pmset -g batt probe failed; assuming AC power', { error: (err as Error).message });
  }
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'therm'], {
      timeout: PMSET_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    thermallyConstrained = parseThermalOutput(stdout);
  } catch (err) {
    log.debug('pmset -g therm probe failed; assuming unconstrained', { error: (err as Error).message });
  }
  return { onBattery, thermallyConstrained };
}

/**
 * Runs one scheduler tick: first-run backfill, Cursor session import,
 * firing whatever scheduled jobs are due, and draining the queue.
 * Identical to the CLI's former inline `tick` case except (a) it never
 * calls `process.exit`, and (b) it filters `HEAVY_SCHEDULED_JOBS` out of
 * the schedule (and reports `heavyDeferred: true`) when the machine is on
 * battery or thermally constrained.
 */
export async function runSchedulerTick(deps: RunSchedulerTickDeps): Promise<SchedulerTickResult> {
  const { config, stateDir } = deps;
  const getPowerState = deps.powerState ?? powerState;

  // First-run backfill: idempotent, only runs once per state dir.
  const vaultForBackfill = createFsAdapter(config.vaultPath);
  const backfill = await maybeRunAutoBackfill(vaultForBackfill, stateDir);
  if (backfill.ran) {
    log.info('Auto-backfill (first run) completed', {
      filesUpdated: backfill.filesUpdated,
      fieldsAdded: backfill.fieldsAdded,
    });
  }

  // Import any new Cursor sessions before the scheduler fires. Newly
  // exported staging files get picked up by the file watcher / file-mtime
  // ingest path. Best-effort -- a failure here must never block the tick.
  try {
    const cursor = await importNewCursorSessions(config, stateDir);
    if (cursor.exported > 0) {
      log.info('Cursor sessions imported', {
        exported: cursor.exported,
        skipped: cursor.skipped,
        total: cursor.total,
      });
    }
  } catch (err) {
    log.warn('Cursor import failed (non-fatal)', { error: (err as Error).message });
  }

  const ps = await getPowerState();
  const heavyDeferred = ps.onBattery || ps.thermallyConstrained;
  const schedule: ScheduledJob[] = defaultSchedule({
    reviewEnabled: config.maintenance.reviewEnabled,
  }).filter((s) => !heavyDeferred || !HEAVY_SCHEDULED_JOBS.includes(s.type));

  const queue = createJobQueue(join(stateDir, 'job-queue.json'), {
    maxActiveJobs: config.jobs.maxActiveJobs,
  });
  await queue.load();
  const tickResult = await tickScheduler({
    stateDir,
    enqueue: async (i) => queue.enqueue(i),
    schedule,
  });

  // Drain whatever was just enqueued.
  const vault = createFsAdapter(config.vaultPath);
  const runner = createJobRunner({
    queue,
    lock: createFileLock(resolveLockDir(config)),
    handlers: createHandlerRegistry(),
    vaultPath: config.vaultPath,
    projectRoot: config.projectRoot!,
    llm: createLLMFromConfig(config, stateDir),
    vault,
    config,
  });
  const processed = await runner.runAll();

  return {
    fired: tickResult.fired,
    skipped: tickResult.skipped.map((s) => s.type),
    processed,
    heavyDeferred,
  };
}
