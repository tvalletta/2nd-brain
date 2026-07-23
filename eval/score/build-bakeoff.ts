import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';
import { VARIANT_PROFILES } from '../run/variants.js';
import { computeCell, buildRelevanceIndex, type MetricCell, type Scorecard } from './build-scorecard.js';
import { median, percentile } from './stats.js';
import { bootstrapCI } from './bootstrap.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const CONTENDERS = ['grep-first', 'full-cov-hybrid'] as const;
type Contender = (typeof CONTENDERS)[number];

/** Alternate composite weightings for the sensitivity check (Task 7): does
 * "grep-first wins" hold up under weighting schemes other than the primary
 * 0.50/0.20/0.15/0.15, or is it an artifact of those specific weights? */
const WEIGHT_SCHEMES: Array<{ label: string; accuracy: number; latency: number; tokens: number; simplicity: number }> = [
  { label: 'equal-weight', accuracy: 0.25, latency: 0.25, tokens: 0.25, simplicity: 0.25 },
  { label: 'zero-simplicity', accuracy: 0.5, latency: 0.3, tokens: 0.2, simplicity: 0 },
  { label: 'accuracy-only', accuracy: 1.0, latency: 0, tokens: 0, simplicity: 0 },
];

const DEPS_WEIGHT = 2;
const JOBS_WEIGHT = 2;
const FAILURE_MODES_WEIGHT = 1;
const SURFACE_WEIGHT: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 0.5, high: 1 };

export interface ArmComposite {
  name: Contender;
  accuracy: { recall_at_10: number; precision_at_10: number; mrr: number; sub: number };
  latency: { median_ms: number; p95_ms: number; sub: number };
  tokens: { median: number; sub: number };
  simplicity: { penalty: number; sub: number };
  composite: number;
  by_category: Record<string, { composite: number }>;
}

export interface BakeoffVerdict {
  winner: Contender;
  margin: number;
  rationale: string;
  mixed: boolean;
}

export interface Bakeoff {
  run: {
    date: string;
    eval_set_version: string;
    k: number;
    any_degraded_runs: boolean;
    answerQualityValidation: { status: AnswerQualityValidationStatus; answerQualityDate: string | null };
  };
  backfill_ledger: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
  arms: ArmComposite[];
  verdict: BakeoffVerdict;
  subtypeSlices?: Array<{
    label: string;
    idPrefix: string;
    byVariant: Record<string, {
      recall_ci: [number, number];
      precision_ci: [number, number];
      mrr_ci: [number, number];
      composite_ci: [number, number];
    }>;
  }>;
  weightSensitivity: Array<{
    label: string;
    weights: { accuracy: number; latency: number; tokens: number; simplicity: number };
    results: Record<string, { composite: number }>;
    winner: string;
  }>;
}

export interface BakeoffInput {
  runsResults: RunResult[];
  scorecard: Scorecard;
  judgments: Judgment[];
  backfillReport: { notes_embedded: number; wall_clock_min: number; db_size_delta_gb: number };
  answerQualityCheck?: { status: AnswerQualityValidationStatus; answerQualityDate: string | null };
}

/** Total simplicity penalty for one arm (spec §4.6). deps/jobs/failure-mode
 * penalties are fixed per-factor weights triggered by "does this arm have
 * any of these at all" (not a literal count — the spec table assigns a
 * flat 2/2/1 weight per factor, not one point per array entry). Storage
 * uses the real measured GB value directly, since it's a continuous fact,
 * not a category. Code surface uses the resolved low=0/high=1 (medium=0.5
 * for type completeness, unused by either current arm). */
function computeSimplicityPenalty(name: Contender): number {
  const profile = VARIANT_PROFILES[name];
  const depsPenalty = profile.runtimeDeps.length > 0 ? DEPS_WEIGHT : 0;
  const jobsPenalty = profile.maintenanceJobs.length > 0 ? JOBS_WEIGHT : 0;
  const failureModesPenalty = profile.silentDegradationModes.length > 0 ? FAILURE_MODES_WEIGHT : 0;
  const surfacePenalty = SURFACE_WEIGHT[profile.codeSurface];
  return depsPenalty + profile.storageGbBeyondFts + jobsPenalty + failureModesPenalty + surfacePenalty;
}

/** Item-weighted accuracy across ALL of a variant's results, pooled
 * (ignoring category grouping) — avoids re-averaging the scorecard's
 * already-aggregated per-category means, which have different per-metric
 * item counts that don't combine by simple averaging. Matches spec §4.4's
 * original formula inputs: E (label>=1), full-corpus, k=10. */
function pooledAccuracyCell(
  variantResults: RunResult[],
  relevanceIndex: ReturnType<typeof buildRelevanceIndex>,
): MetricCell {
  return computeCell(10, 'e', 'full-corpus', variantResults, relevanceIndex);
}

function accuracySub(cell: MetricCell): number {
  return 0.6 * cell.recall_at_k.mean + 0.25 * cell.precision_at_k.mean + 0.15 * cell.mrr.mean;
}

/** Bootstrap 95% CIs for recall/precision/MRR on a single id-prefix slice
 * (e.g. "fuzzy-" or "relationship-") of one contender's results, plus a
 * composite-level CI that only propagates accuracy-side resampling
 * uncertainty — latency/tokens/simplicity sub-scores are held fixed at
 * their point estimates, since they aren't naturally item-resampled
 * quantities the same way per-item recall/precision/MRR are. This is a
 * stated, documented limitation of the composite CI, not a full
 * uncertainty propagation (spec: eval-methodology-hardening-design.md §7.3). */
function subtypeSliceCIs(
  idPrefix: string,
  variantResults: RunResult[],
  relevanceIndex: ReturnType<typeof buildRelevanceIndex>,
  fixedLatSub: number,
  fixedTokSub: number,
  fixedSimSub: number,
): {
  recall_ci: [number, number];
  precision_ci: [number, number];
  mrr_ci: [number, number];
  composite_ci: [number, number];
} {
  const sliceResults = variantResults.filter((r) => r.itemId.startsWith(idPrefix));
  const recalls: number[] = [];
  const precisions: number[] = [];
  const rrs: number[] = [];
  const composites: number[] = [];

  for (const result of sliceResults) {
    const cell = computeCell(10, 'e', 'full-corpus', [result], relevanceIndex);
    recalls.push(cell.recall_at_k.mean);
    precisions.push(cell.precision_at_k.mean);
    rrs.push(cell.mrr.mean);
    const itemAccSub = 0.6 * cell.recall_at_k.mean + 0.25 * cell.precision_at_k.mean + 0.15 * cell.mrr.mean;
    composites.push(0.5 * itemAccSub + 0.2 * fixedLatSub + 0.15 * fixedTokSub + 0.15 * fixedSimSub);
  }

  return {
    recall_ci: bootstrapCI(recalls),
    precision_ci: bootstrapCI(precisions),
    mrr_ci: bootstrapCI(rrs),
    composite_ci: bootstrapCI(composites),
  };
}

/** Pure bake-off assembly — no file I/O, directly unit-testable with small
 * fixtures. `main()` below does the real file I/O and calls this. */
export function buildBakeoff(input: BakeoffInput): Bakeoff {
  const { runsResults, scorecard, judgments, backfillReport } = input;
  const relevanceIndex = buildRelevanceIndex(judgments);

  const armStats = new Map<
    Contender,
    { cell: MetricCell; latencyMedian: number; latencyP95: number; tokensMedian: number }
  >();
  for (const name of CONTENDERS) {
    // Excludes as-deployed by construction (CONTENDERS has only 2 entries) —
    // the reference arm's results are simply never pooled or normalized
    // against here (spec §11 addendum: as-deployed must not deflate/inflate
    // either contender's sub-score).
    const variantResults = runsResults.filter((r) => r.variant === name);
    const cell = pooledAccuracyCell(variantResults, relevanceIndex);
    const latencies = variantResults.map((r) => r.latencyMs);
    const tokens = variantResults.map((r) => r.responseTokensEst);
    armStats.set(name, {
      cell,
      latencyMedian: median(latencies),
      latencyP95: percentile(latencies, 0.95),
      tokensMedian: median(tokens),
    });
  }

  const bestLatency = Math.min(...CONTENDERS.map((n) => armStats.get(n)!.latencyMedian));
  const bestTokens = Math.min(...CONTENDERS.map((n) => armStats.get(n)!.tokensMedian));

  const penalties = new Map(CONTENDERS.map((n) => [n, computeSimplicityPenalty(n)]));
  const maxPenalty = Math.max(...CONTENDERS.map((n) => penalties.get(n)!));

  const categoriesForVariant = (name: Contender) => scorecard.by_category_variant.filter((g) => g.variant === name);

  // Per-category "best" (min of the two contenders' OWN category-level
  // medians) — mirrors the arm-level bestLatency/bestTokens pattern, but
  // scoped to each category, since a category's own scale (e.g. entities'
  // near-instant keyword lookups) can differ by orders of magnitude from
  // an arm's overall pooled scale. Using the arm-level pooled best here
  // instead produced nonsensical >1 by_category composites (found in
  // review — e.g. grep-first/entities computed as 11.32).
  const categoryBest = new Map<string, { latency: number; tokens: number }>();
  for (const group of scorecard.by_category_variant) {
    if (!(CONTENDERS as readonly string[]).includes(group.variant)) continue;
    const existing = categoryBest.get(group.category);
    categoryBest.set(group.category, {
      latency: existing ? Math.min(existing.latency, group.latency_ms_median) : group.latency_ms_median,
      tokens: existing ? Math.min(existing.tokens, group.response_tokens_median) : group.response_tokens_median,
    });
  }

  const arms: ArmComposite[] = CONTENDERS.map((name) => {
    const stats = armStats.get(name)!;
    const accSub = accuracySub(stats.cell);
    const latSub = stats.latencyMedian > 0 ? bestLatency / stats.latencyMedian : 1;
    const tokSub = stats.tokensMedian > 0 ? bestTokens / stats.tokensMedian : 1;
    const penalty = penalties.get(name)!;
    const simSub = maxPenalty > 0 ? 1 - penalty / maxPenalty : 1;
    const composite = 0.5 * accSub + 0.2 * latSub + 0.15 * tokSub + 0.15 * simSub;

    const byCategory: Record<string, { composite: number }> = {};
    for (const group of categoriesForVariant(name)) {
      const groupCell = group.cells.find((c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus');
      if (!groupCell) continue;
      const catBest = categoryBest.get(group.category)!;
      const groupAccSub = accuracySub(groupCell);
      const groupLatSub = group.latency_ms_median > 0 ? catBest.latency / group.latency_ms_median : 1;
      const groupTokSub = group.response_tokens_median > 0 ? catBest.tokens / group.response_tokens_median : 1;
      byCategory[group.category] = {
        composite: 0.5 * groupAccSub + 0.2 * groupLatSub + 0.15 * groupTokSub + 0.15 * simSub,
      };
    }

    return {
      name,
      accuracy: {
        recall_at_10: stats.cell.recall_at_k.mean,
        precision_at_10: stats.cell.precision_at_k.mean,
        mrr: stats.cell.mrr.mean,
        sub: accSub,
      },
      latency: { median_ms: stats.latencyMedian, p95_ms: stats.latencyP95, sub: latSub },
      tokens: { median: stats.tokensMedian, sub: tokSub },
      simplicity: { penalty, sub: simSub },
      composite,
      by_category: byCategory,
    };
  });

  const subtypeSlices = [
    { label: 'fuzzy-recall', idPrefix: 'fuzzy-' },
    { label: 'relationship', idPrefix: 'relationship-' },
  ].map(({ label, idPrefix }) => {
    const byVariant: Record<string, ReturnType<typeof subtypeSliceCIs>> = {};
    for (const name of CONTENDERS) {
      const variantResults = runsResults.filter((r) => r.variant === name);
      const arm = arms.find((a) => a.name === name)!;
      byVariant[name] = subtypeSliceCIs(
        idPrefix,
        variantResults,
        relevanceIndex,
        arm.latency.sub,
        arm.tokens.sub,
        arm.simplicity.sub,
      );
    }
    return { label, idPrefix, byVariant };
  });

  const weightSensitivity = WEIGHT_SCHEMES.map((scheme) => {
    const results: Record<string, { composite: number }> = {};
    for (const arm of arms) {
      results[arm.name] = {
        composite:
          scheme.accuracy * arm.accuracy.sub +
          scheme.latency * arm.latency.sub +
          scheme.tokens * arm.tokens.sub +
          scheme.simplicity * arm.simplicity.sub,
      };
    }
    const [nameA, nameB] = CONTENDERS;
    const winner = results[nameA].composite >= results[nameB].composite ? nameA : nameB;
    return { label: scheme.label, weights: scheme, results, winner };
  });

  const [a, b] = arms;
  const margin = Math.abs(a.composite - b.composite);
  // Ties within 0.03 go to grep-first (simplicity tiebreak, spec §4.5's stated lean).
  const winner: Contender = margin <= 0.03 ? 'grep-first' : a.composite > b.composite ? a.name : b.name;
  const winnerArm = arms.find((arm) => arm.name === winner)!;
  const loserArm = arms.find((arm) => arm.name !== winner)!;
  const mixed = Object.keys(winnerArm.by_category).some((cat) => {
    const winnerCatComposite = winnerArm.by_category[cat]?.composite;
    const loserCatComposite = loserArm.by_category[cat]?.composite;
    return winnerCatComposite !== undefined && loserCatComposite !== undefined && loserCatComposite > winnerCatComposite;
  });
  const rationale =
    margin <= 0.03
      ? `Composite scores are within the 0.03 tie threshold (margin ${margin.toFixed(3)}) — simplicity breaks the tie in favor of grep-first per spec §4.5.`
      : `${winner} wins by a ${margin.toFixed(3)} composite margin over ${loserArm.name}.`;

  return {
    run: {
      date: new Date().toISOString().slice(0, 10),
      eval_set_version: scorecard.run.date,
      k: 10,
      any_degraded_runs: scorecard.run.any_degraded_runs,
      answerQualityValidation: input.answerQualityCheck ?? { status: 'missing', answerQualityDate: null },
    },
    backfill_ledger: {
      notes_embedded: backfillReport.notes_embedded,
      wall_clock_min: backfillReport.wall_clock_min,
      db_size_delta_gb: backfillReport.db_size_delta_gb,
    },
    arms,
    verdict: { winner, margin: +margin.toFixed(3), rationale, mixed },
    subtypeSlices,
    weightSensitivity,
  };
}

/** Human-readable companion to the JSON (spec §4.7 requires both). */
export function renderBakeoffMarkdown(bakeoff: Bakeoff): string {
  const lines: string[] = [];
  lines.push(`# Bake-off Report — ${bakeoff.run.date}`, '');
  lines.push(`## Verdict`, '');
  lines.push(`**Winner: ${bakeoff.verdict.winner}** (margin: ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed ? 'yes' : 'no'})`, '');
  lines.push(bakeoff.verdict.rationale, '');
  if (bakeoff.run.any_degraded_runs) {
    lines.push(`⚠️ **This run's underlying harness pass was flagged degraded** (the live index changed mid-run) — see the scorecard for details.`, '');
  }
  lines.push(`## Backfill cost (Arm B, full-cov-hybrid)`, '');
  lines.push(`- Notes embedded: ${bakeoff.backfill_ledger.notes_embedded}`);
  lines.push(`- Wall clock: ${bakeoff.backfill_ledger.wall_clock_min} min`);
  lines.push(`- DB size delta: ${bakeoff.backfill_ledger.db_size_delta_gb} GB`, '');
  lines.push(`## Composite scores`, '');
  lines.push(`| Arm | Accuracy | Latency | Tokens | Simplicity | Composite |`);
  lines.push(`|-----|----------|---------|--------|------------|-----------|`);
  for (const arm of bakeoff.arms) {
    lines.push(
      `| ${arm.name} | ${arm.accuracy.sub.toFixed(3)} | ${arm.latency.sub.toFixed(3)} | ${arm.tokens.sub.toFixed(3)} | ${arm.simplicity.sub.toFixed(3)} | ${arm.composite.toFixed(3)} |`,
    );
  }
  lines.push('');
  for (const slice of bakeoff.subtypeSlices ?? []) {
    lines.push(`## ${slice.label} (subtype-scoped, with 95% CI)`, '');
    lines.push(`| Variant | Recall@10 CI | Precision@10 CI | MRR CI | Composite CI |`);
    lines.push(`|---|---|---|---|---|`);
    for (const [variant, ci] of Object.entries(slice.byVariant)) {
      lines.push(
        `| ${variant} | [${ci.recall_ci[0].toFixed(3)}, ${ci.recall_ci[1].toFixed(3)}] | ` +
        `[${ci.precision_ci[0].toFixed(3)}, ${ci.precision_ci[1].toFixed(3)}] | ` +
        `[${ci.mrr_ci[0].toFixed(3)}, ${ci.mrr_ci[1].toFixed(3)}] | ` +
        `[${ci.composite_ci[0].toFixed(3)}, ${ci.composite_ci[1].toFixed(3)}] |`,
      );
    }
    lines.push('');
  }
  if ((bakeoff.subtypeSlices?.length ?? 0) > 0) {
    lines.push(
      `_Composite CIs only propagate accuracy-side resampling uncertainty — ` +
      `latency/tokens/simplicity sub-scores are held fixed at their point estimates ` +
      `for this computation (see spec §7.3)._`,
      '',
    );
  }
  lines.push(`## Composite-weight sensitivity`, '');
  lines.push(`| Weighting | grep-first | full-cov-hybrid | Winner |`);
  lines.push(`|---|---|---|---|`);
  for (const scheme of bakeoff.weightSensitivity) {
    const [nameA, nameB] = ['grep-first', 'full-cov-hybrid'] as const;
    lines.push(
      `| ${scheme.label} | ${scheme.results[nameA].composite.toFixed(3)} | ` +
      `${scheme.results[nameB].composite.toFixed(3)} | ${scheme.winner} |`,
    );
  }
  const allGrepWins = bakeoff.weightSensitivity.every((s) => s.winner === 'grep-first');
  lines.push(
    '',
    allGrepWins
      ? '**grep-first wins under every tested weighting scheme, including the primary — the verdict is not an artifact of the specific 0.50/0.20/0.15/0.15 weights.**'
      : '**grep-first does NOT win under every tested weighting scheme — the verdict is sensitive to weighting choice; see the table above for which schemes flip it.**',
    '',
  );
  lines.push(`## By category`, '');
  const categories = [...new Set(bakeoff.arms.flatMap((arm) => Object.keys(arm.by_category)))].sort();
  if (categories.length > 0) {
    lines.push(`| Category | ${bakeoff.arms.map((a) => a.name).join(' | ')} |`);
    lines.push(`|----------|${bakeoff.arms.map(() => '---').join('|')}|`);
    for (const cat of categories) {
      const cells = bakeoff.arms.map((arm) => arm.by_category[cat]?.composite?.toFixed(3) ?? 'n/a');
      lines.push(`| ${cat} | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function findLatestDatedFile(dir: string, suffixPattern: RegExp): string {
  const candidates = readdirSync(dir).filter((f) => suffixPattern.test(f));
  if (candidates.length === 0) throw new Error(`No file matching ${suffixPattern} found in ${dir}`);
  candidates.sort();
  return join(dir, candidates[candidates.length - 1]);
}

export type AnswerQualityValidationStatus = 'fresh' | 'stale' | 'missing';

/**
 * Compare the latest downstream answer-quality check file's date against
 * this bake-off run's date. 'stale' means the answer-quality check predates
 * this bake-off run, so it was computed against an older dataset/judgments
 * snapshot and may no longer validate the current composite verdict.
 */
export function checkAnswerQualityFreshness(
  resultsDir: string,
  bakeoffDate: string,
): { status: AnswerQualityValidationStatus; answerQualityDate: string | null } {
  const pattern = /^(\d{4}-\d{2}-\d{2})-answer-quality\.json$/;
  let candidates: string[];
  try {
    candidates = readdirSync(resultsDir).filter((f) => pattern.test(f));
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    return { status: 'missing', answerQualityDate: null };
  }
  candidates.sort();
  const latest = candidates[candidates.length - 1];
  const answerQualityDate = latest.match(pattern)![1];
  const status: AnswerQualityValidationStatus = answerQualityDate >= bakeoffDate ? 'fresh' : 'stale';
  return { status, answerQualityDate };
}

async function main() {
  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  const runsPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-runs\.json$/);
  const scorecardPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-scorecard\.json$/);
  const backfillPath = findLatestDatedFile(resultsDir, /^\d{4}-\d{2}-\d{2}-arm-b-backfill\.json$/);
  console.log(`Using runs: ${runsPath.replace(REPO_ROOT + '/', '')}`);
  console.log(`Using scorecard: ${scorecardPath.replace(REPO_ROOT + '/', '')}`);
  console.log(`Using backfill report: ${backfillPath.replace(REPO_ROOT + '/', '')}`);

  const runsFile = JSON.parse(readFileSync(runsPath, 'utf8')) as { results: RunResult[] };
  const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8')) as Scorecard;
  const backfillReport = JSON.parse(readFileSync(backfillPath, 'utf8')) as {
    notes_embedded: number;
    wall_clock_min: number;
    db_size_delta_gb: number;
  };
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));

  const bakeoff = buildBakeoff({ runsResults: runsFile.results, scorecard, judgments, backfillReport });

  const date = bakeoff.run.date;
  writeFileSync(join(resultsDir, `${date}-bakeoff.json`), JSON.stringify(bakeoff, null, 2));
  writeFileSync(join(resultsDir, `${date}-bakeoff.md`), renderBakeoffMarkdown(bakeoff));
  console.log(`Wrote eval/results/${date}-bakeoff.json and .md`);
  console.log(`Verdict: ${bakeoff.verdict.winner} (margin ${bakeoff.verdict.margin}, mixed: ${bakeoff.verdict.mixed})`);
}

if (process.argv[1]?.endsWith('build-bakeoff.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
