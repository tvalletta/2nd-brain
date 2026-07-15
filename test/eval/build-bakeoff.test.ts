import { describe, it, expect } from 'vitest';
import { buildBakeoff, renderBakeoffMarkdown } from '../../eval/score/build-bakeoff.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';
import type { Scorecard } from '../../eval/score/build-scorecard.js';

function judgment(item_id: string, doc_id: string, label: number): Judgment {
  return { item_id, doc_id, label, reason: '', label_provenance: 'llm' };
}

function runResult(itemId: string, variant: string, returned: RunResult['returned'], latencyMs: number, responseTokensEst: number): RunResult {
  return {
    itemId,
    variant,
    query: `query for ${itemId}`,
    returned,
    searchMode: 'hybrid',
    latencyMs,
    responseChars: responseTokensEst * 4,
    responseTokensEst,
  };
}

describe('buildBakeoff', () => {
  const judgments = [
    judgment('decisions-001', 'a.md', 2),
    judgment('decisions-002', 'b.md', 2),
  ];

  // grep-first: perfect recall, slower and more tokens.
  // full-cov-hybrid: perfect recall, faster and fewer tokens.
  const runsResults: RunResult[] = [
    runResult('decisions-001', 'grep-first', [{ path: 'a.md', rank: 0, final: 1, excerpt: '' }], 200, 2000),
    runResult('decisions-002', 'grep-first', [{ path: 'b.md', rank: 0, final: 1, excerpt: '' }], 220, 2100),
    runResult('decisions-001', 'full-cov-hybrid', [{ path: 'a.md', rank: 0, final: 1, excerpt: '' }], 100, 1000),
    runResult('decisions-002', 'full-cov-hybrid', [{ path: 'b.md', rank: 0, final: 1, excerpt: '' }], 110, 1050),
    runResult('decisions-001', 'as-deployed', [], 5, 10), // reference, deliberately the fastest/cheapest of all 3 — must NOT win normalization
    runResult('decisions-002', 'as-deployed', [], 5, 10),
  ];

  const scorecard: Scorecard = {
    run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 100, any_degraded_runs: false },
    by_category_variant: [
      {
        category: 'decisions',
        variant: 'grep-first',
        n_items: 2,
        cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
        latency_ms_median: 210,
        latency_ms_p95: 220,
        response_tokens_median: 2050,
      },
      {
        category: 'decisions',
        variant: 'full-cov-hybrid',
        n_items: 2,
        cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
        latency_ms_median: 105,
        latency_ms_p95: 110,
        response_tokens_median: 1025,
      },
    ],
    routing: {},
    coverage: {},
  };

  const backfillReport = { notes_embedded: 19638, wall_clock_min: 37.21, db_size_delta_gb: 1.3 };

  it('excludes as-deployed from latency/token normalization (the fastest/cheapest reference must not deflate the contenders)', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    // full-cov-hybrid is faster than grep-first among the two contenders -> its own latency sub should be 1.0 (it IS the best contender).
    expect(fullCov.latency.sub).toBeCloseTo(1.0);
    // grep-first's sub should reflect its ratio to full-cov-hybrid (~105/210), NOT to as-deployed's ~5ms.
    expect(grepFirst.latency.sub).toBeCloseTo(105 / 210, 1);
  });

  it('computes composite as 0.5*accuracy + 0.2*latency + 0.15*tokens + 0.15*simplicity', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const expected = 0.5 * grepFirst.accuracy.sub + 0.2 * grepFirst.latency.sub + 0.15 * grepFirst.tokens.sub + 0.15 * grepFirst.simplicity.sub;
    expect(grepFirst.composite).toBeCloseTo(expected);
  });

  it('gives grep-first a perfect simplicity sub-score (zero penalty) and full-cov-hybrid a zero simplicity sub-score (max penalty)', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    expect(grepFirst.simplicity.penalty).toBe(0);
    expect(grepFirst.simplicity.sub).toBeCloseTo(1.0);
    expect(fullCov.simplicity.sub).toBeCloseTo(0);
  });

  it('applies the <=0.03 margin tiebreak in favor of grep-first when the composite margin is small', () => {
    // Hand-verified against the formula: both arms have accSub=1.0 (perfect
    // recall/precision/mrr on both decisions items). grep-first latSub=0.5
    // (210ms vs the pooled-best 105ms), tokSub=0.5 (2050 vs best 1025),
    // simSub=1.0 (zero penalty) -> composite = 0.5*1 + 0.2*0.5 + 0.15*0.5 +
    // 0.15*1 = 0.825. full-cov-hybrid latSub=1.0, tokSub=1.0, simSub=0 (it's
    // the only arm with any penalty, so its own penalty == maxPenalty) ->
    // composite = 0.5*1 + 0.2*1 + 0.15*1 + 0.15*0 = 0.85. margin = 0.025,
    // which is <= 0.03 -> grep-first wins by the tiebreak despite having the
    // numerically lower raw composite.
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    expect(grepFirst.composite).toBeCloseTo(0.825);
    expect(fullCov.composite).toBeCloseTo(0.85);
    expect(bakeoff.verdict.margin).toBeCloseTo(0.025);
    expect(bakeoff.verdict.margin).toBeLessThanOrEqual(0.03);
    expect(bakeoff.verdict.winner).toBe('grep-first');
  });

  it('detects a mixed verdict when a category winner differs from the overall winner', () => {
    // Add a 3rd item (hot-topics-001) where full-cov-hybrid hits and
    // grep-first misses entirely -> full-cov-hybrid's OVERALL pooled
    // accuracy (3 items: 2 perfect ties + 1 decisive win) becomes clearly
    // higher than grep-first's, giving a wide (non-tie) composite margin
    // in full-cov-hybrid's favor: grep-first accSub = 0.6*(2/3) + 0.25*(2/2,
    // precision excludes the miss's null) + 0.15*(2/3) = 0.75; full-cov-hybrid
    // accSub = 1.0 (perfect on all 3). Pooled latency/tokens: grep-first
    // median [200,220,200]=200, full-cov-hybrid [100,110,100]=100 ->
    // grep latSub=0.5, full-cov latSub=1.0 (same shape for tokens). Overall
    // composite: grep-first = 0.5*0.75+0.2*0.5+0.15*0.5+0.15*1 = 0.7;
    // full-cov-hybrid = 0.5*1+0.2*1+0.15*1+0.15*0 = 0.85. margin=0.15 (not a
    // tie) -> full-cov-hybrid wins outright.
    //
    // The by_category scorecard fixture below is independently crafted (it
    // does not need to numerically match the runsResults above — this test
    // exercises only the mixed-detection logic) to make grep-first win the
    // 'decisions' category specifically by a wide margin, producing a
    // genuine mixed result: overall winner is full-cov-hybrid, but the
    // 'decisions' category's own winner is grep-first.
    const mixedRunsResults: RunResult[] = [
      ...runsResults,
      runResult('hot-topics-001', 'grep-first', [], 200, 2000),
      runResult('hot-topics-001', 'full-cov-hybrid', [{ path: 'c.md', rank: 0, final: 1, excerpt: '' }], 100, 1000),
      runResult('hot-topics-001', 'as-deployed', [], 5, 10),
    ];
    const mixedJudgments = [...judgments, judgment('hot-topics-001', 'c.md', 2)];
    const mixedScorecard: Scorecard = {
      ...scorecard,
      by_category_variant: [
        {
          category: 'decisions',
          variant: 'grep-first',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
          latency_ms_median: 50,
          latency_ms_p95: 60,
          response_tokens_median: 500,
        },
        {
          category: 'decisions',
          variant: 'full-cov-hybrid',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 0, ci: [0, 0] }, precision_at_k: { mean: 0, ci: [0, 0] }, mrr: { mean: 0, ci: [0, 0] }, median_first_rank: null }],
          latency_ms_median: 300,
          latency_ms_p95: 310,
          response_tokens_median: 3000,
        },
      ],
    };
    const bakeoff = buildBakeoff({
      runsResults: mixedRunsResults,
      scorecard: mixedScorecard,
      judgments: mixedJudgments,
      backfillReport,
    });
    expect(bakeoff.verdict.winner).toBe('full-cov-hybrid');
    expect(bakeoff.verdict.mixed).toBe(true);
  });

  it('normalizes by_category composites against a per-category best, not the arm-level pooled best, keeping them in a sane range', () => {
    // grep-first's entities-like category here has a much lower latency/token
    // median than its own arm-level pooled figures (mirroring the real bug:
    // entities latency_ms_median 0.68 vs arm-pooled bestLatency 31.19).
    const fastCategoryScorecard: Scorecard = {
      ...scorecard,
      by_category_variant: [
        ...scorecard.by_category_variant,
        {
          category: 'entities',
          variant: 'grep-first',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
          latency_ms_median: 0.5,
          latency_ms_p95: 0.6,
          response_tokens_median: 20,
        },
        {
          category: 'entities',
          variant: 'full-cov-hybrid',
          n_items: 2,
          cells: [{ k: 10, relevance: 'e', scope: 'full-corpus', n: 2, recall_at_k: { mean: 1, ci: [1, 1] }, precision_at_k: { mean: 1, ci: [1, 1] }, mrr: { mean: 1, ci: [1, 1] }, median_first_rank: 1 }],
          latency_ms_median: 50,
          latency_ms_p95: 55,
          response_tokens_median: 500,
        },
      ],
    };
    const bakeoff = buildBakeoff({ runsResults, scorecard: fastCategoryScorecard, judgments, backfillReport });
    const grepFirst = bakeoff.arms.find((a) => a.name === 'grep-first')!;
    const fullCov = bakeoff.arms.find((a) => a.name === 'full-cov-hybrid')!;
    // grep-first's entities latency/tokens are the per-category best (lower
    // than full-cov-hybrid's), so its own sub-scores for that category are
    // exactly 1.0, not inflated far past it by the arm-level pooled figures.
    expect(grepFirst.by_category.entities.composite).toBeLessThanOrEqual(1.0);
    expect(fullCov.by_category.entities.composite).toBeLessThanOrEqual(1.0);
    expect(grepFirst.by_category.entities.composite).toBeGreaterThan(0);
  });

  it('passes the backfill ledger through with the exact field names from spec §6.2', () => {
    const bakeoff = buildBakeoff({ runsResults, scorecard, judgments, backfillReport });
    expect(bakeoff.backfill_ledger).toEqual({ notes_embedded: 19638, wall_clock_min: 37.21, db_size_delta_gb: 1.3 });
  });
});

describe('renderBakeoffMarkdown', () => {
  it('includes the winner, margin, and a composite table row per arm', () => {
    const bakeoff = buildBakeoff({
      runsResults: [
        { itemId: 'x', variant: 'grep-first', query: 'q', returned: [], searchMode: 'keyword-only', latencyMs: 100, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'full-cov-hybrid', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 50, responseChars: 40, responseTokensEst: 10 },
        { itemId: 'x', variant: 'as-deployed', query: 'q', returned: [], searchMode: 'hybrid', latencyMs: 5, responseChars: 40, responseTokensEst: 10 },
      ],
      scorecard: {
        run: { date: '2026-07-15', generated_at: 'x', db_doc_count: 1, any_degraded_runs: false },
        by_category_variant: [],
        routing: {},
        coverage: {},
      },
      judgments: [],
      backfillReport: { notes_embedded: 1, wall_clock_min: 1, db_size_delta_gb: 1 },
    });
    const md = renderBakeoffMarkdown(bakeoff);
    expect(md).toContain(bakeoff.verdict.winner);
    expect(md).toContain('grep-first');
    expect(md).toContain('full-cov-hybrid');
    expect(md).toContain('| Arm | Accuracy | Latency | Tokens | Simplicity | Composite |');
  });
});
