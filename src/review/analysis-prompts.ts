import { z } from 'zod';

export type ReviewAnalysisInput =
  | { kind: 'contradiction'; pageATitle: string; pageBTitle: string; claimA: string; claimB: string }
  | { kind: 'duplicate'; titleA: string; titleB: string; excerptA: string; excerptB: string; wordOverlapPercent: number }
  | {
      kind: 'ambiguous_entity';
      entityName: string;
      entityKind: string;
      sourceContext: string;
      candidates: Array<{ path: string; title: string; excerpt: string }>;
    }
  | {
      kind: 'uncertain_entity_drop';
      entityName: string;
      entityKind: string;
      entityContext: string;
      dropReason: string;
      gateConfidence: number;
    };

const ContradictionSchema = z.object({
  verdict: z.enum(['genuine_conflict', 'false_positive', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildContradictionPrompt(input: Extract<ReviewAnalysisInput, { kind: 'contradiction' }>): string {
  return `Two claims from a personal knowledge base were flagged as a potential contradiction by an automated heuristic (it just checks for shared subject words plus negation/date/number differences, so it produces many false positives). Judge whether these claims actually conflict.

Page A ("${input.pageATitle}"): "${input.claimA}"
Page B ("${input.pageBTitle}"): "${input.claimB}"

Decide: genuine_conflict, false_positive, or unclear. Explain in 2-3 sentences, referencing what's actually said. If there's a genuine conflict and a date makes it inferable, note which claim seems more current — the human reviewer makes the final call either way.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "genuine_conflict" | "false_positive" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const DuplicateSchema = z.object({
  verdict: z.enum(['same_entity', 'different_entities', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildDuplicatePrompt(input: Extract<ReviewAnalysisInput, { kind: 'duplicate' }>): string {
  return `Two wiki pages were flagged as possible duplicates by a heuristic (${input.wordOverlapPercent}% word overlap, plus bonuses for shared aliases/entity-kind/sources). Judge whether they describe the same real-world thing.

Page A ("${input.titleA}"): ${input.excerptA}

Page B ("${input.titleB}"): ${input.excerptB}

Decide: same_entity, different_entities, or unclear. If the same entity, say which page looks more complete/authoritative and should be kept as canonical. Explain in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "same_entity" | "different_entities" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const AmbiguousEntitySchema = z.object({
  verdict: z.enum(['match', 'no_match', 'unclear']),
  matchedPath: z.string().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildAmbiguousEntityPrompt(input: Extract<ReviewAnalysisInput, { kind: 'ambiguous_entity' }>): string {
  const candidateBlock = input.candidates
    .map((c, i) => `[${i + 1}] ${c.title} (${c.path}): ${c.excerpt}`)
    .join('\n');
  return `While processing a new mention, the entity "${input.entityName}" (${input.entityKind}) matched multiple existing pages ambiguously.

Context where it was mentioned: ${input.sourceContext}

Candidates:
${candidateBlock}

Decide: does this mention clearly match ONE of these candidates (name its exact path in matchedPath), do none of them match (no_match), or is it genuinely unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "match" | "no_match" | "unclear", "matchedPath": "<exact path from the list, only if verdict=match>", "reasoning": "...", "confidence": 0.0-1.0}`;
}

const UncertainEntityDropSchema = z.object({
  verdict: z.enum(['keep', 'drop', 'unclear']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildUncertainEntityDropPrompt(input: Extract<ReviewAnalysisInput, { kind: 'uncertain_entity_drop' }>): string {
  return `An automated significance gate suggested dropping the newly-extracted entity "${input.entityName}" (${input.entityKind}) as likely noise, but wasn't confident enough (confidence ${input.gateConfidence.toFixed(2)}) to drop it outright — its page was created and flagged for review instead of being silently discarded.

Gate's stated reason: ${input.dropReason}
Context where the entity was mentioned: ${input.entityContext}

Judge independently: does this deserve to exist as its own wiki page (keep), is it genuinely low-signal noise (drop), or is it unclear? Explain your reasoning in 2-3 sentences.

Output ONLY a single fenced \`\`\`json block:
{"verdict": "keep" | "drop" | "unclear", "reasoning": "...", "confidence": 0.0-1.0}`;
}

export const PROMPTS = {
  contradiction: { buildPrompt: buildContradictionPrompt, responseSchema: ContradictionSchema },
  duplicate: { buildPrompt: buildDuplicatePrompt, responseSchema: DuplicateSchema },
  ambiguous_entity: { buildPrompt: buildAmbiguousEntityPrompt, responseSchema: AmbiguousEntitySchema },
  uncertain_entity_drop: { buildPrompt: buildUncertainEntityDropPrompt, responseSchema: UncertainEntityDropSchema },
} as const;
