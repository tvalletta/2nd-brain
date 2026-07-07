import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { triageItems, type TriageProposal } from '../../eval/dataset/triage.js';
import type { EvalItem } from '../../eval/dataset/types.js';

function makeItem(id: string, query: string): EvalItem {
  return {
    id,
    query,
    category: 'decisions',
    subtype: 'lookup',
    source: 'log',
    source_ref: '',
    intent: '',
    is_regression: false,
    query_truncated: false,
    needs_review: true,
  };
}

function countingFakeLLM(responsePerCall: TriageProposal[]): { llm: LLMClient; callCount: () => number } {
  let calls = 0;
  const llm: LLMClient = {
    async complete() {
      return '';
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      calls += 1;
      return schema.parse(responsePerCall) as T;
    },
  };
  return { llm, callCount: () => calls };
}

const dummyProposal: TriageProposal = {
  id: 'a',
  proposed_category: 'decisions',
  proposed_subtype: 'lookup',
  drop: false,
  reason: 'r',
};

describe('triageItems', () => {
  it('chunks items and flattens results across multiple LLM calls', async () => {
    const items = [makeItem('a', 'q1'), makeItem('b', 'q2'), makeItem('c', 'q3')];
    const { llm, callCount } = countingFakeLLM([dummyProposal]);
    const proposals = await triageItems(llm, items, 2); // chunk size 2 -> batches of [2,1] -> 2 calls
    expect(callCount()).toBe(2);
    expect(proposals).toHaveLength(2); // 1 dummy proposal returned per call x 2 calls
  });

  it('propagates a rejection when the LLM call fails', async () => {
    const badLlm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured() {
        throw new Error('bad json');
      },
    };
    await expect(triageItems(badLlm, [makeItem('a', 'q1')], 25)).rejects.toThrow('bad json');
  });

  it('makes zero calls for an empty item list', async () => {
    const { llm, callCount } = countingFakeLLM([dummyProposal]);
    const proposals = await triageItems(llm, [], 25);
    expect(callCount()).toBe(0);
    expect(proposals).toEqual([]);
  });
});
