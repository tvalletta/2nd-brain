import { describe, it, expect } from 'vitest';
import { REFRESH_TARGETS, isPlaceholderContent } from '../../src/intelligence/refresh-targets.js';

describe('refresh-targets', () => {
  describe('isPlaceholderContent', () => {
    it('concept/topic: null, empty, and "(no current understanding yet)" are placeholders', () => {
      const target = REFRESH_TARGETS.concept;
      expect(isPlaceholderContent(target, null)).toBe(true);
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, '  ')).toBe(true);
      expect(isPlaceholderContent(target, '(no current understanding yet)')).toBe(true);
      expect(isPlaceholderContent(target, '(NO CURRENT UNDERSTANDING YET)')).toBe(true);
    });

    it('concept/topic: the character-floor boundary (39 chars thin, 40 chars not)', () => {
      const target = REFRESH_TARGETS.topic;
      expect(isPlaceholderContent(target, 'x'.repeat(39))).toBe(true);
      expect(isPlaceholderContent(target, 'x'.repeat(40))).toBe(false);
    });

    it('concept/topic: a substantial string is not a placeholder', () => {
      expect(isPlaceholderContent(REFRESH_TARGETS.concept, 'A'.repeat(41))).toBe(false);
    });

    it('decision: empty and "(pending)" are placeholders, a real outcome is not', () => {
      const target = REFRESH_TARGETS.decision;
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, '(pending)')).toBe(true);
      expect(isPlaceholderContent(target, '(Pending)')).toBe(true);
      expect(isPlaceholderContent(target, 'Approved and shipped.')).toBe(false);
    });

    it('decision: the character-floor boundary (9 chars thin, 10 chars not)', () => {
      const target = REFRESH_TARGETS.decision;
      expect(isPlaceholderContent(target, 'x'.repeat(9))).toBe(true);
      expect(isPlaceholderContent(target, 'x'.repeat(10))).toBe(false);
    });

    it('project: empty and "Pending enrichment." are placeholders, a real overview is not', () => {
      const target = REFRESH_TARGETS.project;
      expect(isPlaceholderContent(target, '')).toBe(true);
      expect(isPlaceholderContent(target, 'Pending enrichment.')).toBe(true);
      expect(isPlaceholderContent(target, 'PENDING ENRICHMENT.')).toBe(true);
      expect(isPlaceholderContent(target, 'A local-first knowledge system that captures sessions.')).toBe(false);
    });

    it('strips wikilink brackets before measuring length against the floor', () => {
      expect(isPlaceholderContent(REFRESH_TARGETS.project, '[[]]')).toBe(true);
    });
  });

  describe('buildPrompt', () => {
    it('concept/topic prompt includes the title, existing understanding, and evidence', () => {
      const prompt = REFRESH_TARGETS.concept.buildPrompt({
        title: 'Recency-aware RAG',
        existingPrimary: 'Old framing.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Recency-aware RAG');
      expect(prompt).toContain('Old framing.');
      expect(prompt).toContain('[1] evidence text');
      expect(prompt).toContain('"primary"');
    });

    it('decision prompt includes the recorded context, current outcome, and anti-fabrication instruction', () => {
      const prompt = REFRESH_TARGETS.decision.buildPrompt({
        title: 'Adopt LiteLLM proxy',
        existingPrimary: '',
        existingSecondary: 'Needed multi-provider fallback.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Adopt LiteLLM proxy');
      expect(prompt).toContain('Needed multi-provider fallback.');
      expect(prompt).toContain('(pending)');
      expect(prompt).toContain('never fabricate a resolution');
    });

    it('project prompt includes the current overview and honest-placeholder instruction', () => {
      const prompt = REFRESH_TARGETS.project.buildPrompt({
        title: 'Second Brain',
        existingPrimary: 'Pending enrichment.',
        evidenceBlock: '[1] evidence text',
      });
      expect(prompt).toContain('Second Brain');
      expect(prompt).toContain('Pending enrichment.');
      expect(prompt).toContain("never invent scope or status");
    });
  });

  describe('responseSchema', () => {
    it('concept/topic schema requires primary, defaults contradictions/new_sources', () => {
      const parsed = REFRESH_TARGETS.concept.responseSchema.parse({ primary: 'text' });
      expect(parsed).toEqual({ primary: 'text', contradictions: [], new_sources: [] });
    });

    it('concept/topic schema rejects a response missing primary', () => {
      expect(() => REFRESH_TARGETS.topic.responseSchema.parse({ contradictions: [], new_sources: [] })).toThrow();
    });

    it('decision schema accepts an optional secondary field', () => {
      const parsed = REFRESH_TARGETS.decision.responseSchema.parse({
        primary: '(pending)', secondary: 'Sharpened context.', contradictions: [], new_sources: [],
      });
      expect(parsed.secondary).toBe('Sharpened context.');
    });

    it('project schema has no secondary field but still parses without one', () => {
      const parsed = REFRESH_TARGETS.project.responseSchema.parse({ primary: 'Overview text.' });
      expect(parsed.secondary).toBeUndefined();
    });
  });
});
