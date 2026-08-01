import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('KarpathyConfigSchema — jobs.transientRetry', () => {
  it('defaults jobs.transientRetry when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.jobs.transientRetry).toEqual({
      backoffCeilingMs: 1_800_000,
      alertAfterMs: 3_600_000,
      probeTrustWindowMs: 120_000,
    });
  });

  it('allows partial overrides, filling in the rest with defaults', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      jobs: { transientRetry: { alertAfterMs: 0 } },
    });
    expect(config.jobs.transientRetry.alertAfterMs).toBe(0);
    expect(config.jobs.transientRetry.backoffCeilingMs).toBe(1_800_000);
    expect(config.jobs.transientRetry.probeTrustWindowMs).toBe(120_000);
  });
});

describe('KarpathyConfigSchema — review', () => {
  it('defaults review section when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.review).toEqual({
      analysisEnabled: true,
      confidenceEscalationThreshold: 0.7,
    });
  });

  it('allows overriding analysisEnabled and confidenceEscalationThreshold', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      review: { analysisEnabled: false, confidenceEscalationThreshold: 0.5 },
    });
    expect(config.review.analysisEnabled).toBe(false);
    expect(config.review.confidenceEscalationThreshold).toBe(0.5);
  });
});

describe('KarpathyConfigSchema — intelligence.richness', () => {
  it('defaults intelligence.richness when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.richness).toEqual({
      enabled: true,
      glossarySynthesisThreshold: 3,
    });
  });

  it('allows overriding enabled and glossarySynthesisThreshold', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { richness: { enabled: false, glossarySynthesisThreshold: 5 } },
    });
    expect(config.intelligence.richness.enabled).toBe(false);
    expect(config.intelligence.richness.glossarySynthesisThreshold).toBe(5);
  });
});
