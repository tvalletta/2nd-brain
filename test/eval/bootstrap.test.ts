import { describe, it, expect } from 'vitest';
import { bootstrapCI } from '../../eval/score/bootstrap.js';

describe('bootstrapCI', () => {
  it('returns [0, 0] for no data', () => {
    expect(bootstrapCI([])).toEqual([0, 0]);
  });

  it('returns [value, value] for a single data point (nothing to resample)', () => {
    expect(bootstrapCI([0.7])).toEqual([0.7, 0.7]);
  });

  it('is deterministic for the same seed', () => {
    const values = [0.2, 0.4, 0.6, 0.8, 1.0];
    const a = bootstrapCI(values, 1000, 42);
    const b = bootstrapCI(values, 1000, 42);
    expect(a).toEqual(b);
  });

  it('produces a different CI for a different seed (confirms the seed is actually used)', () => {
    const values = [0.1, 0.3, 0.9, 0.2, 0.7, 0.4];
    const a = bootstrapCI(values, 1000, 1);
    const b = bootstrapCI(values, 1000, 2);
    expect(a).not.toEqual(b);
  });

  it('collapses to a tight range around the constant when all values are equal', () => {
    const [lo, hi] = bootstrapCI([0.5, 0.5, 0.5, 0.5], 1000, 1);
    expect(lo).toBeCloseTo(0.5);
    expect(hi).toBeCloseTo(0.5);
  });

  it('bounds the CI within the observed data range (resampling with replacement never invents values outside it)', () => {
    const values = [0.1, 0.5, 0.9];
    const [lo, hi] = bootstrapCI(values, 1000, 7);
    expect(lo).toBeGreaterThanOrEqual(0.1);
    expect(hi).toBeLessThanOrEqual(0.9);
  });
});
