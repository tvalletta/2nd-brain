import { describe, it, expect } from 'vitest';
import { computeDisagreementSample } from '../../eval/report/answer-quality-sample.js';
import type { RunResult } from '../../eval/run/types.js';
import type { Judgment } from '../../eval/pool/judge.js';

function hit(path: string, rank: number): RunResult['returned'][number] {
  return { path, rank, final: 1 - rank * 0.1, excerpt: '' };
}

describe('computeDisagreementSample', () => {
  it('includes an item where variants retrieve different top-3 sets and ground truth has a relevant doc only some variants found', () => {
    const runsResults: RunResult[] = [
      { itemId: 'fuzzy-002', variant: 'grep-first', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'keyword-only', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
      { itemId: 'fuzzy-002', variant: 'as-deployed', query: 'q', returned: [hit('docB.md', 0)], searchMode: 'hybrid', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
    ];
    const judgments: Judgment[] = [
      { item_id: 'fuzzy-002', doc_id: 'docB.md', label: 2, reason: 'r', label_provenance: 'llm' },
    ];
    const result = computeDisagreementSample(runsResults, judgments, ['grep-first', 'as-deployed']);
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('fuzzy-002');
    expect(result[0].variantHits['grep-first'].docIds).toEqual(['docA.md']);
    expect(result[0].variantHits['as-deployed'].docIds).toEqual(['docB.md']);
  });

  it('excludes an item where all variants retrieve the identical top-3 set', () => {
    const runsResults: RunResult[] = [
      { itemId: 'plaud-001', variant: 'grep-first', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'keyword-only', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
      { itemId: 'plaud-001', variant: 'as-deployed', query: 'q', returned: [hit('docA.md', 0)], searchMode: 'hybrid', latencyMs: 10, responseChars: 0, responseTokensEst: 0 },
    ];
    const judgments: Judgment[] = [
      { item_id: 'plaud-001', doc_id: 'docA.md', label: 2, reason: 'r', label_provenance: 'llm' },
    ];
    const result = computeDisagreementSample(runsResults, judgments, ['grep-first', 'as-deployed']);
    expect(result).toHaveLength(0);
  });
});
