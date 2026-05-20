import { z } from 'zod';

/**
 * Schema for a synthesis skill stored in wiki/_system/skills/.
 * Skills are learnable processing patterns that tell the agent
 * how to handle specific types of conversations.
 */
export const SynthesisSkillSchema = z.object({
  id: z.string(),
  type: z.literal('synthesis_skill'),
  name: z.string(),
  description: z.string(),
  /** Keywords/phrases that trigger this skill */
  patterns: z.array(z.string()),
  /** Processing strategy injected into the agent system prompt */
  strategy: z.string(),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  review_state: z.enum(['unreviewed', 'reviewed', 'approved', 'rejected']).default('unreviewed'),
  usage_count: z.number().int().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});

export type SynthesisSkill = z.infer<typeof SynthesisSkillSchema>;

/**
 * Result of matching a skill to content.
 */
export interface SkillMatch {
  skill: SynthesisSkill;
  /** How many patterns matched */
  matchCount: number;
  /** Confidence score (0-1) based on pattern matches relative to total patterns */
  score: number;
}
