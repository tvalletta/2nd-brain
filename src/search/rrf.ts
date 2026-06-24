// Reciprocal Rank Fusion — combines multiple ranked lists into a single
// relevance-ordered list without needing comparable scores.
//
// Each ranked list contributes `1 / (k + rank)` per docId, where `rank` is
// 0-indexed (best = 0). With the canonical `k=60`, a doc that appears at rank 0
// in two lists outscores a doc that appears at rank 0 in just one. Documents
// duplicated within a single list are de-duplicated by docId, keeping the
// best (lowest) rank.

const DEFAULT_K = 60;

export interface RRFInput {
  docId: string;
  rank: number;
}

export interface RRFResult {
  docId: string;
  score: number;
}

export function rrf(lists: RRFInput[][], k: number = DEFAULT_K): RRFResult[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    const seen = new Map<string, number>();
    for (const { docId, rank } of list) {
      const prior = seen.get(docId);
      if (prior === undefined || rank < prior) seen.set(docId, rank);
    }
    for (const [docId, rank] of seen) {
      scores.set(docId, (scores.get(docId) ?? 0) + 1 / (k + rank));
    }
  }

  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score);
}
