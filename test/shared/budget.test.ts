import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createBudgetTracker, defaultBudgetPath } from '../../src/shared/budget.js';

describe('budget tracker', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-budget-'));
    statePath = defaultBudgetPath(dir, '.karpathy/state');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reserves up to the per-tier limit, then refuses', async () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 2, medium: 1, heavy: 0 },
    });
    expect(await t.tryReserve('fast')).toBe(true);
    expect(await t.tryReserve('fast')).toBe(true);
    expect(await t.tryReserve('fast')).toBe(false);

    expect(await t.tryReserve('medium')).toBe(true);
    expect(await t.tryReserve('medium')).toBe(false);

    expect(await t.tryReserve('heavy')).toBe(false);
  });

  it('reports remaining accurately', async () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 5, medium: 2, heavy: 1 },
    });
    await t.tryReserve('fast');
    await t.tryReserve('fast');
    expect(t.remaining('fast')).toBe(3);
    expect(t.remaining('medium')).toBe(2);
  });

  it('persists usage across instances', async () => {
    const limits = { fast: 10, medium: 1, heavy: 1 };
    const a = createBudgetTracker({ statePath, enabled: true, limits });
    await a.tryReserve('fast');
    await a.tryReserve('fast');

    const b = createBudgetTracker({ statePath, enabled: true, limits });
    expect(b.remaining('fast')).toBe(8);
    expect(await b.tryReserve('fast')).toBe(true);
    expect(b.snapshot().used.fast).toBe(3);
  });

  it('rolls over when the persisted day is stale', async () => {
    // Pre-seed budget.json with yesterday's date and a maxed-out fast counter.
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ date: '1999-01-01', used: { fast: 999, medium: 999, heavy: 999 } }),
    );
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 1, medium: 1, heavy: 1 },
    });
    expect(t.snapshot().used).toEqual({ fast: 0, medium: 0, heavy: 0 });
    expect(await t.tryReserve('fast')).toBe(true);
  });

  it('returns Infinity remaining and always reserves when disabled', async () => {
    const t = createBudgetTracker({
      statePath,
      enabled: false,
      limits: { fast: 0, medium: 0, heavy: 0 },
    });
    expect(await t.tryReserve('fast')).toBe(true);
    expect(await t.tryReserve('heavy')).toBe(true);
    expect(t.remaining('medium')).toBe(Number.POSITIVE_INFINITY);
  });

  it('reset() wipes today usage', async () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 5, medium: 5, heavy: 5 },
    });
    await t.tryReserve('fast');
    await t.tryReserve('medium');
    await t.reset();
    expect(t.snapshot().used).toEqual({ fast: 0, medium: 0, heavy: 0 });
  });

  it('falls back to a fresh state when the on-disk file is corrupt', async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{ this is not json', 'utf-8');
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 1, medium: 1, heavy: 1 },
    });
    expect(await t.tryReserve('fast')).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.used.fast).toBe(1);
  });
});

describe('budget tracker — file locking (Fix H)', () => {
  let dir: string;
  let statePath: string;
  let lockDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-budget-lock-'));
    statePath = defaultBudgetPath(dir, '.karpathy/state');
    lockDir = join(dir, '.karpathy', 'locks');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reserves and denies correctly with a lockDir configured (no contention)', async () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 1, medium: 0, heavy: 0 },
      lockDir,
    });
    expect(await t.tryReserve('fast')).toBe(true);
    expect(await t.tryReserve('fast')).toBe(false);
    expect(await t.tryReserve('medium')).toBe(false);
  });

  it('re-reads committed state from disk under the lock, so two tracker instances sharing a lockDir do not lose updates', async () => {
    const limits = { fast: 10, medium: 10, heavy: 10 };
    const a = createBudgetTracker({ statePath, enabled: true, limits, lockDir });
    const b = createBudgetTracker({ statePath, enabled: true, limits, lockDir });

    // Both constructed before either reserves — each starts from the same
    // stale in-memory snapshot (used.fast = 0). Without the lock's re-read,
    // b's later persist would clobber a's.
    await a.tryReserve('fast');
    await a.tryReserve('fast');
    await b.tryReserve('fast');

    const check = createBudgetTracker({ statePath, enabled: true, limits, lockDir });
    expect(check.snapshot().used.fast).toBe(3);
  });

  it('retries acquiring the budget lock when another process holds it, succeeding once it is released', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'budget.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, path: 'budget', acquiredAt: new Date().toISOString() }),
      'utf-8',
    );

    // Simulate the "other holder" releasing shortly after — well within the
    // tracker's bounded retry budget.
    setTimeout(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — fine
      }
    }, 100);

    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 5, medium: 5, heavy: 5 },
      lockDir,
    });
    const reserved = await t.tryReserve('fast');
    expect(reserved).toBe(true);
    expect(t.snapshot().used.fast).toBe(1);
  });
});
