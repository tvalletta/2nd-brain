import { describe, it, expect } from 'vitest';
import { findConceptLinks } from '../../src/enrichment/concept-linker.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

describe('findConceptLinks', () => {
  it('returns success with an empty array when there are no known concepts', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new Error('should not be called'); },
    };
    const result = await findConceptLinks(llm, 'Page Title', 'Page body.', []);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toEqual([]);
  });

  it('returns non-transient error on a plain LLM failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new Error('LLM down'); },
    };
    const result = await findConceptLinks(llm, 'Page Title', 'Page body.', ['Concept A']);
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
    const result = await findConceptLinks(llm, 'Page Title', 'Page body.', ['Concept A']);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.transient).toBe(true);
  });
});
