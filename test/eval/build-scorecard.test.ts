import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScorecard, findLatestRunsFile } from '../../eval/score/build-scorecard.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';
import type { EvalItem } from '../../eval/dataset/types.js';

function item(id: string, category: EvalItem['category']): EvalItem {
  return {
    id,
    query: `query for ${id}`,
    category,
    subtype: 'lookup',
    source: 'log',
    source_ref: 'x',
    intent: '',
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  };
}

function judgment(item_id: string, doc_id: string, label: number): Judgment {
  return { item_id, doc_id, label, reason: '', label_provenance: 'llm' };
}

function runResult(itemId: string, variant: string, returned: RunResult['returned'], overrides: Partial<RunResult> = {}): RunResult {
  return {
    itemId,
    variant,
    query: `query for ${itemId}`,
    returned,
    searchMode: 'hybrid',
    latencyMs: 100,
    responseChars: 500,
    responseTokensEst: 125,
    ...overrides,
  };
}

describe('buildScorecard', () => {
  const items = [item('decisions-001', 'decisions'), item('decisions-002', 'decisions')];
  const judgments = [
    judgment('decisions-001', 'Curated/wiki/a.md', 2),
    judgment('decisions-001', 'Curated/wiki/b.md', 1),
    judgment('decisions-002', 'Plaud/c.md', 2),
  ];
  const results: RunResult[] = [
    runResult('decisions-001', 'as-deployed', [
      { path: 'Curated/wiki/a.md', rank: 0, final: 0.9, excerpt: '' },
      { path: 'Curated/wiki/b.md', rank: 1, final: 0.5, excerpt: '' },
    ]),
    runResult('decisions-002', 'as-deployed', [
      { path: 'Plaud/c.md', rank: 0, final: 0.8, excerpt: '' },
    ]),
  ];
  const routingAnalysis = { routing: { overall_fast_pct: 10.3, overall: { correct: 19, total: 184 }, by_month: {} } };
  const coverageFunnel = { generated_at: 'x', totals: {}, funnel: [] };

  it('groups by (category, variant) and computes all 8 metric cells', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });

    expect(scorecard.by_category_variant).toHaveLength(1);
    const group = scorecard.by_category_variant[0];
    expect(group.category).toBe('decisions');
    expect(group.variant).toBe('as-deployed');
    expect(group.n_items).toBe(2);
    expect(group.cells).toHaveLength(8);
  });

  it('computes recall@10 against E (label>=1) correctly for the full-corpus scope', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus',
    )!;
    // decisions-001: E={a.md,b.md}, both returned -> recall 1.0
    // decisions-002: E={c.md}, returned -> recall 1.0
    expect(cell.recall_at_k.mean).toBeCloseTo(1.0);
  });

  it('computes recall@10 against E_primary (label==2 only) as a stricter subset', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e_primary' && c.scope === 'full-corpus',
    )!;
    // decisions-001: E_primary={a.md} only (b.md is label 1, excluded) -> recall 1.0 (a.md is returned)
    // decisions-002: E_primary={c.md} -> recall 1.0
    expect(cell.recall_at_k.mean).toBeCloseTo(1.0);
    expect(cell.n).toBe(2);
  });

  it('restricts to the 4 scope-matched prefixes for the scope-matched cell (Plaud/ is out of scope)', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'scope-matched',
    )!;
    // decisions-002's only relevant doc (Plaud/c.md) is out of scope -> its E becomes empty -> excluded (n=1, not 2)
    expect(cell.n).toBe(1);
  });

  it('treats a RunResult with .error as a total miss (recall 0), not a skip', () => {
    const erroredResults = [
      runResult('decisions-001', 'as-deployed', [], { error: 'search threw' }),
      runResult('decisions-002', 'as-deployed', [{ path: 'Plaud/c.md', rank: 0, final: 0.8, excerpt: '' }]),
    ];
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results: erroredResults },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    const cell = scorecard.by_category_variant[0].cells.find(
      (c) => c.k === 10 && c.relevance === 'e' && c.scope === 'full-corpus',
    )!;
    expect(cell.n).toBe(2); // both items counted (E non-empty for both) — decisions-001 scores 0
    expect(cell.recall_at_k.mean).toBeCloseTo(0.5); // (0 + 1) / 2
  });

  it('embeds routing and coverage verbatim without recomputing them', () => {
    const scorecard = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    expect(scorecard.routing).toEqual(routingAnalysis.routing);
    expect(scorecard.coverage).toEqual(coverageFunnel);
  });

  it('sets any_degraded_runs to true when indexChangedDuringRun is present, false when absent', () => {
    const degraded = buildScorecard({
      runsFile: {
        dbSnapshot: { docCount: 100, newestIndexedAt: 'x' },
        indexChangedDuringRun: {
          before: { docCount: 100, newestIndexedAt: '2026-01-01T00:00:00Z' },
          after: { docCount: 100, newestIndexedAt: '2026-01-01T01:00:00Z' },
        },
        results,
      },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    expect(degraded.run.any_degraded_runs).toBe(true);

    const notDegraded = buildScorecard({
      runsFile: { dbSnapshot: { docCount: 100, newestIndexedAt: 'x' }, results },
      judgments,
      items,
      routingAnalysis,
      coverageFunnel,
    });
    expect(notDegraded.run.any_degraded_runs).toBe(false);
  });
});

describe('findLatestRunsFile', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('picks the most recently dated <date>-runs.json file, ignoring other files', () => {
    dir = mkdtempSync(join(tmpdir(), 'runs-test-'));
    writeFileSync(join(dir, '2026-07-06-runs.json'), '{}');
    writeFileSync(join(dir, '2026-07-13-runs.json'), '{}');
    writeFileSync(join(dir, 'routing-analysis.json'), '{}');
    expect(findLatestRunsFile(dir)).toBe(join(dir, '2026-07-13-runs.json'));
  });

  it('throws a clear error when no runs.json file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'runs-test-'));
    writeFileSync(join(dir, 'coverage-funnel.json'), '{}');
    expect(() => findLatestRunsFile(dir)).toThrow(/No <date>-runs\.json file found/);
  });
});
