import type { HybridSearchResult } from '../../src/search/hybrid-store.js';
import type { RunHit } from './types.js';

export function toRunHits(result: HybridSearchResult, topK: number): RunHit[] {
  return result.hits.slice(0, topK).map((h, i) => ({
    path: h.docId,
    rank: i,
    final: h.scores.final,
    excerpt: h.excerpt,
    semanticSim: h.scores.semanticSim,
    keywordRank: h.scores.keywordRank,
  }));
}
