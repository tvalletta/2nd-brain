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

  it('concatenates multiple retrieved docs for a single variant, in rank order, joined by a blank line, each wrapped in its own header', async () => {
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-004', query: 'Q', variantHits: {
        'full-cov-hybrid': { docIds: ['doc1.md', 'doc2.md'] },
      } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = {
      read: vi.fn(async (path: string) => (path === 'doc1.md' ? 'First doc content' : 'Second doc content')),
    };
    let capturedPrompt = '';
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return 'irrelevant';
      }),
      extractStructured: vi.fn(),
    };

    await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, 5000);

    const expectedContextBlock = '--- doc1.md ---\nFirst doc content\n\n--- doc2.md ---\nSecond doc content';
    expect(capturedPrompt).toContain(expectedContextBlock);
    // rank order: doc1's block must appear entirely before doc2's block
    expect(capturedPrompt.indexOf('First doc content')).toBeLessThan(capturedPrompt.indexOf('Second doc content'));
  });

  it('truncates a retrieved doc whose content exceeds docCharCap, appending the truncation marker and dropping content past the cap', async () => {
    const docCharCap = 20;
    const fullContent = 'x'.repeat(50);
    const items: DisagreementItem[] = [
      { itemId: 'fuzzy-005', query: 'Q', variantHits: {
        'grep-first': { docIds: ['long-doc.md'] },
      } },
    ];
    const fakeVault: Pick<VaultAdapter, 'read'> = {
      read: vi.fn(async () => fullContent),
    };
    let capturedPrompt = '';
    const fakeLLM: LLMClient = {
      complete: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return 'irrelevant';
      }),
      extractStructured: vi.fn(),
    };

    await generateAnswers(items, fakeVault as VaultAdapter, fakeLLM, docCharCap);

    const expectedTruncated = fullContent.slice(0, docCharCap);
    const expectedBlock = `--- long-doc.md ---\n${expectedTruncated}\n[...truncated...]`;
    expect(capturedPrompt).toContain(expectedBlock);
    expect(expectedTruncated).toHaveLength(docCharCap);
    // content past the cap must not appear anywhere in the prompt
    const remainder = fullContent.slice(docCharCap);
    expect(capturedPrompt.split(remainder).length - 1).toBe(0);
  });
});
