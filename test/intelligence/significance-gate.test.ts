import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { heuristicGate, llmGate } from '../../src/intelligence/significance-gate.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
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

describe('significance-gate', () => {
  describe('heuristicGate', () => {
    it('drops names shorter than 3 characters with no confidence field', () => {
      const decision = heuristicGate({ name: 'ai', kind: 'tool' }, []);
      expect(decision).toEqual({ action: 'drop', reason: 'name too short' });
    });

    it('keeps ordinary names when there is nothing similar to compare against', () => {
      const decision = heuristicGate({ name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'keep' });
    });
  });

  describe('llmGate', () => {
    it('actually calls the LLM even when candidates is empty', async () => {
      let called = false;
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
          called = true;
          return schema.parse({ action: 'keep' });
        },
      };
      await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(called).toBe(true);
    });

    it('propagates confidence through on a drop verdict', async () => {
      const llm = makeLLM({ action: 'drop', reason: 'generic jargon', confidence: 0.4 });
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'drop', reason: 'generic jargon', confidence: 0.4 });
    });

    it('leaves confidence undefined when the LLM response omits it', async () => {
      const llm = makeLLM({ action: 'drop', reason: 'generic jargon' });
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect((decision as { confidence?: number }).confidence).toBeUndefined();
    });

    it('short-circuits to the heuristic without calling the LLM for obvious drops', async () => {
      let called = false;
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
          called = true;
          return schema.parse({});
        },
      };
      const decision = await llmGate(llm, { name: 'ai', kind: 'tool' }, []);
      expect(called).toBe(false);
      expect(decision).toEqual({ action: 'drop', reason: 'name too short' });
    });

    it('falls back to keep when the LLM call throws', async () => {
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured() {
          throw new Error('LLM call failed');
        },
      };
      const decision = await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      expect(decision).toEqual({ action: 'keep' });
    });

    it('propagates TransientLLMError instead of falling back to keep', async () => {
      const transientError = new TransientLLMError('VPN down');
      const llm: LLMClient = {
        async complete() {
          return '';
        },
        async extractStructured() {
          throw transientError;
        },
      };

      let caught: unknown;
      try {
        await llmGate(llm, { name: 'Zephyr Protocol', kind: 'concept' }, []);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBe(transientError);
      expect(caught).toBeInstanceOf(TransientLLMError);
    });
  });
});
