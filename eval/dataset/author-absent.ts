import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import type { EvalItem } from './types.js';

/**
 * Starting threshold for "no meaningful match" — a top-hit `final` score
 * below this counts as absent. Scored against grep-first alone (see
 * isConfirmedAbsent below for why). The real run (main() below) prints every
 * candidate's grep-first top score so this can be sanity-checked/adjusted
 * against real observed scores before trusting the confirmed-absent set.
 */
const DEFAULT_SCORE_THRESHOLD = 0.02;

/** Check whether a query is confirmed absent against grep-first ALONE —
 * not all variants. The hybrid variants' scores are known-unreliable for
 * this purpose (issue I9: a scoring-floor artifact clusters `final` in a
 * narrow ~0.11-0.16 band regardless of actual relevance, confirmed still
 * reproducing on both as-deployed and full-cov-hybrid as of 2026-07-15).
 * grep-first is also now the actual production-bound architecture per the
 * Stage 1 bake-off verdict, so confirming absence against it specifically
 * confirms exactly what matters going forward. */
export async function isConfirmedAbsent(
  grepFirstVariant: Variant,
  query: string,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): Promise<boolean> {
  const store = grepFirstVariant.openStore();
  try {
    const result = await store.search(query, { topK: 1 });
    const hits = toRunHits(result, 1);
    if (hits.length > 0 && hits[0].final >= scoreThreshold) return false;
    return true;
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
    try {
      const result = await store.search(query, { topK: 1 });
      const hits = toRunHits(result, 1);
      score = hits[0]?.final ?? 0;
    } finally {
      store.close();
    }
    const absent = score < DEFAULT_SCORE_THRESHOLD;
    console.log(`${absent ? 'ABSENT' : 'FOUND '} "${query}" grep-first score=${score}`);
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
