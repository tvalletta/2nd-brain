import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tickScheduler,
  readSchedulerState,
  defaultSchedule,
} from '../../src/intelligence/scheduler.js';
import type { JobCreateInput } from '../../src/jobs/types.js';

describe('intelligence scheduler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-sched-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fires every job on first run', async () => {
    const enq: JobCreateInput[] = [];
    const result = await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    const expected = defaultSchedule().length;
    expect(result.fired).toHaveLength(expected);
    expect(result.skipped).toHaveLength(0);
    expect(enq).toHaveLength(expected);
    expect(enq.every((j) => j.trigger === 'timer')).toBe(true);
  });

  it('persists last-fire timestamps across runs', async () => {
    const enq: JobCreateInput[] = [];
    await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    const state = readSchedulerState(dir);
    expect(state.lastFire['decay-scan']).toBe('2026-05-07T00:00:00.000Z');
    expect(state.lastFire['digest-weekly']).toBeDefined();
  });

  it('skips daily jobs when already fired today, fires weekly jobs daily after week', async () => {
    const enq1: JobCreateInput[] = [];
    await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq1.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-07T00:00:00Z'),
    });

    // 12 hours later — only the 5-min sync-fts-index job is due; everything
    // else (daily/weekly) stays skipped.
    const enq2: JobCreateInput[] = [];
    const r2 = await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq2.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-07T12:00:00Z'),
    });
    expect(r2.fired.map((f) => f.type)).toEqual(['sync-fts-index']);
    expect(r2.skipped.length).toBeGreaterThan(0);

    // 2 days later — daily jobs should fire, weeklies still skip.
    const enq3: JobCreateInput[] = [];
    const r3 = await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq3.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-09T00:00:00Z'),
    });
    const firedTypes = r3.fired.map((f) => f.type);
    expect(firedTypes).toContain('sync-fts-index');
    expect(firedTypes).toContain('decay-scan');
    expect(firedTypes).toContain('research-propose');
    expect(firedTypes).not.toContain('digest-weekly');
    expect(firedTypes).not.toContain('rot-scan');

    // 8 days after first run — weeklies fire too.
    const enq4: JobCreateInput[] = [];
    const r4 = await tickScheduler({
      stateDir: dir,
      enqueue: async (i) => {
        enq4.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-15T00:00:00Z'),
    });
    const firedTypes4 = r4.fired.map((f) => f.type);
    expect(firedTypes4).toContain('digest-weekly');
    expect(firedTypes4).toContain('rot-scan');
  });

  it('respects custom schedule', async () => {
    const enq: JobCreateInput[] = [];
    const result = await tickScheduler({
      stateDir: dir,
      schedule: [
        { type: 'decay-scan', cadence: 'custom', intervalSec: 60, priority: 99, dedupeKey: 'd' },
      ],
      enqueue: async (i) => {
        enq.push(i);
        return null;
      },
      nowMs: Date.parse('2026-05-07T00:00:00Z'),
    });
    expect(result.fired).toHaveLength(1);
    expect(enq[0].priority).toBe(99);
    expect(enq[0].dedupeKey).toBe('d');
  });
});
