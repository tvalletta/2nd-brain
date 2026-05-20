import { describe, it, expect } from 'vitest';
import { summarizeSource, summarizeChunks } from '../../src/enrichment/summarizer.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { Chunk } from '../../src/ingest/chunker.js';

function createMockClient(response: string): LLMClient {
  return {
    async complete() {
      return response;
    },
    async extractStructured() {
      throw new Error('not implemented');
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
    headingContext: '',
    charOffset: 0,
    charLength: content.length,
  };
}

describe('summarizeSource', () => {
  it('returns the LLM response trimmed', async () => {
    const llm = createMockClient('  This is a summary.  ');
    const result = await summarizeSource(llm, 'Test Doc', 'Some content here.');
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('This is a summary.');
  });

  it('returns fallback for empty text', async () => {
    const llm = createMockClient('should not be called');
    const result = await summarizeSource(llm, 'Test', '');
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('No content to summarize.');
  });

  it('returns error status on LLM failure', async () => {
    const llm: LLMClient = {
      async complete() { throw new Error('LLM down'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const result = await summarizeSource(llm, 'Test', 'content');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toContain('LLM down');
  });
});

describe('summarizeChunks', () => {
  it('delegates to summarizeSource for single chunk', async () => {
    const llm = createMockClient('Single chunk summary.');
    const chunks = [makeChunk('Content here.', 0, 1)];
    const result = await summarizeChunks(llm, 'Test', chunks);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('Single chunk summary.');
  });

  it('calls LLM multiple times for multi-chunk then synthesizes', async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async complete() {
        callCount++;
        if (callCount <= 2) return `Summary of chunk ${callCount}.`;
        return 'Synthesized summary.';
      },
      async extractStructured() { throw new Error('not implemented'); },
    };

    const chunks = [
      makeChunk('First section.', 0, 2),
      makeChunk('Second section.', 1, 2),
    ];
    const result = await summarizeChunks(llm, 'Test', chunks);

    // 2 chunk summaries + 1 synthesis = 3 calls
    expect(callCount).toBe(3);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('Synthesized summary.');
  });

  it('returns fallback for empty chunks', async () => {
    const llm = createMockClient('should not be called');
    const result = await summarizeChunks(llm, 'Test', []);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('No content to summarize.');
  });
});
