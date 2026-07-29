import { describe, it, expect } from 'vitest';
import { PROMPTS } from '../../src/review/analysis-prompts.js';

describe('analysis-prompts', () => {
  it('contradiction: prompt includes both claims and titles; schema accepts a valid response', () => {
    const input = {
      kind: 'contradiction' as const,
      pageATitle: 'Deadline A',
      pageBTitle: 'Deadline B',
      claimA: 'The deadline is March 1',
      claimB: 'The deadline is not March',
    };
    const prompt = PROMPTS.contradiction.buildPrompt(input);
    expect(prompt).toContain('Deadline A');
    expect(prompt).toContain('Deadline B');
    expect(prompt).toContain('The deadline is March 1');
    expect(prompt).toContain('The deadline is not March');

    const parsed = PROMPTS.contradiction.responseSchema.parse({
      verdict: 'genuine_conflict', reasoning: 'Both discuss the same deadline with incompatible dates.', confidence: 0.9,
    });
    expect(parsed.verdict).toBe('genuine_conflict');
  });

  it('contradiction: schema rejects an invalid verdict', () => {
    expect(() =>
      PROMPTS.contradiction.responseSchema.parse({ verdict: 'maybe', reasoning: 'x', confidence: 0.5 }),
    ).toThrow();
  });

  it('duplicate: prompt includes both titles, excerpts, and the overlap percentage', () => {
    const input = {
      kind: 'duplicate' as const,
      titleA: 'Alice', titleB: 'Alice Smith',
      excerptA: 'Alice is a senior engineer.', excerptB: 'Alice Smith leads the auth team.',
      wordOverlapPercent: 72,
    };
    const prompt = PROMPTS.duplicate.buildPrompt(input);
    expect(prompt).toContain('Alice Smith');
    expect(prompt).toContain('72%');
    expect(prompt).toContain('senior engineer');

    const parsed = PROMPTS.duplicate.responseSchema.parse({
      verdict: 'same_entity', reasoning: 'Same person, different name variants.', confidence: 0.8,
    });
    expect(parsed.verdict).toBe('same_entity');
  });

  it('ambiguous_entity: prompt lists every candidate with its path and excerpt', () => {
    const input = {
      kind: 'ambiguous_entity' as const,
      entityName: 'Alex', entityKind: 'person',
      sourceContext: 'Alex reviewed the PR.',
      candidates: [
        { path: 'wiki/entities/alex-chen.md', title: 'Alex Chen', excerpt: 'Backend engineer.' },
        { path: 'wiki/entities/alex-park.md', title: 'Alex Park', excerpt: 'Product manager.' },
      ],
    };
    const prompt = PROMPTS.ambiguous_entity.buildPrompt(input);
    expect(prompt).toContain('wiki/entities/alex-chen.md');
    expect(prompt).toContain('wiki/entities/alex-park.md');
    expect(prompt).toContain('Backend engineer.');

    const parsed = PROMPTS.ambiguous_entity.responseSchema.parse({
      verdict: 'match', matchedPath: 'wiki/entities/alex-chen.md', reasoning: 'PR review fits the backend engineer.', confidence: 0.75,
    });
    expect(parsed.matchedPath).toBe('wiki/entities/alex-chen.md');
  });

  it('ambiguous_entity: matchedPath is optional (verdict can be no_match/unclear without it)', () => {
    const parsed = PROMPTS.ambiguous_entity.responseSchema.parse({
      verdict: 'no_match', reasoning: 'Neither candidate fits.', confidence: 0.6,
    });
    expect(parsed.matchedPath).toBeUndefined();
  });

  it('uncertain_entity_drop: prompt includes the gate reason, confidence, and entity context', () => {
    const input = {
      kind: 'uncertain_entity_drop' as const,
      entityName: 'Zephyr Protocol', entityKind: 'concept',
      entityContext: 'Discussed as a new sync protocol.',
      dropReason: 'sounds like generic jargon', gateConfidence: 0.4,
    };
    const prompt = PROMPTS.uncertain_entity_drop.buildPrompt(input);
    expect(prompt).toContain('Zephyr Protocol');
    expect(prompt).toContain('sounds like generic jargon');
    expect(prompt).toContain('0.40');
    expect(prompt).toContain('sync protocol');

    const parsed = PROMPTS.uncertain_entity_drop.responseSchema.parse({
      verdict: 'keep', reasoning: 'It is a specific named protocol, not generic jargon.', confidence: 0.85,
    });
    expect(parsed.verdict).toBe('keep');
  });

  it('every schema rejects a confidence outside 0-1', () => {
    expect(() =>
      PROMPTS.contradiction.responseSchema.parse({ verdict: 'unclear', reasoning: 'x', confidence: 1.5 }),
    ).toThrow();
  });
});
