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
