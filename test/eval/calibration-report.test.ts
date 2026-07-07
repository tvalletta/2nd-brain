import { describe, it, expect } from 'vitest';
import { stratifiedSample, renderCalibrationReport } from '../../eval/pool/calibration-report.js';
import type { EvalItem } from '../../eval/dataset/types.js';
import type { Judgment } from '../../eval/pool/judge.js';

function makeItem(id: string, category: EvalItem['category'], subtype: EvalItem['subtype']): EvalItem {
  return {
    id,
    query: `query for ${id}`,
    category,
    subtype,
    source: 'log',
    source_ref: '',
    intent: `intent for ${id}`,
    is_regression: false,
    query_truncated: false,
    needs_review: false,
  };
}

describe('stratifiedSample', () => {
  it('round-robins across (category, subtype) groups so no single group dominates', () => {
    const items = [
      makeItem('d1', 'decisions', 'lookup'),
      makeItem('d2', 'decisions', 'lookup'),
      makeItem('e1', 'entities', 'relationship'),
      makeItem('e2', 'entities', 'relationship'),
      makeItem('h1', 'hot-topics', 'synthesis'),
      makeItem('h2', 'hot-topics', 'synthesis'),
    ];
    const sample = stratifiedSample(items, 3);
    expect(sample).toHaveLength(3);
    const groups = new Set(sample.map((it) => `${it.category}::${it.subtype}`));
    expect(groups.size).toBe(3); // one from each of the 3 groups, not 3 from one group
  });

  it('caps at the requested size even with more items available', () => {
    const items = [
      makeItem('d1', 'decisions', 'lookup'),
      makeItem('d2', 'decisions', 'lookup'),
      makeItem('d3', 'decisions', 'lookup'),
    ];
    expect(stratifiedSample(items, 2)).toHaveLength(2);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const items = [makeItem('d1', 'decisions', 'lookup'), makeItem('d2', 'decisions', 'lookup')];
    expect(stratifiedSample(items, 2).map((it) => it.id)).toEqual(stratifiedSample(items, 2).map((it) => it.id));
  });
});

describe('renderCalibrationReport', () => {
  it('includes the query, intent, and each judged candidate with a checkbox line', () => {
    const items = [makeItem('d1', 'decisions', 'lookup')];
    const judgmentsByItem = new Map<string, Judgment[]>([
      ['d1', [{ item_id: 'd1', doc_id: 'a.md', label: 2, reason: 'directly answers', label_provenance: 'llm' }]],
    ]);
    const report = renderCalibrationReport(items, judgmentsByItem);
    expect(report).toContain('d1');
    expect(report).toContain('query for d1');
    expect(report).toContain('intent for d1');
    expect(report).toContain('a.md');
    expect(report).toContain('label 2');
    expect(report).toContain('directly answers');
    expect(report).toContain("Tom's call");
  });

  it('notes when an item has no pooled candidates instead of a blank section', () => {
    const items = [makeItem('d1', 'decisions', 'lookup')];
    const report = renderCalibrationReport(items, new Map());
    expect(report).toContain('no pooled candidates');
  });
});
