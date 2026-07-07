import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { judgePrompt, type JudgeCandidate } from './prompts.js';
import type { ItemPool } from './build-pool.js';

export interface Judgment {
  item_id: string;
  doc_id: string;
  label: number;
  reason: string;
  /** 'llm' means dual-judge reconciled (see reconcileJudgments) — a
   * deliberate semantic change from single-judge Phase 2, since single-judge
   * grading is retired for the full-pool run. 'behavioral' means confirmed
   * by real usage, never judged at all. */
  label_provenance: 'llm' | 'behavioral' | 'human' | 'llm+human';
  judge_a_label?: number;
  judge_b_label?: number;
  disagreement?: boolean;
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

/** Reconcile two independent judges' gradings of the same item's candidates.
 * Candidates within 1 point of each other average (rounded); candidates 2+
 * points apart use the lower (more conservative) label and are flagged
 * `disagreement: true` for the diagnostic log — never blocking, just
 * recorded. If judge B is missing a doc_id judge A returned (should not
 * normally happen, but never trust LLM output blindly), judge A's own
 * judgment passes through unchanged. */
export function reconcileJudgments(judgeA: Judgment[], judgeB: Judgment[]): Judgment[] {
  const byDocIdB = new Map(judgeB.map((j) => [j.doc_id, j]));
  const reconciled: Judgment[] = [];
  for (const a of judgeA) {
    const b = byDocIdB.get(a.doc_id);
    if (!b) {
      reconciled.push(a);
      continue;
    }
    const diff = Math.abs(a.label - b.label);
    const disagreement = diff >= 2;
    const label = disagreement ? Math.min(a.label, b.label) : Math.round((a.label + b.label) / 2);
    reconciled.push({
      item_id: a.item_id,
      doc_id: a.doc_id,
      label,
      reason: a.reason,
      label_provenance: 'llm',
      judge_a_label: a.label,
      judge_b_label: b.label,
      disagreement,
    });
  }
  return reconciled;
}
