import { describe, it, expect, vi } from 'vitest';
import { generateAnswers } from '../../eval/report/generate-answers.js';
import type { DisagreementItem } from '../../eval/report/answer-quality-sample.js';
import type { VaultAdapter } from '../../src/vault/adapter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

describe('generateAnswers', () => {
  it('builds a fixed prompt per variant using that variant\'s real retrieved doc content, and calls the LLM once per variant per item', async () => {
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-002', query: 'What was decided about X?', variantHits: {
        'grep-first': { docIds: ['docA.md'] },
        'full-cov-hybrid': { docIds: ['docB.md'] },
      } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = {
      read: vi.fn(async (path: string) => (path === 'docA.md' ? 'Content of A' : 'Content of B')),
    };
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => `Answer based on: ${prompt.includes('Content of A') ? 'A' : 'B'}`),
      extractStructured: vi.fn(),
    };

    const result = await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, 5000);

    expect(result).toHaveLength(1);
    expect(result[0].answers).toHaveLength(2);
    const grepAnswer = result[0].answers.find((a) => a.variant === 'grep-first')!;
    expect(grepAnswer.answer).toContain('A');
    const hybridAnswer = result[0].answers.find((a) => a.variant === 'full-cov-hybrid')!;
    expect(hybridAnswer.answer).toContain('B');
    expect(fakeLLM.complete).toHaveBeenCalledTimes(2);
  });

  it('generates a real "cannot answer" response for a variant with zero retrieved docs, rather than skipping it', async () => {
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-003', query: 'Q', variantHits: { 'grep-first': { docIds: [] }, 'full-cov-hybrid': { docIds: ['docC.md'] } } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = { read: vi.fn(async () => 'Content of C') };
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => (prompt.includes('(no documents retrieved)') ? "I don't know" : 'Real answer')),
      extractStructured: vi.fn(),
    };

    const result = await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, 5000);
    const grepAnswer = result[0].answers.find((a) => a.variant === 'grep-first')!;
    expect(grepAnswer.answer).toBe("I don't know");
  });
});
