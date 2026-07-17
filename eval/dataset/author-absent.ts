import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import type { EvalItem } from './types.js';

/**
 * Score ceiling for an OR-fallback match's `final` score to still count as
 * "no meaningful match" (see isConfirmedAbsent for the full gating rule —
 * this threshold is a secondary safety net, not the primary signal; see
 * below for why it can now almost never fire).
 *
 * Recalibration history — this number has been wrong twice, for two
 * different reasons:
 *
 * 1. (2026-07-16, pre-I9-fix) After grep-recall-improvements' AND-first/
 *    OR-fallback relaxation landed (commit 6c6e30a), a live run showed all
 *    10 original candidates scoring 0.036-0.089 (raw, unnormalized `final`),
 *    because `final = α·rrf + β·recency` let β·recency dominate the tiny
 *    raw RRF contribution (≤ ~0.017 for a single-list keyword pool, k=60).
 *    DEFAULT_SCORE_THRESHOLD was set to 0.1 to sit above that observed
 *    ~0.089 ceiling, with the actual absent/present decision moved onto
 *    `result.ftsMatchMode` as the primary signal (this threshold as a
 *    rarely-firing safety net only).
 *
 * 2. (2026-07-17, post-I9-fix) The I9 fix (commit 4d137bb, `hybrid-store.ts`
 *    `search()`) normalizes raw RRF by the theoretical max for the query's
 *    pool composition (`maxPossibleRrfScore = lists.length / 60`) before
 *    blending with recency. `isConfirmedAbsent`/`main()` route through this
 *    same `search()`, so grep-first's scores moved too, even though nobody
 *    was specifically targeting grep-first with that fix. For a keyword-
 *    only variant, `lists.length === 1`, so a rank-0 hit's raw RRF (~1/61)
 *    now normalizes to ~0.98 instead of contributing its old tiny raw
 *    value. Re-running against the live vault (2026-07-17) confirmed this:
 *    all 10 candidates now score 0.850-0.911 regardless of `ftsMatchMode`
 *    ('and' or 'or') — the old 0.1 threshold no longer clears anything
 *    (0/10 confirmed absent, where 7/10 should be). DEFAULT_SCORE_THRESHOLD
 *    is recalibrated to 0.95, comfortably above the entire observed
 *    0.850-0.911 band (and above the theoretical per-content-type ceiling,
 *    worked out from `score < (1 - β) + β·recencyCap`: with the lowest
 *    configured β = 0.1 for `concept` docs and recency capped at 0.5, the
 *    ceiling is ~0.935), while still being a real number below 1.0 rather
 *    than an intentionally-unreachable one.
 *
 * Bottom line for anyone re-running this tool: `ftsMatchMode` is now the
 * *sole* practical signal — an 'and' match (every query token co-occurs in
 * one document, real relevance evidence) is never confirmed absent no
 * matter the score, and an 'or' match (recall-relaxation fallback found
 * only a partial/coincidental overlap) is confirmed absent unless its score
 * clears this threshold, which real-world 'or' matches essentially never
 * do post-I9-fix (they cluster in the same 0.85-0.91 band as 'and'
 * matches — normalization collapses the score's ability to discriminate
 * real relevance from coincidental overlap for a top-ranked single-doc
 * hit). This threshold is retained as a nominal safety net for a
 * hypothetical unusually-low-recency, unusually-low-β OR match, not
 * because it's expected to ever actually fire on this vault.
 *
 * KNOWN, ACCEPTED METHODOLOGICAL LIMITATION: this threshold's calibration
 * history above is coupled to this same codebase's own observed scoring
 * behavior across multiple iterations, not derived from an independent
 * standard. This is a disclosed, accepted limitation specific to this
 * absent-item confirmation mechanism — it does not affect the ground truth
 * for the rest of the eval dataset (plaud/ai-session/entities/hot-topics/
 * decisions items are grounded in real usage + manual verification,
 * independent of this threshold). Anyone re-tuning this threshold in the
 * future should treat it as testing self-consistency with the current
 * system, not as an independently-verified absolute standard.
 */
const DEFAULT_SCORE_THRESHOLD = 0.95;

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
 * not all variants. Historically (as of 2026-07-15) the hybrid variants'
 * scores were also known-unreliable for this purpose (issue I9: a scoring-
 * floor artifact clustered `final` in a narrow ~0.11-0.16 band regardless
 * of actual relevance, reproducing on both as-deployed and full-cov-
 * hybrid). I9 was fixed 2026-07-16 (commit 4d137bb, `hybrid-store.ts`
 * `search()`) for all variants, not just grep-first — but grep-first is
 * still the only variant exercised here, because it's now the actual
 * production-bound architecture per the Stage 1 bake-off verdict, so
 * confirming absence against it specifically confirms exactly what matters
 * going forward (not re-tested against the other variants here since
 * they're no longer in scope for this tool's purpose).
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
