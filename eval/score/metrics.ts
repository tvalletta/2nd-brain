import type { RunHit } from '../run/types.js';

/** recall@k = |E ∩ R_k| / |E| (spec §7.1). `returned` is trusted to already
 * be rank-ordered (the harness's stable sort, spec §12/§15) — this function
 * slices, it does not re-sort. Returns null when |E| = 0: recall is
 * undefined against an empty relevant set, not a silent 0 (spec §7.1, §15). */
export function recallAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  if (relevantDocIds.size === 0) return null;
  const topK = returned.slice(0, k);
  const hits = topK.filter((h) => relevantDocIds.has(h.path)).length;
  return hits / relevantDocIds.size;
}

/** precision@k = |E ∩ R_k| / |R_k| (spec §7.2). Returns null when nothing
 * was returned — there is nothing to score precision against. */
export function precisionAtK(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  const topK = returned.slice(0, k);
  if (topK.length === 0) return null;
  const hits = topK.filter((h) => relevantDocIds.has(h.path)).length;
  return hits / topK.length;
}

/** RR = 1 / rank_of_first_relevant, 0 if none in top-k (spec §7.3). `rank`
 * on RunHit is 0-indexed; RR uses the 1-indexed position. */
export function reciprocalRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number {
  const topK = returned.slice(0, k);
  const firstHit = topK.find((h) => relevantDocIds.has(h.path));
  if (!firstHit) return 0;
  return 1 / (firstHit.rank + 1);
}

/** The 1-indexed rank of the first relevant hit in the top-k, or null if
 * none found. Used to compute the aggregate's median_first_rank (spec §7.3
 * reports median rank alongside mean RR). */
export function firstRelevantRank(returned: RunHit[], relevantDocIds: Set<string>, k: number): number | null {
  const topK = returned.slice(0, k);
  const firstHit = topK.find((h) => relevantDocIds.has(h.path));
  return firstHit ? firstHit.rank + 1 : null;
}
