import { describe, it, expect, vi } from 'vitest';
import { judgeAnswerQuality } from '../../eval/report/judge-answer-quality.js';
import type { AnswerSet } from '../../eval/report/generate-answers.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

describe('judgeAnswerQuality', () => {
  it('blinds the variant identity from the judge prompt, then un-blinds only at the result mapping step', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'fuzzy-002', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'Answer one.', retrievedDocIds: ['docA.md'] },
        { variant: 'full-cov-hybrid', answer: 'Answer two.', retrievedDocIds: ['docB.md'] },
      ] },
    ];
    let capturedPrompt = '';
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { verdict: 'A', reason: 'More complete.' };
      }),
    };

    const result = await judgeAnswerQuality(answerSets, fakeLLM, 42);

    expect(capturedPrompt).not.toMatch(/grep-first|full-cov-hybrid/);
    expect(result).toHaveLength(1);
    expect(result[0].comparisons).toHaveLength(1);
    const comparison = result[0].comparisons[0];
    expect(['grep-first', 'full-cov-hybrid']).toContain(comparison.winner);
    expect(comparison.reason).toBe('More complete.');
  });

  it('is reproducible given the same seed — same A/B assignment across two runs', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'fuzzy-002', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'Answer one.', retrievedDocIds: [] },
        { variant: 'as-deployed', answer: 'Answer two.', retrievedDocIds: [] },
      ] },
    ];
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async () => ({ verdict: 'tie', reason: 'Equivalent.' })),
    };

    const run1 = await judgeAnswerQuality(answerSets, fakeLLM, 7);
    const run2 = await judgeAnswerQuality(answerSets, fakeLLM, 7);
    expect(run1[0].comparisons[0].variantA).toBe(run2[0].comparisons[0].variantA);
  });

  it('generates one comparison per pair for a 3-variant item (N choose 2 = 3)', async () => {
    const answerSets: AnswerSet[] = [
      { itemId: 'relationship-005', query: 'Q', answers: [
        { variant: 'grep-first', answer: 'A1', retrievedDocIds: [] },
        { variant: 'as-deployed', answer: 'A2', retrievedDocIds: [] },
        { variant: 'full-cov-hybrid', answer: 'A3', retrievedDocIds: [] },
      ] },
    ];
    const fakeLLM: LLMClient = {
      complete: vi.fn(),
      extractStructured: vi.fn(async () => ({ verdict: 'tie', reason: 'r' })),
    };
    const result = await judgeAnswerQuality(answerSets, fakeLLM, 1);
    expect(result[0].comparisons).toHaveLength(3);
  });
});
