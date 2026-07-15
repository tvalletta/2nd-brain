import { describe, it, expect } from 'vitest';
import { mean, median, percentile } from '../../eval/score/stats.js';

describe('mean', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2);
  });

  it('returns 0 for an empty array', () => {
    expect(mean([])).toBe(0);
  });
});

describe('median', () => {
  it('returns the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('percentile', () => {
  it('returns the value at the given percentile', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.95)).toBe(10);
  });

  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});
