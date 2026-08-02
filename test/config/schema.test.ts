import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('KarpathyConfigSchema — jobs.transientRetry', () => {
  it('defaults jobs.transientRetry when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.jobs.transientRetry).toEqual({
      backoffCeilingMs: 1_800_000,
      alertAfterMs: 3_600_000,
      probeTrustWindowMs: 120_000,
      maxTransientRetries: 20,
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
    expect(config.jobs.transientRetry.maxTransientRetries).toBe(20);
  });

  it('allows overriding maxTransientRetries', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      jobs: { transientRetry: { maxTransientRetries: 5 } },
    });
    expect(config.jobs.transientRetry.maxTransientRetries).toBe(5);
  });
});

describe('KarpathyConfigSchema — jobs.maxActiveJobs (Fix H)', () => {
  it('defaults maxActiveJobs to 1000', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.jobs.maxActiveJobs).toBe(1000);
  });

  it('allows overriding maxActiveJobs', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      jobs: { maxActiveJobs: 50 },
    });
    expect(config.jobs.maxActiveJobs).toBe(50);
  });
});

describe('KarpathyConfigSchema — intelligence.decay.maxRefreshEnqueuePerRun (Fix G)', () => {
  it('defaults maxRefreshEnqueuePerRun to 25', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.decay.maxRefreshEnqueuePerRun).toBe(25);
  });

  it('allows overriding maxRefreshEnqueuePerRun', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { decay: { maxRefreshEnqueuePerRun: 5 } },
    });
    expect(config.intelligence.decay.maxRefreshEnqueuePerRun).toBe(5);
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

describe('KarpathyConfigSchema — enrichment.personResolution', () => {
  it('defaults enrichment.personResolution when omitted', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.enrichment.personResolution).toEqual({
      enabled: true,
      externalIdCaptureEnabled: true,
      nicknameMatchingEnabled: true,
      extraNicknameGroups: [],
    });
  });

  it('allows overriding enabled and supplying extraNicknameGroups', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      enrichment: {
        personResolution: { enabled: false, extraNicknameGroups: [['grig', 'grigor']] },
      },
    });
    expect(config.enrichment.personResolution.enabled).toBe(false);
    expect(config.enrichment.personResolution.extraNicknameGroups).toEqual([['grig', 'grigor']]);
    // Other fields still default
    expect(config.enrichment.personResolution.externalIdCaptureEnabled).toBe(true);
  });
});

describe('KarpathyConfigSchema — intelligence.lifecycle', () => {
  it('defaults intelligence.lifecycle when omitted, with staleDraftArchiveEnabled OFF', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.lifecycle).toEqual({
      enabled: true,
      staleDraftReportDays: 14,
      staleDraftArchiveEnabled: false,
      staleDraftArchiveDays: 30,
      archiveQueueEnabled: true,
    });
  });

  it('allows overriding staleDraftArchiveEnabled and staleDraftArchiveDays', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { lifecycle: { staleDraftArchiveEnabled: true, staleDraftArchiveDays: 45 } },
    });
    expect(config.intelligence.lifecycle.staleDraftArchiveEnabled).toBe(true);
    expect(config.intelligence.lifecycle.staleDraftArchiveDays).toBe(45);
    // Other fields still default.
    expect(config.intelligence.lifecycle.staleDraftReportDays).toBe(14);
    expect(config.intelligence.lifecycle.archiveQueueEnabled).toBe(true);
  });
});

describe('KarpathyConfigSchema — embeddings.maxChunkChars (Fix K)', () => {
  it('defaults maxChunkChars to 2048', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.embeddings.maxChunkChars).toBe(2048);
  });

  it('allows overriding maxChunkChars', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      embeddings: { maxChunkChars: 500 },
    });
    expect(config.embeddings.maxChunkChars).toBe(500);
  });
});

describe('KarpathyConfigSchema — search.ftsSyncBatchSize (Fix D)', () => {
  it('defaults ftsSyncBatchSize to 500', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.search.ftsSyncBatchSize).toBe(500);
  });

  it('allows overriding ftsSyncBatchSize', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      search: { ftsSyncBatchSize: 50 },
    });
    expect(config.search.ftsSyncBatchSize).toBe(50);
    // Other search fields still default.
    expect(config.search.semanticFallbackEnabled).toBe(false);
  });
});

describe('KarpathyConfigSchema — intelligence.research.autoDrainEnabled', () => {
  it('defaults autoDrainEnabled to false', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/vault' });
    expect(config.intelligence.research.autoDrainEnabled).toBe(false);
  });

  it('allows enabling it explicitly', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/vault',
      intelligence: { research: { autoDrainEnabled: true } },
    });
    expect(config.intelligence.research.autoDrainEnabled).toBe(true);
  });
});
