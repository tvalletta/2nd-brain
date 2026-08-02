// E1: Embedding-based skill matching.
//
// Replaces substring/keyword matching with cosine similarity between the
// candidate content and the skill's description + patterns. Falls back to the
// existing `matchSkill` when no provider is available.

import type { SynthesisSkill, SkillMatch } from './types.js';
import { type EmbeddingProvider, cosineSimilarity } from '../../embeddings/provider.js';

const MIN_SIMILARITY = 0.3;

// Fix K (resource-boundedness): matches `embeddings.maxChunkChars`'s default.
// Used when a caller doesn't thread the configured value through.
const DEFAULT_MAX_CHUNK_CHARS = 2048;

export async function matchSkillByEmbedding(
  content: string,
  skills: SynthesisSkill[],
  provider: EmbeddingProvider,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): Promise<SkillMatch | null> {
  if (skills.length === 0 || !content.trim()) return null;

  // Fix K: this call previously embedded `content` with zero chunking or
  // truncation — a large source document could exceed the embedding
  // provider's token cap and 500. Truncate both the query content and each
  // skill's text defensively before embedding.
  const truncate = (s: string) => (s.length > maxChunkChars ? s.slice(0, maxChunkChars) : s);

  const skillTexts = skills.map((s) =>
    truncate(`${s.name}\n${s.description}\n${s.patterns.join(' ')}`),
  );
  const inputs = [truncate(content), ...skillTexts];
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
