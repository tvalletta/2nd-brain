import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgePrompt, type JudgeCandidate } from './prompts.js';
import type { ItemPool } from './build-pool.js';

export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;
  reason: string;
  label_provenance: 'llm' | 'human' | 'llm+human';
}

const JudgeResultSchema = z.object({
  doc_id: z.string(),
  label: z.number().int().min(0).max(2),
  reason: z.string(),
});
const JudgeResponseSchema = z.array(JudgeResultSchema);

/** Grade every candidate in `pool` against `item` in one LLM call. Filters
 * out any doc_id the LLM returns that wasn't actually in the pool (a real
 * risk with LLM-generated structured output — never trust it blindly). */
export async function judgeItem(
  llm: LLMClient,
  item: { id: string; query: string; intent: string },
  pool: ItemPool,
): Promise<Judgment[]> {
  if (pool.candidates.length === 0) return [];

  const candidates: JudgeCandidate[] = pool.candidates.map((c) => ({
    doc_id: c.doc_id,
    title: c.title,
    excerpt: c.excerpt,
  }));
  const prompt = judgePrompt(item.query, item.intent, candidates);
  const results = await llm.extractStructured(prompt, JudgeResponseSchema);

  const knownIds = new Set(pool.candidates.map((c) => c.doc_id));
  return results
    .filter((r) => knownIds.has(r.doc_id))
    .map((r) => ({
      item_id: item.id,
      doc_id: r.doc_id,
      label: r.label,
      reason: r.reason,
      label_provenance: 'llm' as const,
    }));
}
