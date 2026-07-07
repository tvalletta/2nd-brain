import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import type { EvalItem } from './types.js';

/**
 * Starting threshold for "no meaningful match" — a top-hit `final` score
 * below this counts as absent. NOT independently calibrated; the real run
 * (Step 5 below) prints every candidate's top score across all variants so
 * this can be sanity-checked/adjusted against real observed scores before
 * trusting the confirmed-absent set.
 */
const DEFAULT_SCORE_THRESHOLD = 0.02;

/** Check whether a query is confirmed absent across ALL given variants:
 * either zero hits, or the top hit's final score is below the threshold. */
export async function isConfirmedAbsent(
  variants: Variant[],
  query: string,
  scoreThreshold = DEFAULT_SCORE_THRESHOLD,
): Promise<boolean> {
  for (const variant of variants) {
    const store = variant.openStore();
    try {
      const result = await store.search(query, { topK: 1 });
      const hits = toRunHits(result, 1);
      if (hits.length > 0 && hits[0].final >= scoreThreshold) {
        return false;
      }
    } finally {
      store.close();
    }
  }
  return true;
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

  const confirmed: string[] = [];
  for (const query of CANDIDATE_ABSENT_QUERIES) {
    const scores: Record<string, number> = {};
    let absent = true;
    for (const variant of variants) {
      const store = variant.openStore();
      try {
        const result = await store.search(query, { topK: 1 });
        const hits = toRunHits(result, 1);
        const top = hits[0]?.final ?? 0;
        scores[variant.name] = top;
        if (top >= DEFAULT_SCORE_THRESHOLD) absent = false;
      } finally {
        store.close();
      }
    }
    console.log(`${absent ? 'ABSENT' : 'FOUND '} "${query}" scores=${JSON.stringify(scores)}`);
    if (absent) confirmed.push(query);
  }
  console.log(`\n${confirmed.length}/${CANDIDATE_ABSENT_QUERIES.length} candidates confirmed absent.`);
  if (confirmed.length < 5) {
    console.warn('Fewer than 5 confirmed absent — consider authoring more candidates or lowering the threshold.');
  }

  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const withoutStub = items.filter((it) => !it.query.startsWith('<ABSENT-STUB'));
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
  writeFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), JSON.stringify([...withoutStub, ...absentItems], null, 2));
  console.log(`Wrote ${absentItems.length} confirmed-absent items to eval/dataset/queries.json (removed placeholder stub).`);
}

if (process.argv[1]?.endsWith('author-absent.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
