import { describe, it, expect } from 'vitest';
import { summarizeSource, summarizeChunks, summarizeMeetingSource, summarizeMeetingChunks } from '../../src/enrichment/summarizer.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { Chunk } from '../../src/ingest/chunker.js';
import { TransientLLMError } from '../../src/shared/errors.js';

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
    expect(result.transient).toBeFalsy();
  });

  it('flags transient: true when the LLM throws a TransientLLMError', async () => {
    const llm: LLMClient = {
      async complete() { throw new TransientLLMError('VPN down'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const result = await summarizeSource(llm, 'Test', 'content');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });
});

describe('summarizeMeetingSource', () => {
  it('returns the LLM response trimmed', async () => {
    const llm = createMockClient('  MEETING: standup  ');
    const result = await summarizeMeetingSource(llm, 'Standup', 'Some transcript.');
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('MEETING: standup');
  });

  it('returns error status (non-transient) on a plain LLM failure', async () => {
    const llm: LLMClient = {
      async complete() { throw new Error('bad request'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const result = await summarizeMeetingSource(llm, 'Standup', 'transcript');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBeFalsy();
  });

  it('flags transient: true when the LLM throws a TransientLLMError', async () => {
    const llm: LLMClient = {
      async complete() { throw new TransientLLMError('VPN down'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const result = await summarizeMeetingSource(llm, 'Standup', 'transcript');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
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

  it('flags transient: true when the final synthesis call throws a TransientLLMError', async () => {
    const llm: LLMClient = {
      async complete(prompt: string) {
        // Per-chunk calls succeed with a placeholder; only the final
        // synthesis call (after the resilient per-chunk loop) fails.
        if (/section \d+\/\d+/.test(prompt)) return 'chunk summary';
        throw new TransientLLMError('VPN down');
      },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const chunks = [
      makeChunk('First section.', 0, 2),
      makeChunk('Second section.', 1, 2),
    ];
    const result = await summarizeChunks(llm, 'Test', chunks);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });

  it('returns non-transient error when the final synthesis call throws a plain Error', async () => {
    const llm: LLMClient = {
      async complete(prompt: string) {
        if (/section \d+\/\d+/.test(prompt)) return 'chunk summary';
        throw new Error('synthesis exploded');
      },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const chunks = [
      makeChunk('First section.', 0, 2),
      makeChunk('Second section.', 1, 2),
    ];
    const result = await summarizeChunks(llm, 'Test', chunks);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBeFalsy();
  });
});

describe('summarizeMeetingChunks', () => {
  it('delegates to summarizeMeetingSource for a single chunk', async () => {
    const llm = createMockClient('MEETING: standup');
    const chunks = [makeChunk('Content here.', 0, 1)];
    const result = await summarizeMeetingChunks(llm, 'Standup', chunks);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('MEETING: standup');
  });

  it('returns fallback for empty chunks', async () => {
    const llm = createMockClient('should not be called');
    const result = await summarizeMeetingChunks(llm, 'Standup', []);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toBe('No content to summarize.');
  });

  it('flags transient: true when the final synthesis call throws a TransientLLMError', async () => {
    const llm: LLMClient = {
      async complete(prompt: string) {
        if (/section \d+\/\d+/.test(prompt)) return 'chunk brief';
        throw new TransientLLMError('VPN down');
      },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const chunks = [
      makeChunk('First section.', 0, 2),
      makeChunk('Second section.', 1, 2),
    ];
    const result = await summarizeMeetingChunks(llm, 'Standup', chunks);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });

  it('returns non-transient error when the final synthesis call throws a plain Error', async () => {
    const llm: LLMClient = {
      async complete(prompt: string) {
        if (/section \d+\/\d+/.test(prompt)) return 'chunk brief';
        throw new Error('synthesis exploded');
      },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const chunks = [
      makeChunk('First section.', 0, 2),
      makeChunk('Second section.', 1, 2),
    ];
    const result = await summarizeMeetingChunks(llm, 'Standup', chunks);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBeFalsy();
  });
});
