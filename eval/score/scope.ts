import type { RunHit } from '../run/types.js';

/** The 4 folders `search_vault`'s default scan covers — resolved concretely
 * from `src/mcp/tools/search-vault.ts`'s `folders = [layout.wiki,
 * layout.aiSummaries, layout.sources, layout.review]` against the live
 * global config (spec §7.6, addendum §19). Used to compute the
 * scope-matched metric variant, isolating "hybrid wins by indexing more"
 * from "hybrid ranks better" (spec §7.6). */
export const SCOPE_MATCHED_PREFIXES = [
  'Curated/wiki',
  'AI Conversations/_summaries',
  'Curated/sources',
  'Curated/review',
] as const;

function inScope(path: string): boolean {
  return SCOPE_MATCHED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Restrict both the returned hit list and the relevant-doc-id set to paths
 * under the 4 scope-matched prefixes (spec §7.6). Both sides are filtered
 * together so recall/precision/MRR computed on the result are a fair
 * apples-to-apples comparison scoped to what search_vault can see at all. */
export function restrictToScope(
  returned: RunHit[],
  relevantDocIds: Set<string>,
): { returned: RunHit[]; relevantDocIds: Set<string> } {
  return {
    returned: returned.filter((h) => inScope(h.path)),
    relevantDocIds: new Set([...relevantDocIds].filter((id) => inScope(id))),
  };
}
