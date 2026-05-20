import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('reserves up to the per-tier limit, then refuses', () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 2, medium: 1, heavy: 0 },
    });
    expect(t.tryReserve('fast')).toBe(true);
    expect(t.tryReserve('fast')).toBe(true);
    expect(t.tryReserve('fast')).toBe(false);

    expect(t.tryReserve('medium')).toBe(true);
    expect(t.tryReserve('medium')).toBe(false);

    expect(t.tryReserve('heavy')).toBe(false);
  });

  it('reports remaining accurately', () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 5, medium: 2, heavy: 1 },
    });
    t.tryReserve('fast');
    t.tryReserve('fast');
    expect(t.remaining('fast')).toBe(3);
    expect(t.remaining('medium')).toBe(2);
  });

  it('persists usage across instances', () => {
    const limits = { fast: 10, medium: 1, heavy: 1 };
    const a = createBudgetTracker({ statePath, enabled: true, limits });
    a.tryReserve('fast');
    a.tryReserve('fast');

    const b = createBudgetTracker({ statePath, enabled: true, limits });
    expect(b.remaining('fast')).toBe(8);
    expect(b.tryReserve('fast')).toBe(true);
    expect(b.snapshot().used.fast).toBe(3);
  });

  it('rolls over when the persisted day is stale', () => {
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
    expect(t.tryReserve('fast')).toBe(true);
  });

  it('returns Infinity remaining and always reserves when disabled', () => {
    const t = createBudgetTracker({
      statePath,
      enabled: false,
      limits: { fast: 0, medium: 0, heavy: 0 },
    });
    expect(t.tryReserve('fast')).toBe(true);
    expect(t.tryReserve('heavy')).toBe(true);
    expect(t.remaining('medium')).toBe(Number.POSITIVE_INFINITY);
  });

  it('reset() wipes today usage', () => {
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 5, medium: 5, heavy: 5 },
    });
    t.tryReserve('fast');
    t.tryReserve('medium');
    t.reset();
    expect(t.snapshot().used).toEqual({ fast: 0, medium: 0, heavy: 0 });
  });

  it('falls back to a fresh state when the on-disk file is corrupt', () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{ this is not json', 'utf-8');
    const t = createBudgetTracker({
      statePath,
      enabled: true,
      limits: { fast: 1, medium: 1, heavy: 1 },
    });
    expect(t.tryReserve('fast')).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.used.fast).toBe(1);
  });
});
