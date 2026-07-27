import { describe, it, expect } from 'vitest';
import { enrichConceptFromWeb } from '../../src/enrichment/web-enricher.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

describe('enrichConceptFromWeb', () => {
  it('propagates TransientLLMError instead of resolving null', async () => {
    const transientError = new TransientLLMError('VPN down');
    const llm: LLMClient = {
      async complete() {
        throw transientError;
      },
      async extractStructured<T>(): Promise<T> {
        throw new Error('not used in this test');
      },
    };

    let caught: unknown;
    let result: unknown;
    try {
      result = await enrichConceptFromWeb('Distributed Consensus', llm);
    } catch (err) {
      caught = err;
    }

    expect(result).toBeUndefined();
    expect(caught).toBe(transientError);
    expect(caught).toBeInstanceOf(TransientLLMError);
  });

  it('regression: returns null when the LLM call throws a plain Error', async () => {
    const llm: LLMClient = {
      async complete() {
        throw new Error('model unavailable');
      },
      async extractStructured<T>(): Promise<T> {
        throw new Error('not used in this test');
      },
    };

    const result = await enrichConceptFromWeb('Distributed Consensus', llm);

    expect(result).toBeNull();
  });
});
