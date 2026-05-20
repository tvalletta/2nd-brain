import { describe, it, expect } from 'vitest';
import { defaultStability, inferDomain, retrievability } from '../../src/vault/half-life.js';

describe('half-life', () => {
  describe('defaultStability', () => {
    it('returns AI research half-life for ai-research domain', () => {
      expect(defaultStability('ai-research')).toBe(90);
    });

    it('falls back to default for unknown domain', () => {
      expect(defaultStability('made-up')).toBe(60);
      expect(defaultStability(undefined)).toBe(60);
    });

    it('returns long half-life for people', () => {
      expect(defaultStability('people')).toBe(3650);
    });
  });

  describe('inferDomain', () => {
    it('maps note types to domains', () => {
      expect(inferDomain('concept')).toBe('concept');
      expect(inferDomain('decision')).toBe('decision');
      expect(inferDomain('entity')).toBe('people');
      expect(inferDomain('tool')).toBe('tech-stack');
      expect(inferDomain('session_summary')).toBe('session');
    });

    it('falls back to default for unknown types', () => {
      expect(inferDomain('whatever')).toBe('default');
    });
  });

  describe('retrievability', () => {
    const now = Date.parse('2026-05-06T00:00:00Z');

    it('returns 1 when verified just now', () => {
      const r = retrievability({
        lastVerifiedISO: '2026-05-06T00:00:00Z',
        stabilityDays: 30,
        nowMs: now,
      });
      expect(r).toBeCloseTo(1, 5);
    });

    it('returns ~0.5 at one stability period', () => {
      // R = exp(-1) ≈ 0.3679 at Δt=S; 0.5 at Δt = S * ln(2) ≈ 0.693·S
      const stability = 30;
      const lastVerified = new Date(now - stability * Math.LN2 * 86400_000).toISOString();
      const r = retrievability({ lastVerifiedISO: lastVerified, stabilityDays: stability, nowMs: now });
      expect(r).toBeCloseTo(0.5, 2);
    });

    it('returns 0 when last_verified is missing', () => {
      expect(retrievability({ lastVerifiedISO: undefined, stabilityDays: 30, nowMs: now })).toBe(0);
    });

    it('clamps negative ages to 0', () => {
      // last_verified is in the future
      const future = new Date(now + 86400_000).toISOString();
      const r = retrievability({ lastVerifiedISO: future, stabilityDays: 30, nowMs: now });
      expect(r).toBeCloseTo(1, 5);
    });
  });
});
