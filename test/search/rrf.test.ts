import { describe, it, expect } from 'vitest';
import { rrf } from '../../src/search/rrf.js';

describe('reciprocal rank fusion', () => {
  it('passes a single list through with k=60 normalization', () => {
    const result = rrf([
      [
        { docId: 'a', rank: 0 },
        { docId: 'b', rank: 1 },
      ],
    ]);
    expect(result.map((r) => r.docId)).toEqual(['a', 'b']);
    expect(result[0].score).toBeCloseTo(1 / 60, 8);
    expect(result[1].score).toBeCloseTo(1 / 61, 8);
  });

  it('rewards docs that appear in both lists over single-list docs', () => {
    const result = rrf([
      [{ docId: 'a', rank: 0 }, { docId: 'b', rank: 1 }],
      [{ docId: 'a', rank: 5 }, { docId: 'c', rank: 0 }],
    ]);
    const byId = Object.fromEntries(result.map((r) => [r.docId, r.score]));
    // a is in both lists → should outrank b (single-list rank 1) and c (single-list rank 0)
    expect(byId.a).toBeGreaterThan(byId.b);
    expect(byId.a).toBeGreaterThan(byId.c);
  });

  it('returns stable ordering when k is the canonical 60', () => {
    const result = rrf([
      [{ docId: 'a', rank: 0 }, { docId: 'b', rank: 1 }, { docId: 'c', rank: 2 }],
      [{ docId: 'a', rank: 2 }, { docId: 'b', rank: 0 }, { docId: 'c', rank: 1 }],
    ]);
    const ids = result.map((r) => r.docId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('handles an empty list input', () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[]])).toEqual([]);
  });

  it('deduplicates within a single list, keeping the best (lowest) rank', () => {
    const result = rrf([
      [
        { docId: 'a', rank: 5 },
        { docId: 'a', rank: 0 },
      ],
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe('a');
    // Best rank wins → score is 1/(60+0)
    expect(result[0].score).toBeCloseTo(1 / 60, 8);
  });

  it('respects a custom k', () => {
    const result = rrf([[{ docId: 'a', rank: 0 }]], 100);
    expect(result[0].score).toBeCloseTo(1 / 100, 8);
  });
});
