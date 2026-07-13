import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHit, RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';
import type { EvalItem } from '../dataset/types.js';
import { recallAtK, precisionAtK, reciprocalRank, firstRelevantRank } from './metrics.js';
import { restrictToScope } from './scope.js';
import { bootstrapCI } from './bootstrap.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const K_VALUES = [10, 5] as const;
const RELEVANCE_LEVELS = ['e', 'e_primary'] as const;
const SCOPES = ['full-corpus', 'scope-matched'] as const;

type Relevance = (typeof RELEVANCE_LEVELS)[number];
type Scope = (typeof SCOPES)[number];

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
    indexChangedDuringRun: boolean;
    results: RunResult[];
  };
  judgments: Judgment[];
  items: EvalItem[];
  routingAnalysis: { routing: unknown };
  coverageFunnel: unknown;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

interface RelevanceEntry {
  e: Set<string>;
  e_primary: Set<string>;
}

/** Build item_id -> {e, e_primary} from judgments.json. Every judgment
 * counts as trusted ground truth regardless of label_provenance — the
 * judging-v2 dual-judge/behavioral-shortcut design already established
 * that provenance is a diagnostic field, not a scoring filter (spec
 * addendum §19). */
function buildRelevanceIndex(judgments: Judgment[]): Map<string, RelevanceEntry> {
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

function computeCell(
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
      any_degraded_runs: runsFile.indexChangedDuringRun,
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
  indexChangedDuringRun: boolean;
}

async function main() {
  const runsFile: RunsFile = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/results/2026-07-06-runs.json'), 'utf8'));
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
