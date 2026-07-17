import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';

export interface DisagreementItem {
  itemId: string;
  query: string;
  variantHits: Record<string, { docIds: string[] }>;
}

/** Finds items where at least two contenders disagree on their top-3
 * retrieved doc set in a way that matters: some relevant document (label
 * >= 1) was retrieved by at least one contender's top-3 but not by
 * another's. Items where every contender's top-3 sets are identical are
 * excluded — there's no retrieval difference for a downstream answer to
 * possibly reflect (spec: downstream-answer-quality-check-design.md §3). */
export function computeDisagreementSample(
  runsResults: RunResult[],
  judgments: Judgment[],
  contenders: string[],
): DisagreementItem[] {
  const relevantByItem = new Map<string, Set<string>>();
  for (const j of judgments) {
    if (j.label < 1) continue;
    if (!relevantByItem.has(j.item_id)) relevantByItem.set(j.item_id, new Set());
    relevantByItem.get(j.item_id)!.add(j.doc_id);
  }

  const itemIds = new Set(runsResults.map((r) => r.itemId));
  const sample: DisagreementItem[] = [];

  for (const itemId of itemIds) {
    const variantHits: Record<string, { docIds: string[] }> = {};
    let query = '';
    for (const contender of contenders) {
      const result = runsResults.find((r) => r.itemId === itemId && r.variant === contender);
      if (!result) continue;
      query = result.query;
      const top3 = [...result.returned].sort((a, b) => a.rank - b.rank).slice(0, 3);
      variantHits[contender] = { docIds: top3.map((h) => h.path) };
    }

    const presentContenders = Object.keys(variantHits);
    if (presentContenders.length < 2) continue;

    const allSetsIdentical = presentContenders.every((c) => {
      const a = new Set(variantHits[c].docIds);
      const b = new Set(variantHits[presentContenders[0]].docIds);
      return a.size === b.size && [...a].every((x) => b.has(x));
    });
    if (allSetsIdentical) continue;

    const relevant = relevantByItem.get(itemId) ?? new Set();
    const someRelevantOnlyInSomeVariants = [...relevant].some((docId) => {
      const foundBy = presentContenders.filter((c) => variantHits[c].docIds.includes(docId));
      return foundBy.length > 0 && foundBy.length < presentContenders.length;
    });
    if (!someRelevantOnlyInSomeVariants) continue;

    sample.push({ itemId, query, variantHits });
  }

  return sample;
}
