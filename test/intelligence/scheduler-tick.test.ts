import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import {
  runSchedulerTick,
  powerState,
  HEAVY_SCHEDULED_JOBS,
} from '../../src/intelligence/scheduler-tick.js';
import type { KarpathyConfig } from '../../src/config/schema.js';

function makeConfig(vaultDir: string, projectDir: string): KarpathyConfig {
  return KarpathyConfigSchema.parse({ vaultPath: vaultDir, projectRoot: projectDir });
}

describe('runSchedulerTick', () => {
  let vaultDir: string;
  let stateDir: string;
  let config: KarpathyConfig;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'karpathy-tick-vault-'));
    stateDir = await mkdtemp(join(tmpdir(), 'karpathy-tick-state-'));
    config = makeConfig(vaultDir, vaultDir);
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('defers heavy scheduled jobs when on battery', async () => {
    const res = await runSchedulerTick({
      config,
      stateDir,
      powerState: async () => ({ onBattery: true, thermallyConstrained: false }),
    });

    expect(res.heavyDeferred).toBe(true);
    expect(
      res.fired.map((f) => f.type).some((t) => HEAVY_SCHEDULED_JOBS.includes(t)),
    ).toBe(false);
    // Light jobs still fire on the first-ever tick.
    expect(res.fired.map((f) => f.type)).toContain('sync-fts-index');
  });

  it('defers heavy scheduled jobs when thermally constrained', async () => {
    const res = await runSchedulerTick({
      config,
      stateDir,
      powerState: async () => ({ onBattery: false, thermallyConstrained: true }),
    });

    expect(res.heavyDeferred).toBe(true);
    expect(
      res.fired.map((f) => f.type).some((t) => HEAVY_SCHEDULED_JOBS.includes(t)),
    ).toBe(false);
  });

  it('runs full schedule on AC power and returns processed count', async () => {
    const res = await runSchedulerTick({
      config,
      stateDir,
      powerState: async () => ({ onBattery: false, thermallyConstrained: false }),
    });

    expect(res.heavyDeferred).toBe(false);
    expect(typeof res.processed).toBe('number');
    // On a fresh state dir every scheduled job fires on the first tick,
    // including the heavy ones, since power is unconstrained.
    expect(res.fired.map((f) => f.type)).toContain('decay-scan');
  });

  it('defaults to the real powerState() probe when none is injected', async () => {
    // No `powerState` override -- exercises the real macOS `pmset` probe.
    // Asserts shape only; the actual battery/thermal state of the machine
    // running the test is not under test control.
    const res = await runSchedulerTick({ config, stateDir });
    expect(typeof res.heavyDeferred).toBe('boolean');
    expect(typeof res.processed).toBe('number');
  });
});

describe('powerState (real pmset probe)', () => {
  it('resolves to a well-shaped PowerState without throwing', async () => {
    const ps = await powerState();
    expect(typeof ps.onBattery).toBe('boolean');
    expect(typeof ps.thermallyConstrained).toBe('boolean');
  });

  it('does not hang when pmset itself hangs -- resolves to unconstrained within the timeout bound', async () => {
    // Shadow the real `pmset` with a fake binary that sleeps far past the
    // implementation's per-call timeout, by prepending a temp bin dir to
    // PATH. `powerState()` must bound each of its two sequential pmset
    // calls (batt, therm) individually rather than awaiting either one
    // forever -- this is the regression test for that timeout.
    const binDir = await mkdtemp(join(tmpdir(), 'karpathy-fake-pmset-'));
    const fakePmset = join(binDir, 'pmset');
    await writeFile(fakePmset, '#!/bin/sh\nsleep 10\n');
    await chmod(fakePmset, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    try {
      const start = Date.now();
      const ps = await powerState();
      const elapsed = Date.now() - start;

      // Two sequential 2s-bounded probes should resolve in a few seconds,
      // never anywhere near the fake pmset's 10s sleep.
      expect(elapsed).toBeLessThan(6000);
      expect(ps).toEqual({ onBattery: false, thermallyConstrained: false });
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  }, 10000);
});
