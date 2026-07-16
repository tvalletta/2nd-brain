import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import type { EvalItem } from './types.js';

/**
 * Score ceiling for an OR-fallback match's `final` score to still count as
 * "no meaningful match" (see isConfirmedAbsent for the full gating rule —
 * this threshold is now a secondary safety net, not the primary signal).
 *
 * Recalibration history (2026-07-16), after grep-recall-improvements' AND-
 * first/OR-fallback relaxation landed (commit 6c6e30a):
 *
 * A real run against the live vault showed ALL 10 original candidates
 * scoring 0.036-0.089 — well above the old 0.02 threshold (0/10 confirmed
 * absent). Investigation showed `final` alone can no longer discriminate
 * present from absent at all: `final = α·rrf + β·recency`, and once ANY
 * token overlaps (near-guaranteed for an English query against a large,
 * broad-coverage vault once OR-fallback is in play), the score is dominated
 * by the matched doc's recency (β·min(0.5, exp(-Δt/30)), up to 0.15 for
 * default-content-type docs) rather than the tiny top-rank RRF contribution
 * (≤ ~0.017 for a single-list keyword pool, k=60). Concretely: 5 known-
 * relevant "lookup" queries from queries.json scored 0.033-0.089 — the
 * *same* band as the "absent" candidates — and a further 30 deliberately
 * obscure candidates (beekeeping, axolotl husbandry, philately, etc.) also
 * landed in that band almost without exception. Only true zero-token-
 * overlap queries reliably score 0. Simply raising DEFAULT_SCORE_THRESHOLD
 * to clear this band (tried: 0.1 alone) breaks the "returns false when a
 * real match exists" test, because a genuine single-doc match hits the
 * exact same ~0.089 ceiling as a spurious one — proving no fixed score
 * threshold alone can separate the two. This is the same shape of problem
 * as I9 (a scoring-floor artifact defeating threshold-based confidence),
 * now reproducing for grep-first via the OR-fallback + recency-fusion
 * interaction rather than the embedding pool.
 *
 * Fix: gate primarily on `result.ftsMatchMode` (see isConfirmedAbsent) —
 * an 'and' match means every query token co-occurs in one document (real
 * evidence of relevance, regardless of score); an 'or' match means only the
 * recall-relaxation fallback found a partial/coincidental overlap, which is
 * consistent with genuine topical absence. The score threshold below is now
 * only a safety net for unusually high-scoring OR matches (e.g. a `session`
 * content-type doc, β=0.3, which could reach ~0.16) and is set comfortably
 * above the observed OR-mode ceiling (0.089) so it doesn't fire in practice
 * on this vault, while still guarding against that edge case.
 */
const DEFAULT_SCORE_THRESHOLD = 0.1;

/** The single source of truth for the absent/not-absent decision (see
 * isConfirmedAbsent's doc comment for the full rationale). Pure function over
 * already-computed search outcome values so it can be shared between
 * `isConfirmedAbsent` (which does its own `store.search()`) and `main()`
 * (which needs the raw `hitCount`/`matchMode`/`score` values anyway for its
 * console.log diagnostic line, and must not reimplement this predicate by
 * hand a second time — the two copies already drifted out of sync once
 * during this task's own development, score-only → matchMode-aware).
 *
 * Gating rule: zero hits is always absent. Otherwise, an 'and' match (every
 * query token co-occurs in one doc — real relevance evidence) is never
 * confirmed absent, regardless of its `final` score, since that score is
 * dominated by recency rather than relevance once any match exists. An 'or'
 * match (recall-relaxation fallback only found a partial, possibly-
 * coincidental overlap) is confirmed absent unless its score clears the
 * threshold — a safety net for the rare high-scoring OR match. */
function decideAbsent(
  hitCount: number,
  matchMode: 'and' | 'or' | undefined,
  score: number,
  scoreThreshold: number,
): boolean {
  if (hitCount === 0) return true;
  if (matchMode !== 'or') return false;
  return score < scoreThreshold;
}

/** isConfirmedAbsent's soundness depends entirely on being called with a
 * keyword-only variant (one that never mixes in semantic-only hits).
 * `HybridSearchResult.ftsMatchMode` (src/search/hybrid-store.ts) is only
 * ever explicitly set to `'or'` — never `'and'` — so a semantic-only hit
 * with no real FTS overlap would also present `ftsMatchMode === undefined`
 * and get misclassified by `decideAbsent`'s `matchMode !== 'or'` branch as
 * "real evidence, never absent". Guard against that by refusing any variant
 * that isn't keyword-only. */
function assertKeywordOnly(variant: Variant): void {
  if (!variant.keywordOnly) {
    throw new Error(
      `isConfirmedAbsent requires a keyword-only variant (e.g. "grep-first"), ` +
        `got "${variant.name}" (keywordOnly: false). A non-keyword-only variant ` +
        `can produce semantic-only hits with no real FTS overlap, whose ` +
        `ftsMatchMode is undefined and would be silently misclassified as ` +
        `"real evidence, never absent".`,
    );
  }
}

/** Check whether a query is confirmed absent against grep-first ALONE —
 * not all variants. The hybrid variants' scores are known-unreliable for
 * this purpose (issue I9: a scoring-floor artifact clusters `final` in a
 * narrow ~0.11-0.16 band regardless of actual relevance, confirmed still
 * reproducing on both as-deployed and full-cov-hybrid as of 2026-07-15).
 * grep-first is also now the actual production-bound architecture per the
 * Stage 1 bake-off verdict, so confirming absence against it specifically
 * confirms exactly what matters going forward.
 *
 * See `decideAbsent` for the actual gating rule — this is the only place
 * that rule is implemented; `main()` reuses it too rather than keeping a
 * second hand-rolled copy of the same predicate. */
export async function isConfirmedAbsent(
  grepFirstVariant: Variant,
  query: string,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): Promise<boolean> {
  assertKeywordOnly(grepFirstVariant);
  const store = grepFirstVariant.openStore();
  try {
    const result = await store.search(query, { topK: 1 });
    const hits = toRunHits(result, 1);
    return decideAbsent(hits.length, result.ftsMatchMode, hits[0]?.final ?? 0, scoreThreshold);
  } finally {
    store.close();
  }
}

const CANDIDATE_ABSENT_QUERIES = [
  'kubernetes horizontal pod autoscaler tuning for a Redis cluster',
  'quarterly OKR review for the marketing analytics team',
  'vendor contract renewal terms for Salesforce',
  'company parental leave policy update',
  'chess opening strategy notes',
  'sourdough bread starter maintenance schedule',
  'garbage collector internals comparison across programming languages',
  'family vacation itinerary planning',
  'home aquarium water chemistry balancing',
  'marathon training pace plan',
];

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const variants = buildVariants(config, REPO_ROOT, 1);
  const grepFirst = variants.find((v) => v.name === 'grep-first');
  if (!grepFirst) throw new Error('grep-first variant not found — check buildVariants()');

  const confirmed: string[] = [];
  for (const query of CANDIDATE_ABSENT_QUERIES) {
    const store = grepFirst.openStore();
    let score = 0;
    let matchMode: 'and' | 'or' = 'and';
    let hitCount = 0;
    try {
      const result = await store.search(query, { topK: 1 });
      const hits = toRunHits(result, 1);
      hitCount = hits.length;
      score = hits[0]?.final ?? 0;
      matchMode = result.ftsMatchMode ?? 'and';
    } finally {
      store.close();
    }
    // Single source of truth for the decision — see decideAbsent's doc
    // comment. `hitCount`/`score`/`matchMode` above are only computed here
    // for the console.log diagnostic below.
    const absent = decideAbsent(hitCount, matchMode, score, DEFAULT_SCORE_THRESHOLD);
    console.log(
      `${absent ? 'ABSENT' : 'FOUND '} "${query}" grep-first score=${score} matchMode=${matchMode}`,
    );
    if (absent) confirmed.push(query);
  }
  console.log(`\n${confirmed.length}/${CANDIDATE_ABSENT_QUERIES.length} candidates confirmed absent.`);
  if (confirmed.length < 5) {
    console.warn('Fewer than 5 confirmed absent — consider authoring more candidates or lowering the threshold.');
  }

  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const withoutPriorAbsent = items.filter(
    (it) => !it.query.startsWith('<ABSENT-STUB') && it.source_ref !== 'author:absent-verified',
  );
  const absentItems: EvalItem[] = confirmed.map((query, i) => ({
    id: `absent-${String(i + 1).padStart(3, '0')}`,
    query,
    category: 'decisions',
    subtype: 'absent',
    source: 'synthetic',
    source_ref: 'author:absent-verified',
    intent: 'robustness: system should return nothing / low-confidence',
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  }));
  writeFileSync(
    join(REPO_ROOT, 'eval/dataset/queries.json'),
    JSON.stringify([...withoutPriorAbsent, ...absentItems], null, 2),
  );
  console.log(
    `Wrote ${absentItems.length} confirmed-absent items to eval/dataset/queries.json (removed placeholder stub and any prior absent batch).`,
  );
}

if (process.argv[1]?.endsWith('author-absent.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
