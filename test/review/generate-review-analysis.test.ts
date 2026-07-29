import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { TransientLLMError } from '../../src/shared/errors.js';

vi.mock('../../src/enrichment/llm-factory.js', () => ({
  createLLMFromConfig: vi.fn(),
}));

import { createLLMFromConfig } from '../../src/enrichment/llm-factory.js';
import { generateReviewAnalysis, bucketConfidence } from '../../src/review/generate-review-analysis.js';

function fakeClient(behavior: (prompt: string, schema: unknown) => unknown) {
  return {
    complete: async () => '',
    extractStructured: async (prompt: string, schema: unknown) => behavior(prompt, schema),
  };
}

const SAMPLE_INPUT = {
  kind: 'contradiction' as const,
  pageATitle: 'A', pageBTitle: 'B', claimA: 'claim a', claimB: 'claim b',
};

describe('bucketConfidence', () => {
  it('buckets at the documented cutoffs', () => {
    expect(bucketConfidence(0.95)).toBe('high');
    expect(bucketConfidence(0.7)).toBe('high');
    expect(bucketConfidence(0.69)).toBe('medium');
    expect(bucketConfidence(0.4)).toBe('medium');
    expect(bucketConfidence(0.39)).toBe('low');
    expect(bucketConfidence(0)).toBe('low');
  });
});

describe('generateReviewAnalysis', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-review-analysis-'));
    vi.clearAllMocks();
  });

  function config(overrides: Record<string, unknown> = {}) {
    return KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
  }

  it('returns the fast-tier result immediately when confidence is high enough', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) =>
      fakeClient(() => ({ verdict: 'genuine_conflict', reasoning: 'fast reasoning', confidence: 0.9 })) as never,
    );
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ verdict: 'genuine_conflict', reasoning: 'fast reasoning', tier: 'fast' });
    expect(createLLMFromConfig).toHaveBeenCalledTimes(1);
    expect(createLLMFromConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'fast');
  });

  it('escalates to medium when fast succeeds but confidence is below the threshold', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => ({ verdict: 'unclear', reasoning: 'fast unsure', confidence: 0.3 })) as never;
      return fakeClient(() => ({ verdict: 'false_positive', reasoning: 'medium reasoning', confidence: 0.85 })) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ verdict: 'false_positive', reasoning: 'medium reasoning', tier: 'medium' });
    expect(createLLMFromConfig).toHaveBeenCalledTimes(2);
  });

  it('escalates to medium when fast throws a non-transient error', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => { throw new Error('malformed JSON'); }) as never;
      return fakeClient(() => ({ verdict: 'unclear', reasoning: 'medium fallback', confidence: 0.6 })) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'medium', reasoning: 'medium fallback' });
  });

  it('rethrows a TransientLLMError from the fast tier without touching medium or the placeholder', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation(() =>
      fakeClient(() => { throw new TransientLLMError('outage'); }) as never,
    );
    await expect(generateReviewAnalysis(config(), dir, SAMPLE_INPUT)).rejects.toBeInstanceOf(TransientLLMError);
    expect(createLLMFromConfig).toHaveBeenCalledTimes(1); // medium never attempted
  });

  it('rethrows a TransientLLMError from the medium tier', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => { throw new Error('malformed JSON'); }) as never;
      return fakeClient(() => { throw new TransientLLMError('outage'); }) as never;
    });
    await expect(generateReviewAnalysis(config(), dir, SAMPLE_INPUT)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('falls back to the low-confidence fast result when medium also fails', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation((_c, _s, tier) => {
      if (tier === 'fast') return fakeClient(() => ({ verdict: 'unclear', reasoning: 'fast low-confidence', confidence: 0.2 })) as never;
      return fakeClient(() => { throw new Error('medium also broken'); }) as never;
    });
    const result = await generateReviewAnalysis(config(), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'fast', reasoning: 'fast low-confidence', confidence: 0.2 });
  });

  it('falls back to the placeholder when fast throws non-transiently and medium budget is exhausted', async () => {
    vi.mocked(createLLMFromConfig).mockImplementation(() =>
      fakeClient(() => { throw new Error('broken'); }) as never,
    );
    const result = await generateReviewAnalysis(
      config({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 10, medium: 0, heavy: 0 } } } }),
      dir,
      SAMPLE_INPUT,
    );
    expect(result).toMatchObject({ tier: 'placeholder', verdict: 'unclear' });
  });

  it('skips straight to the placeholder when the fast budget is pre-exhausted', async () => {
    const result = await generateReviewAnalysis(
      config({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 0, heavy: 0 } } } }),
      dir,
      SAMPLE_INPUT,
    );
    expect(result).toMatchObject({ tier: 'placeholder' });
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('returns the placeholder immediately when review.analysisEnabled is false, without constructing any client', async () => {
    const result = await generateReviewAnalysis(config({ review: { analysisEnabled: false } }), dir, SAMPLE_INPUT);
    expect(result).toMatchObject({ tier: 'placeholder' });
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });
});
