import type { VaultAdapter } from '../../src/vault/adapter.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { DisagreementItem } from './answer-quality-sample.js';

export interface AnswerSet {
  itemId: string;
  query: string;
  answers: Array<{ variant: string; answer: string; retrievedDocIds: string[] }>;
}

const ANSWER_PROMPT_TEMPLATE = (query: string, contextBlock: string) => `You are answering a question using only the provided context. Do not use any knowledge beyond what's given below — if the context doesn't contain enough information to answer, say so explicitly rather than guessing.

Question: ${query}

Context (retrieved notes, in ranked order):
${contextBlock}

Answer:`;

/** Generates one real answer per (item, contending variant) pair, using a
 * FIXED prompt template and the SAME LLM for every generation — the only
 * variable across a given item's answers is which variant's retrieved
 * documents got substituted into the context block. This isolates
 * retrieval as the sole independent variable (spec:
 * downstream-answer-quality-check-design.md §4.1). `docCharCap` truncates
 * each retrieved doc's content to avoid one long document crowding out
 * the rest of a variant's context window unfairly relative to a variant
 * that retrieved several shorter docs. */
export async function generateAnswers(
  items: DisagreementItem[],
  vault: Pick<VaultAdapter, 'read'>,
  llm: LLMClient,
  docCharCap: number,
): Promise<AnswerSet[]> {
  const results: AnswerSet[] = [];

  for (const item of items) {
    const answers: AnswerSet['answers'] = [];
    for (const [variant, hits] of Object.entries(item.variantHits)) {
      let contextBlock: string;
      if (hits.docIds.length === 0) {
        contextBlock = '(no documents retrieved)';
      } else {
        const docTexts = await Promise.all(
          hits.docIds.map(async (docId) => {
            const raw = await vault.read(docId);
            const truncated = raw.length > docCharCap ? raw.slice(0, docCharCap) + '\n[...truncated...]' : raw;
            return `--- ${docId} ---\n${truncated}`;
          }),
        );
        contextBlock = docTexts.join('\n\n');
      }

      const prompt = ANSWER_PROMPT_TEMPLATE(item.query, contextBlock);
      const answer = await llm.complete(prompt);
      answers.push({ variant, answer, retrievedDocIds: hits.docIds });
    }
    results.push({ itemId: item.itemId, query: item.query, answers });
  }

  return results;
}
