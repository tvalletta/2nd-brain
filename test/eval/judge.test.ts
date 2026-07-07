import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgeItem } from '../../eval/pool/judge.js';
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
