import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHit, RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';
import type { EvalItem } from '../dataset/types.js';
import { recallAtK, precisionAtK, reciprocalRank, firstRelevantRank } from './metrics.js';
import { restrictToScope } from './scope.js';
import { bootstrapCI } from './bootstrap.js';
import { mean, median, percentile } from './stats.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const K_VALUES = [10, 5] as const;
const RELEVANCE_LEVELS = ['e', 'e_primary'] as const;
const SCOPES = ['full-corpus', 'scope-matched'] as const;

export type Relevance = (typeof RELEVANCE_LEVELS)[number];
export type Scope = (typeof SCOPES)[number];

/** `n` is the item count behind `recall_at_k`/`mrr` specifically (items with
 * a non-empty relevant set). `precision_at_k` and `median_first_rank` are
 * each averaged over their own defined subset — an item can have a
 * non-empty relevant set (recall counted) while its returned hits are all
 * excluded from precision (e.g. all fell outside scope-matched restriction)
 * — so their true denominators can be smaller than `n`. Trust `mean`/`ci`
 * only when the relevant subset is non-empty; `mean()` returns 0 (not null)
 * for an empty array, so a `n: 0` cell's `recall_at_k.mean`/`mrr.mean` read
 * as 0 rather than "undefined". */
export interface MetricCell {
  k: number;
  relevance: Relevance;
  scope: Scope;
  n: number;
  recall_at_k: { mean: number; ci: [number, number] };
  precision_at_k: { mean: number; ci: [number, number] };
  mrr: { mean: number; ci: [number, number] };
  median_first_rank: number | null;
}

export interface CategoryVariantScore {
  category: string;
  variant: string;
  n_items: number;
  cells: MetricCell[];
  latency_ms_median: number;
  latency_ms_p95: number;
  response_tokens_median: number;
}

export interface Scorecard {
  run: {
    date: string;
    generated_at: string;
    db_doc_count: number;
    any_degraded_runs: boolean;
  };
  by_category_variant: CategoryVariantScore[];
  routing: unknown;
  coverage: unknown;
}

export interface ScorecardInput {
  runsFile: {
    dbSnapshot: { docCount: number; newestIndexedAt: string };
    indexChangedDuringRun?: {
      before: { docCount: number; newestIndexedAt: string };
      after: { docCount: number; newestIndexedAt: string };
    };
    results: RunResult[];
  };
  judgments: Judgment[];
  items: EvalItem[];
  routingAnalysis: { routing: unknown };
  coverageFunnel: unknown;
}

export interface RelevanceEntry {
  e: Set<string>;
  e_primary: Set<string>;
}

/** Build item_id -> {e, e_primary} from judgments.json. Every judgment
 * counts as trusted ground truth regardless of label_provenance — the
 * judging-v2 dual-judge/behavioral-shortcut design already established
 * that provenance is a diagnostic field, not a scoring filter (spec
 * addendum §19). */
export function buildRelevanceIndex(judgments: Judgment[]): Map<string, RelevanceEntry> {
  const index = new Map<string, RelevanceEntry>();
  for (const j of judgments) {
    if (!index.has(j.item_id)) index.set(j.item_id, { e: new Set(), e_primary: new Set() });
    const entry = index.get(j.item_id)!;
    if (j.label >= 1) entry.e.add(j.doc_id);
    if (j.label === 2) entry.e_primary.add(j.doc_id);
  }
  return index;
}

function relevantSetFor(relevance: Relevance, entry: RelevanceEntry | undefined): Set<string> {
  if (!entry) return new Set();
  return relevance === 'e' ? entry.e : entry.e_primary;
}

export function computeCell(
  k: number,
  relevance: Relevance,
  scope: Scope,
  groupResults: RunResult[],
  relevanceIndex: Map<string, RelevanceEntry>,
): MetricCell {
  const recalls: number[] = [];
  const precisions: number[] = [];
  const rrs: number[] = [];
  const firstRanks: number[] = [];

  for (const result of groupResults) {
    const entry = relevanceIndex.get(result.itemId);
    // A thrown search call scores as a total miss (empty returned), not a
    // skip (spec §15) — this naturally drives recall to 0 for that item
    // when its E is non-empty, without special-casing the metric functions.
    let returned: RunHit[] = result.error ? [] : result.returned;
    let relevantDocIds = relevantSetFor(relevance, entry);

    if (scope === 'scope-matched') {
      const restricted = restrictToScope(returned, relevantDocIds);
      returned = restricted.returned;
      relevantDocIds = restricted.relevantDocIds;
    }

    const recall = recallAtK(returned, relevantDocIds, k);
    if (recall !== null) recalls.push(recall);

    const precision = precisionAtK(returned, relevantDocIds, k);
    if (precision !== null) precisions.push(precision);

    rrs.push(reciprocalRank(returned, relevantDocIds, k));

    const firstRank = firstRelevantRank(returned, relevantDocIds, k);
    if (firstRank !== null) firstRanks.push(firstRank);
  }

  return {
    k,
    relevance,
    scope,
    n: recalls.length,
    recall_at_k: { mean: mean(recalls), ci: bootstrapCI(recalls) },
    precision_at_k: { mean: mean(precisions), ci: bootstrapCI(precisions) },
    mrr: { mean: mean(rrs), ci: bootstrapCI(rrs) },
    median_first_rank: firstRanks.length > 0 ? median(firstRanks) : null,
  };
}

/** Pure scorecard assembly — no file I/O, so this is directly unit-testable
 * with small fixtures. `main()` below does the real file I/O and calls
 * this. */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const { runsFile, judgments, items, routingAnalysis, coverageFunnel } = input;
  const itemCategory = new Map(items.map((it) => [it.id, it.category]));
  const relevanceIndex = buildRelevanceIndex(judgments);

  const groups = new Map<string, RunResult[]>();
  for (const result of runsFile.results) {
    const category = itemCategory.get(result.itemId);
    if (!category) continue; // not in the finalized dataset — shouldn't happen, see plan Global Constraints
    const key = `${category}::${result.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(result);
  }

  const byCategoryVariant: CategoryVariantScore[] = [...groups.entries()].map(([key, groupResults]) => {
    const [category, variant] = key.split('::');
    const cells: MetricCell[] = [];
    for (const k of K_VALUES) {
      for (const relevance of RELEVANCE_LEVELS) {
        for (const scope of SCOPES) {
          cells.push(computeCell(k, relevance, scope, groupResults, relevanceIndex));
        }
      }
    }
    const latencies = groupResults.map((r) => r.latencyMs);
    const tokens = groupResults.map((r) => r.responseTokensEst);
    return {
      category,
      variant,
      n_items: groupResults.length,
      cells,
      latency_ms_median: median(latencies),
      latency_ms_p95: percentile(latencies, 0.95),
      response_tokens_median: median(tokens),
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  return {
    run: {
      date,
      generated_at: new Date().toISOString(),
      db_doc_count: runsFile.dbSnapshot.docCount,
      any_degraded_runs: !!runsFile.indexChangedDuringRun,
    },
    by_category_variant: byCategoryVariant,
    routing: routingAnalysis.routing,
    coverage: coverageFunnel,
  };
}

interface RunsFile {
  generatedAt: string;
  dbSnapshot: { docCount: number; newestIndexedAt: string };
  variants: string[];
  k: number;
  itemCount: number;
  results: RunResult[];
  indexChangedDuringRun?: {
    before: { docCount: number; newestIndexedAt: string };
    after: { docCount: number; newestIndexedAt: string };
  };
}

/** `pnpm eval:run` writes a new dated `<date>-runs.json` each time it's
 * re-run (e.g. to get a clean, non-degraded baseline) — always score
 * against the most recent one rather than a hardcoded filename. */
export function findLatestRunsFile(resultsDir: string): string {
  const candidates = readdirSync(resultsDir).filter((f) => /^\d{4}-\d{2}-\d{2}-runs\.json$/.test(f));
  if (candidates.length === 0) throw new Error(`No <date>-runs.json file found in ${resultsDir}`);
  candidates.sort();
  return join(resultsDir, candidates[candidates.length - 1]);
}

async function main() {
  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  const runsFilePath = findLatestRunsFile(resultsDir);
  console.log(`Scoring against ${runsFilePath.replace(REPO_ROOT + '/', '')}`);
  const runsFile: RunsFile = JSON.parse(readFileSync(runsFilePath, 'utf8'));
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));
  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const routingAnalysis = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/routing-analysis.json'), 'utf8'));
  const coverageFunnel = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/coverage-funnel.json'), 'utf8'));

  const scorecard = buildScorecard({ runsFile, judgments, items, routingAnalysis, coverageFunnel });

  const outPath = join(REPO_ROOT, 'eval', 'results', `${scorecard.run.date}-scorecard.json`);
  writeFileSync(outPath, JSON.stringify(scorecard, null, 2));
  console.log(`Wrote eval/results/${scorecard.run.date}-scorecard.json`);
  console.log(`${scorecard.by_category_variant.length} category×variant groups scored.`);
}

if (process.argv[1]?.endsWith('build-scorecard.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
