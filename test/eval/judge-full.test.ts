import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgeItemFull } from '../../eval/pool/judge-full.js';
import type { ItemPool } from '../../eval/pool/build-pool.js';
import type { BehavioralEntry } from '../../eval/pool/build-pool.js';

function fakeJudge(response: unknown, calledFlag?: { called: boolean }): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      if (calledFlag) calledFlag.called = true;
      return schema.parse(response) as T;
    },
  };
}

describe('judgeItemFull', () => {
  const item = { id: 'x-001', query: 'what did we decide about x', intent: '' };
  const pool: ItemPool = {
    item_id: 'x-001',
    candidates: [
      { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
      { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
    ],
  };

  it('shortcuts behaviorally-confirmed candidates and dual-judges the rest', async () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const judgeA = fakeJudge([{ doc_id: 'b.md', label: 1, reason: 'a-reason' }]);
    const judgeB = fakeJudge([{ doc_id: 'b.md', label: 1, reason: 'b-reason' }]);
    const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);

    expect(judgments).toHaveLength(2);
    const behavioralJudgment = judgments.find((j) => j.doc_id === 'a.md');
    expect(behavioralJudgment).toMatchObject({ label: 2, label_provenance: 'behavioral' });
    const dualJudged = judgments.find((j) => j.doc_id === 'b.md');
    expect(dualJudged).toMatchObject({ label: 1, judge_a_label: 1, judge_b_label: 1, disagreement: false });
  });

  it('makes zero LLM calls when every candidate is behaviorally shortcut', async () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md', 'b.md'] },
    ];
    const flagA = { called: false };
    const flagB = { called: false };
    const judgeA = fakeJudge([], flagA);
    const judgeB = fakeJudge([], flagB);
    const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);

    expect(judgments).toHaveLength(2);
    expect(judgments.every((j) => j.label_provenance === 'behavioral')).toBe(true);
    expect(flagA.called).toBe(false);
    expect(flagB.called).toBe(false);
  });
});
