import { describe, it, expect } from 'vitest';
import { renderDisagreementReport } from '../../eval/pool/disagreement-report.js';
import type { Judgment } from '../../eval/pool/judge.js';

describe('renderDisagreementReport', () => {
  it('lists only disagreement items, grouped by item_id, with both judges\' labels', () => {
    const judgments: Judgment[] = [
      { item_id: 'x-001', doc_id: 'a.md', label: 0, reason: 'not relevant', label_provenance: 'llm', judge_a_label: 0, judge_b_label: 2, disagreement: true },
      { item_id: 'x-001', doc_id: 'b.md', label: 1, reason: 'supporting', label_provenance: 'llm', judge_a_label: 1, judge_b_label: 1, disagreement: false },
      { item_id: 'x-002', doc_id: 'c.md', label: 2, reason: 'confirmed', label_provenance: 'behavioral' },
    ];
    const report = renderDisagreementReport(judgments);
    expect(report).toContain('x-001');
    expect(report).toContain('a.md');
    expect(report).toContain('medium judge: 0');
    expect(report).toContain('heavy judge: 2');
    expect(report).not.toContain('b.md'); // agreement, should not appear
    expect(report).not.toContain('x-002'); // no disagreement field at all, should not appear
  });

  it('reports "no disagreements found" when none exist', () => {
    const judgments: Judgment[] = [
      { item_id: 'x-001', doc_id: 'a.md', label: 1, reason: 'r', label_provenance: 'llm', judge_a_label: 1, judge_b_label: 1, disagreement: false },
    ];
    expect(renderDisagreementReport(judgments)).toContain('No disagreements found');
  });
});
