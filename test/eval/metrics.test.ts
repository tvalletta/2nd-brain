import { describe, it, expect } from 'vitest';
import { recallAtK, precisionAtK, reciprocalRank, firstRelevantRank } from '../../eval/score/metrics.js';
import type { RunHit } from '../../eval/run/types.js';

function hit(path: string, rank: number): RunHit {
  return { path, rank, final: 1 - rank * 0.1, excerpt: '' };
}

describe('recallAtK', () => {
  it('computes |E ∩ R_k| / |E|', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['a.md', 'c.md', 'd.md']);
    expect(recallAtK(returned, relevant, 10)).toBeCloseTo(2 / 3);
  });

  it('returns null when E is empty (undefined per spec §7.1, not a silent 0)', () => {
    expect(recallAtK([hit('a.md', 0)], new Set(), 10)).toBeNull();
  });

  it('respects the k cutoff', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1)];
    const relevant = new Set(['b.md']);
    expect(recallAtK(returned, relevant, 1)).toBe(0);
    expect(recallAtK(returned, relevant, 2)).toBe(1);
  });
});

describe('precisionAtK', () => {
  it('computes |E ∩ R_k| / |R_k|', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['a.md']);
    expect(precisionAtK(returned, relevant, 3)).toBeCloseTo(1 / 3);
  });

  it('returns null when nothing was returned (nothing to score)', () => {
    expect(precisionAtK([], new Set(['a.md']), 10)).toBeNull();
  });
});

describe('reciprocalRank', () => {
  it('is 1/(rank+1) for the first relevant hit (rank is 0-indexed)', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    const relevant = new Set(['c.md']);
    expect(reciprocalRank(returned, relevant, 10)).toBeCloseTo(1 / 3);
  });

  it('is 0 when nothing relevant is in the top-k (per spec §7.3)', () => {
    const returned = [hit('a.md', 0)];
    expect(reciprocalRank(returned, new Set(['zzz.md']), 10)).toBe(0);
  });
});

describe('firstRelevantRank', () => {
  it('returns the 1-indexed rank of the first relevant hit', () => {
    const returned = [hit('a.md', 0), hit('b.md', 1), hit('c.md', 2)];
    expect(firstRelevantRank(returned, new Set(['c.md']), 10)).toBe(3);
  });

  it('returns null when none found', () => {
    expect(firstRelevantRank([hit('a.md', 0)], new Set(['zzz.md']), 10)).toBeNull();
  });
});
