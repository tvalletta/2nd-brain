import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { AnswerSet } from './generate-answers.js';

export interface AnswerQualityResult {
  item_id: string;
  query: string;
  answers: Array<{ variant: string; answer: string; retrieved_doc_ids: string[] }>;
  comparisons: Array<{
    variantA: string;
    variantB: string;
    winner: string | 'tie';
    reason: string;
  }>;
}

const JudgeVerdictSchema = z.object({
  verdict: z.enum(['A', 'B', 'tie']),
  reason: z.string(),
});

/** Deterministic PRNG matching this project's existing seeded-resampling
 * convention (eval/score/bootstrap.ts's mulberry32) — used here for
 * reproducible A/B position assignment, not resampling. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairwiseCombinations<T>(items: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

const JUDGE_PROMPT_TEMPLATE = (query: string, answerA: string, answerB: string) => `You are comparing two candidate answers to the same question, to judge which one is more helpful and accurate. You do not know which system produced which answer — judge only on the answers' merit.

Question: ${query}

Answer A:
${answerA}

Answer B:
${answerB}

Which answer is more helpful and accurate?

Return a JSON object: { "verdict": "A"|"B"|"tie", "reason": "<one or two sentences>" }.

Respond with only the JSON object, wrapped in \`\`\`json code fences. If your reason contains a double-quote character, escape it as \\" inside the "reason" string so the JSON stays valid.`;

/** Blind pairwise comparison of every 2-way combination of a multi-variant
 * answer set. `seed` makes the A/B position assignment reproducible for a
 * given input (spec: downstream-answer-quality-check-design.md §5.1). The
 * judge prompt (JUDGE_PROMPT_TEMPLATE) never includes a variant name —
 * un-blinding happens only when mapping the returned 'A'/'B' verdict back
 * to real variant names, after the LLM call returns. */
export async function judgeAnswerQuality(
  answerSets: AnswerSet[],
  llm: LLMClient,
  seed = 42,
): Promise<AnswerQualityResult[]> {
  const rand = mulberry32(seed);
  const results: AnswerQualityResult[] = [];

  for (const set of answerSets) {
    const pairs = pairwiseCombinations(set.answers);
    const comparisons: AnswerQualityResult['comparisons'] = [];

    for (const [first, second] of pairs) {
      const flip = rand() < 0.5;
      const positionA = flip ? second : first;
      const positionB = flip ? first : second;

      const prompt = JUDGE_PROMPT_TEMPLATE(set.query, positionA.answer, positionB.answer);
      const { verdict, reason } = await llm.extractStructured(prompt, JudgeVerdictSchema);

      const winner = verdict === 'tie' ? 'tie' : verdict === 'A' ? positionA.variant : positionB.variant;
      comparisons.push({ variantA: positionA.variant, variantB: positionB.variant, winner, reason });
    }

    results.push({
      item_id: set.itemId,
      query: set.query,
      answers: set.answers.map((a) => ({ variant: a.variant, answer: a.answer, retrieved_doc_ids: a.retrievedDocIds })),
      comparisons,
    });
  }

  return results;
}
