import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractEntitiesRich, extractEntitiesRichFromChunks } from '../../src/enrichment/entity-extractor-rich.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { Chunk } from '../../src/ingest/chunker.js';
import { TransientLLMError } from '../../src/shared/errors.js';

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

function makeChunk(content: string, index: number, total: number, chunkId?: string): Chunk {
  return {
    chunkId: chunkId ?? `chunk-${index}`,
    sourceHash: 'testhash',
    index,
    totalChunks: total,
    content,
    headingContext: index === 0 ? 'Introduction' : 'Details',
    charOffset: 0,
    charLength: content.length,
  };
}

const EMPTY_RICH_RESPONSE = {
  people: [], projects: [], concepts: [], topics: [], decisions: [], tools: [], organizations: [], open_questions: [],
};

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

describe('extractEntitiesRich — error handling', () => {
  it('returns non-transient error on a plain LLM failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new Error('LLM down'); },
    };
    const result = await extractEntitiesRich(llm, 'some text');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toContain('LLM down');
    expect(result.transient).toBeFalsy();
  });

  it('flags transient: true when the LLM throws a TransientLLMError', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new TransientLLMError('VPN down'); },
    };
    const result = await extractEntitiesRich(llm, 'some text');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });
});

describe('extractEntitiesRichFromChunks', () => {
  it('merges entities across chunks on success', async () => {
    const llm = makeLLM(EMPTY_RICH_RESPONSE);
    const chunks = [
      makeChunk('First section', 0, 2, 'chunk-a'),
      makeChunk('Second section', 1, 2, 'chunk-b'),
    ];
    const result = await extractEntitiesRichFromChunks(llm, chunks);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people).toEqual([]);
  });

  it('escalates to a transient error when one chunk fails with TransientLLMError, instead of a hollow success', async () => {
    let callIndex = 0;
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
        callIndex++;
        if (callIndex === 1) throw new TransientLLMError('VPN down');
        return schema.parse(EMPTY_RICH_RESPONSE);
      },
    };
    const chunks = [
      makeChunk('First section', 0, 2, 'chunk-a'),
      makeChunk('Second section', 1, 2, 'chunk-b'),
    ];
    const result = await extractEntitiesRichFromChunks(llm, chunks);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });

  it('falls back to placeholder-and-continue when a chunk fails with a non-transient error', async () => {
    let callIndex = 0;
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
        callIndex++;
        if (callIndex === 1) throw new Error('bad output from model');
        return schema.parse({
          ...EMPTY_RICH_RESPONSE,
          people: [{ name: 'Alice', chunkRefs: [] }],
        });
      },
    };
    const chunks = [
      makeChunk('First section', 0, 2, 'chunk-a'),
      makeChunk('Second section', 1, 2, 'chunk-b'),
    ];
    const result = await extractEntitiesRichFromChunks(llm, chunks);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people).toHaveLength(1);
    expect(result.data.people[0].chunkRefs).toEqual(['chunk-b']);
  });
});
