import { createLLMFromConfig } from '../enrichment/llm-factory.js';
import { createBudgetTrackerFromConfig, type BudgetTracker } from '../shared/budget.js';
import { resolveStateDir } from '../config/defaults.js';
import { TransientLLMError } from '../shared/errors.js';
import type { KarpathyConfig } from '../config/schema.js';
import { PROMPTS, type ReviewAnalysisInput } from './analysis-prompts.js';

export type { ReviewAnalysisInput } from './analysis-prompts.js';

export interface ReviewAnalysisResult {
  verdict: string;
  reasoning: string;
  confidence: number;
  matchedPath?: string;
  tier: 'fast' | 'medium' | 'placeholder';
}

// Common shape across all four PROMPTS[kind].responseSchema outputs (each is a
// narrower Zod object — different verdict enums, and only ambiguous_entity has
// matchedPath). Used to give extractStructured's generic a concrete type
// despite the heterogeneous indexed dispatch (see the `as never` casts below).
interface ParsedAnalysis {
  verdict: string;
  reasoning: string;
  confidence: number;
  matchedPath?: string;
}

const PLACEHOLDER_TEXT: Record<ReviewAnalysisInput['kind'], string> = {
  contradiction: 'Pending human review.',
  duplicate: 'Pending human review — LLM analysis unavailable.',
  ambiguous_entity: 'Multiple pages match this entity. Please review and resolve manually.',
  uncertain_entity_drop: 'Pending human review — LLM analysis unavailable.',
};

function placeholderResult(kind: ReviewAnalysisInput['kind']): ReviewAnalysisResult {
  return { verdict: 'unclear', reasoning: PLACEHOLDER_TEXT[kind], confidence: 0, tier: 'placeholder' };
}

export function bucketConfidence(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

export async function generateReviewAnalysis(
  config: KarpathyConfig,
  projectRoot: string,
  input: ReviewAnalysisInput,
  budgetOverride?: BudgetTracker,
): Promise<ReviewAnalysisResult> {
  if (!config.review.analysisEnabled) return placeholderResult(input.kind);

  const budget = budgetOverride ?? createBudgetTrackerFromConfig(config, projectRoot);
  const stateDir = resolveStateDir(config);
  const { buildPrompt, responseSchema } = PROMPTS[input.kind];
  const prompt = buildPrompt(input as never);
  const threshold = config.review.confidenceEscalationThreshold;

  let fastResult: ReviewAnalysisResult | null = null;

  if (await budget.tryReserve('fast')) {
    try {
      const fastClient = createLLMFromConfig(config, stateDir, 'fast');
      const parsed = await fastClient.extractStructured<ParsedAnalysis>(prompt, responseSchema as never);
      fastResult = { ...parsed, tier: 'fast' };
      if (parsed.confidence >= threshold) return fastResult;
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // non-transient (e.g. malformed JSON) — fall through to medium escalation
    }
  }

  if (await budget.tryReserve('medium')) {
    try {
      const mediumClient = createLLMFromConfig(config, stateDir, 'medium');
      const parsed = await mediumClient.extractStructured<ParsedAnalysis>(prompt, responseSchema as never);
      return { ...parsed, tier: 'medium' };
    } catch (err) {
      if (err instanceof TransientLLMError) throw err;
      // both tiers failed for real content/parsing reasons — fall through
    }
  }

  return fastResult ?? placeholderResult(input.kind);
}
