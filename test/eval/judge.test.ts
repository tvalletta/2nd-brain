import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgeItem, reconcileJudgments } from '../../eval/pool/judge.js';
import type { ItemPool } from '../../eval/pool/build-pool.js';

describe('judgeItem', () => {
  it('labels every pooled candidate and tags provenance as llm', async () => {
    const pool: ItemPool = {
      item_id: 'x-001',
      candidates: [
        { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
        { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
      ],
    };
    const fakeResults = [
      { doc_id: 'a.md', label: 2, reason: 'directly answers' },
      { doc_id: 'b.md', label: 0, reason: 'unrelated' },
    ];
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse(fakeResults) as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-001', query: 'q', intent: '' }, pool);
    expect(judgments).toHaveLength(2);
    expect(judgments.find((j) => j.doc_id === 'a.md')).toMatchObject({ item_id: 'x-001', label: 2, label_provenance: 'llm' });
    expect(judgments.find((j) => j.doc_id === 'b.md')).toMatchObject({ item_id: 'x-001', label: 0, label_provenance: 'llm' });
  });

  it('filters out any doc_id the LLM invents that is not in the pool', async () => {
    const pool: ItemPool = {
      item_id: 'x-001',
      candidates: [{ doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] }],
    };
    const fakeResults = [
      { doc_id: 'a.md', label: 2, reason: 'matches' },
      { doc_id: 'hallucinated.md', label: 1, reason: 'made up' },
    ];
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse(fakeResults) as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-001', query: 'q', intent: '' }, pool);
    expect(judgments).toHaveLength(1);
    expect(judgments[0].doc_id).toBe('a.md');
  });

  it('returns an empty array without calling the LLM when the pool has no candidates', async () => {
    let called = false;
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(): Promise<T> {
        called = true;
        return [] as unknown as T;
      },
    };
    const judgments = await judgeItem(llm, { id: 'x-002', query: 'q', intent: '' }, { item_id: 'x-002', candidates: [] });
    expect(judgments).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('reconcileJudgments', () => {
  const base = { item_id: 'x-001', reason: 'r' };

  it('averages labels that agree within 1 point and marks no disagreement', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 0, label_provenance: 'llm' as const }];
    const b = [{ ...base, doc_id: 'a.md', label: 1, label_provenance: 'llm' as const }];
    const result = reconcileJudgments(a, b);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 1, judge_a_label: 0, judge_b_label: 1, disagreement: false });
  });

  it('uses the lower label and flags disagreement when judges differ by 2+', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 0, label_provenance: 'llm' as const }];
    const b = [{ ...base, doc_id: 'a.md', label: 2, label_provenance: 'llm' as const }];
    const result = reconcileJudgments(a, b);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 0, judge_a_label: 0, judge_b_label: 2, disagreement: true });
  });

  it('falls back to judge A alone when judge B is missing a doc_id (never trust LLM output blindly)', () => {
    const a = [{ ...base, doc_id: 'a.md', label: 1, label_provenance: 'llm' as const }];
    const b: typeof a = [];
    const result = reconcileJudgments(a, b);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ doc_id: 'a.md', label: 1 });
    expect(result[0].judge_b_label).toBeUndefined();
  });
});
