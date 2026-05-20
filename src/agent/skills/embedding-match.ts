// E1: Embedding-based skill matching.
//
// Replaces substring/keyword matching with cosine similarity between the
// candidate content and the skill's description + patterns. Falls back to the
// existing `matchSkill` when no provider is available.

import type { SynthesisSkill, SkillMatch } from './types.js';
import { type EmbeddingProvider, cosineSimilarity } from '../../embeddings/provider.js';

const MIN_SIMILARITY = 0.3;

export async function matchSkillByEmbedding(
  content: string,
  skills: SynthesisSkill[],
  provider: EmbeddingProvider,
): Promise<SkillMatch | null> {
  if (skills.length === 0 || !content.trim()) return null;

  const skillTexts = skills.map((s) => `${s.name}\n${s.description}\n${s.patterns.join(' ')}`);
  const inputs = [content, ...skillTexts];
  const vectors = await provider.embed(inputs);
  const queryVec = vectors[0];

  let best: SkillMatch | null = null;
  for (let i = 0; i < skills.length; i++) {
    const sim = cosineSimilarity(queryVec, vectors[i + 1]);
    if (sim < MIN_SIMILARITY) continue;
    if (!best || sim > best.score) {
      // Reuse the existing SkillMatch shape; matchCount stays 0 here since
      // we're not counting patterns — score is the embedding similarity.
      best = { skill: skills[i], matchCount: 0, score: sim };
    }
  }
  return best;
}
