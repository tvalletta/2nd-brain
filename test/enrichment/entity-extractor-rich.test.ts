import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractEntitiesRich } from '../../src/enrichment/entity-extractor-rich.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

function makeLLM(response: unknown): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(response);
    },
  };
}

describe('extractEntitiesRich — action_items recovery', () => {
  it('preserves action_items from the raw LLM response instead of silently dropping them', async () => {
    const llm = makeLLM({
      people: [],
      projects: [],
      concepts: [],
      topics: [],
      decisions: [],
      tools: [],
      organizations: [],
      action_items: [
        { task: 'Investigate root cause of missing project enrichment', owner: 'tom', due_date: null, status: 'open', confidence: 0.8 },
      ],
      open_questions: [],
    });

    const result = await extractEntitiesRich(llm, 'Some text mentioning a to-do.');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.data.actionItems).toHaveLength(1);
    expect(result.data.actionItems[0].task).toBe('Investigate root cause of missing project enrichment');
    expect(result.data.actionItems[0].status).toBe('open');
  });

  it('defaults actionItems to an empty array when the LLM omits the field entirely', async () => {
    const llm = makeLLM({
      people: [], projects: [], concepts: [], topics: [], decisions: [], tools: [], organizations: [], open_questions: [],
    });
    const result = await extractEntitiesRich(llm, 'Text with nothing to extract.');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.data.actionItems).toEqual([]);
  });
});
