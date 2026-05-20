// D4: Significance gate.
//
// Inputs: extracted candidate entity (name + kind + context) and the K
// most-similar existing entities. Output: keep / merge-into / drop.
//
// The gate is *advisory* — callers decide whether to enforce. We expose two
// modes:
//   - `heuristic` (no LLM, default): drops too-short or stop-word-only names,
//     drops near-duplicate matches above similarity 0.85, otherwise keeps.
//   - `llm`: defers to the LLM with a tightly-scoped prompt and a JSON schema.

import { z } from 'zod';
import type { LLMClient } from '../enrichment/llm-client.js';

export type EntityKind = 'person' | 'project' | 'concept' | 'tool' | 'organization' | 'topic' | 'decision';

export interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  context?: string;
}
export interface ExistingEntity {
  slug: string;
  name: string;
  kind: EntityKind;
  similarity: number;
}

export type GateDecision =
  | { action: 'keep' }
  | { action: 'merge'; intoSlug: string }
  | { action: 'drop'; reason: string };

const STOPWORDS = new Set([
  'thing', 'stuff', 'work', 'project', 'this', 'that',
  'them', 'they', 'something', 'someone', 'people', 'team',
]);
const MIN_NAME_CHARS = 3;
const NEAR_DUPLICATE_SIM = 0.85;

export function heuristicGate(
  extracted: ExtractedEntity,
  candidates: ExistingEntity[],
): GateDecision {
  const name = extracted.name.trim();
  if (name.length < MIN_NAME_CHARS) return { action: 'drop', reason: 'name too short' };
  if (STOPWORDS.has(name.toLowerCase())) return { action: 'drop', reason: 'generic stop-word' };

  const top = candidates[0];
  if (top && top.similarity >= NEAR_DUPLICATE_SIM && top.kind === extracted.kind) {
    return { action: 'merge', intoSlug: top.slug };
  }
  return { action: 'keep' };
}

const GateResultSchema = z.object({
  action: z.enum(['keep', 'merge', 'drop']),
  into_slug: z.string().nullable().optional(),
  reason: z.string().optional(),
});

export async function llmGate(
  llm: LLMClient,
  extracted: ExtractedEntity,
  candidates: ExistingEntity[],
): Promise<GateDecision> {
  // Always run the heuristic first to short-circuit obvious cases.
  const heuristic = heuristicGate(extracted, candidates);
  if (heuristic.action !== 'keep') return heuristic;
  if (candidates.length === 0) return heuristic;

  const candidatesBlock = candidates
    .slice(0, 5)
    .map((c, i) => `[${i + 1}] slug=${c.slug} name=${c.name} kind=${c.kind} sim=${c.similarity.toFixed(2)}`)
    .join('\n');
  const prompt = `Decide whether the extracted entity below deserves its own page in our knowledge base.

Extracted:
  name: ${extracted.name}
  kind: ${extracted.kind}
  context: ${extracted.context ?? '(none)'}

Existing similar entities:
${candidatesBlock}

Return JSON:
{
  "action": "keep" | "merge" | "drop",
  "into_slug": "<slug from above if action=merge>",
  "reason": "<brief why>"
}

Use "merge" when the extracted name is the same entity under a slightly different spelling (alias). Use "drop" when the name is generic, ambiguous, or low-signal. Use "keep" otherwise.

Output ONLY a single fenced \`\`\`json block.`;
  try {
    const result = await llm.extractStructured(prompt, GateResultSchema);
    if (result.action === 'merge' && result.into_slug) {
      return { action: 'merge', intoSlug: result.into_slug };
    }
    if (result.action === 'drop') {
      return { action: 'drop', reason: result.reason ?? 'LLM-judged low signal' };
    }
    return { action: 'keep' };
  } catch {
    // On LLM failure, fall back to keep — the legacy behaviour.
    return { action: 'keep' };
  }
}
