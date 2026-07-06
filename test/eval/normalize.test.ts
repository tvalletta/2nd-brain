import { describe, it, expect } from 'vitest';
import { toRunHits } from '../../eval/run/normalize.js';
import type { HybridSearchResult } from '../../src/search/hybrid-store.js';

describe('toRunHits', () => {
  it('maps docId->path, assigns 0-indexed rank, carries scores, truncates to topK', () => {
    const result: HybridSearchResult = {
      searchMode: 'hybrid',
      hits: [
        { docId: 'a.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'A',
          scores: { rrf: 0.1, recency: 0.5, final: 0.42, semanticSim: 0.7, keywordRank: 2 } },
        { docId: 'b.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'B',
          scores: { rrf: 0.05, recency: 0.1, final: 0.2 } },
        { docId: 'c.md', chunkIndex: 0, text: '', metadata: {}, updated_at: '', excerpt: 'C',
          scores: { rrf: 0.01, recency: 0, final: 0.05 } },
      ],
    };
    const hits = toRunHits(result, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ path: 'a.md', rank: 0, final: 0.42, excerpt: 'A', semanticSim: 0.7, keywordRank: 2 });
    expect(hits[1]).toMatchObject({ path: 'b.md', rank: 1, final: 0.2 });
    expect(hits[1].semanticSim).toBeUndefined();
  });
});
