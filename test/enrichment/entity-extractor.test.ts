import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractEntities, extractEntitiesFromChunks, mergeExtractedEntities } from '../../src/enrichment/entity-extractor.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { Chunk } from '../../src/ingest/chunker.js';

function createMockClient(response: string): LLMClient {
  return {
    async complete() {
      return response;
    },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch?.[1] ?? jsonMatch?.[0] ?? response;
      return schema.parse(JSON.parse(jsonStr));
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

const SAMPLE_ENTITIES_JSON = JSON.stringify({
  people: [{ name: 'Alice', role: 'Engineer', context: 'Works on backend' }],
  projects: [{ name: 'Phoenix', status: 'active', context: 'Migration project' }],
  concepts: [{ name: 'Microservices', definition: 'Distributed architecture pattern' }],
  decisions: [{ title: 'Use TypeScript', status: 'decided', date: '2025-03-01', context: 'For type safety' }],
  open_questions: [{ question: 'When to deploy?', context: 'Timeline unclear' }],
});

describe('extractEntities', () => {
  it('parses valid JSON response', async () => {
    const llm = createMockClient('```json\n' + SAMPLE_ENTITIES_JSON + '\n```');
    const result = await extractEntities(llm, 'Some text about Alice.');

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people).toHaveLength(1);
    expect(result.data.people[0].name).toBe('Alice');
    expect(result.data.projects).toHaveLength(1);
    expect(result.data.concepts).toHaveLength(1);
    expect(result.data.decisions).toHaveLength(1);
    expect(result.data.open_questions).toHaveLength(1);
  });

  it('returns empty entities for empty text', async () => {
    const llm = createMockClient('should not be called');
    const result = await extractEntities(llm, '');

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people).toHaveLength(0);
    expect(result.data.projects).toHaveLength(0);
  });

  it('returns error status on LLM failure', async () => {
    const llm: LLMClient = {
      async complete() { throw new Error('LLM down'); },
      async extractStructured() { throw new Error('LLM down'); },
    };
    const result = await extractEntities(llm, 'some text');

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toContain('LLM down');
  });

  it('includes default chunkRefs as empty arrays', async () => {
    const llm = createMockClient('```json\n' + SAMPLE_ENTITIES_JSON + '\n```');
    const result = await extractEntities(llm, 'text');

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people[0].chunkRefs).toEqual([]);
    expect(result.data.projects[0].chunkRefs).toEqual([]);
  });
});

describe('extractEntitiesFromChunks', () => {
  it('tags single chunk with chunk ref', async () => {
    const llm = createMockClient('```json\n' + SAMPLE_ENTITIES_JSON + '\n```');
    const chunks = [makeChunk('text', 0, 1, 'abc123')];

    const result = await extractEntitiesFromChunks(llm, chunks);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people[0].chunkRefs).toEqual(['abc123']);
    expect(result.data.projects[0].chunkRefs).toEqual(['abc123']);
  });

  it('merges entities from multiple chunks', async () => {
    let callIndex = 0;
    const responses = [
      JSON.stringify({
        people: [{ name: 'Alice', role: 'Engineer', context: 'Backend work' }],
        projects: [{ name: 'Phoenix' }],
        concepts: [],
        decisions: [],
        open_questions: [],
      }),
      JSON.stringify({
        people: [{ name: 'Alice', role: 'Lead Engineer', context: 'Architecture decisions and backend work' }],
        projects: [{ name: 'Phoenix', status: 'active' }],
        concepts: [{ name: 'REST API' }],
        decisions: [],
        open_questions: [],
      }),
    ];

    const llm: LLMClient = {
      async complete() {
        return '```json\n' + responses[callIndex++] + '\n```';
      },
      async extractStructured<T>(_prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
        const raw = responses[callIndex++];
        return schema.parse(JSON.parse(raw));
      },
    };

    const chunks = [
      makeChunk('First section about Alice', 0, 2, 'chunk-a'),
      makeChunk('Second section about Alice', 1, 2, 'chunk-b'),
    ];

    const result = await extractEntitiesFromChunks(llm, chunks);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    // Alice should be merged (deduplicated by name)
    expect(result.data.people).toHaveLength(1);
    expect(result.data.people[0].name).toBe('Alice');
    // Should keep the longer context
    expect(result.data.people[0].context).toBe('Architecture decisions and backend work');
    // Should merge chunk refs
    expect(result.data.people[0].chunkRefs).toContain('chunk-a');
    expect(result.data.people[0].chunkRefs).toContain('chunk-b');

    // Phoenix should be merged
    expect(result.data.projects).toHaveLength(1);
    expect(result.data.projects[0].status).toBe('active');

    // REST API only appears in chunk-b
    expect(result.data.concepts).toHaveLength(1);
    expect(result.data.concepts[0].chunkRefs).toEqual(['chunk-b']);
  });

  it('returns empty for no chunks', async () => {
    const llm = createMockClient('should not be called');
    const result = await extractEntitiesFromChunks(llm, []);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.people).toHaveLength(0);
  });
});

describe('mergeExtractedEntities', () => {
  it('deduplicates people by name (case-insensitive)', () => {
    const result = mergeExtractedEntities([
      {
        people: [{ name: 'Alice', role: 'Engineer', chunkRefs: ['c1'] }],
        projects: [], concepts: [], decisions: [], open_questions: [],
      },
      {
        people: [{ name: 'alice', role: 'Lead', chunkRefs: ['c2'] }],
        projects: [], concepts: [], decisions: [], open_questions: [],
      },
    ]);

    expect(result.people).toHaveLength(1);
    expect(result.people[0].chunkRefs).toEqual(['c1', 'c2']);
  });

  it('returns empty for empty input', () => {
    const result = mergeExtractedEntities([]);
    expect(result.people).toHaveLength(0);
  });

  it('returns single result unchanged', () => {
    const input = {
      people: [{ name: 'Bob', chunkRefs: ['c1'] }],
      projects: [], concepts: [], decisions: [], open_questions: [],
    };
    const result = mergeExtractedEntities([input]);
    expect(result.people).toEqual(input.people);
  });
});
