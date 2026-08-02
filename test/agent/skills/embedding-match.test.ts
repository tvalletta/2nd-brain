import { describe, it, expect } from 'vitest';
import { matchSkillByEmbedding } from '../../../src/agent/skills/embedding-match.js';
import type { EmbeddingProvider } from '../../../src/embeddings/provider.js';
import type { SynthesisSkill } from '../../../src/agent/skills/types.js';

function makeSkill(overrides: Partial<SynthesisSkill> = {}): SynthesisSkill {
  return {
    id: 's1',
    type: 'synthesis_skill',
    name: 'Meeting notes',
    description: 'Handles meeting transcripts',
    patterns: ['meeting', 'agenda'],
    strategy: 'summarize decisions and action items',
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Records the length of every string handed to embed() so tests can assert
 * truncation happened before the provider was ever called. */
function makeRecordingProvider(): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'test-provider',
    dimensions: 4,
    calls,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push(...texts);
      // Return a fixed-but-distinguishable vector per input so cosine
      // similarity comparisons in the "keeps best match" test are stable.
      return texts.map((t) => {
        const v = new Float32Array(4);
        v[0] = t.length > 0 ? 1 : 0;
        v[1] = t.includes('Meeting') || t.includes('meeting') ? 1 : 0;
        return v;
      });
    },
  };
}

describe('matchSkillByEmbedding — truncation (Fix K)', () => {
  it('truncates oversized content to maxChunkChars before calling provider.embed', async () => {
    const provider = makeRecordingProvider();
    const skills = [makeSkill()];
    const oversizedContent = 'x'.repeat(500);

    await matchSkillByEmbedding(oversizedContent, skills, provider, 50);

    // First call is always the query content.
    expect(provider.calls[0]).toHaveLength(50);
    expect(provider.calls[0]).toBe(oversizedContent.slice(0, 50));
  });

  it('truncates oversized skill text to maxChunkChars before calling provider.embed', async () => {
    const provider = makeRecordingProvider();
    const skills = [
      makeSkill({
        name: 'Long skill',
        description: 'd'.repeat(500),
        patterns: ['p'.repeat(500)],
      }),
    ];

    await matchSkillByEmbedding('short query content', skills, provider, 50);

    // Second call onward are the skill texts.
    expect(provider.calls[1].length).toBeLessThanOrEqual(50);
  });

  it('does not truncate content at or under maxChunkChars', async () => {
    const provider = makeRecordingProvider();
    const skills = [makeSkill()];
    const content = 'a short piece of meeting content';

    await matchSkillByEmbedding(content, skills, provider, 2048);

    expect(provider.calls[0]).toBe(content);
  });

  it('defaults maxChunkChars to 2048 when the caller omits it', async () => {
    const provider = makeRecordingProvider();
    const skills = [makeSkill()];
    const oversized = 'y'.repeat(5000);

    await matchSkillByEmbedding(oversized, skills, provider);

    expect(provider.calls[0]).toHaveLength(2048);
  });

  it('still returns the best-matching skill above MIN_SIMILARITY after truncation', async () => {
    const provider = makeRecordingProvider();
    const meetingSkill = makeSkill({ id: 'meeting', name: 'Meeting notes' });
    const otherSkill = makeSkill({
      id: 'other',
      name: 'Other',
      description: 'unrelated',
      patterns: ['unrelated'],
    });

    const match = await matchSkillByEmbedding(
      'A meeting happened today with an agenda.'.repeat(200), // oversized on purpose
      [meetingSkill, otherSkill],
      provider,
      100,
    );

    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('meeting');
  });

  it('returns null for empty content or no skills, without calling embed', async () => {
    const provider = makeRecordingProvider();
    expect(await matchSkillByEmbedding('   ', [makeSkill()], provider)).toBeNull();
    expect(await matchSkillByEmbedding('some content', [], provider)).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});
