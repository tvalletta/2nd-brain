import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createConnectivityProbe, withConnectivityProbe } from '../../src/enrichment/connectivity-probe.js';
import { createNoopClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

describe('connectivity probe', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-probe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not skip when no prior outcome is recorded', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('skips within the trust window after a recorded failure', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('litellm', false, 'boom');
    expect(probe.shouldSkip('litellm')).toBe(true);
  });

  it('does not skip once the trust window has elapsed', () => {
    mkdirSync(dir, { recursive: true });
    const staleTimestamp = new Date(Date.now() - 200_000).toISOString();
    writeFileSync(
      join(dir, 'connectivity-probe.json'),
      JSON.stringify({ litellm: { reachable: false, checkedAt: staleTimestamp, error: 'boom' } }),
    );
    const probe = createConnectivityProbe(dir, 120_000); // 2 min window, entry is ~3.3 min stale
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('a successful outcome clears a prior failure', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('litellm', false, 'boom');
    expect(probe.shouldSkip('litellm')).toBe(true);
    probe.recordOutcome('litellm', true);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('keeps providers isolated — a bedrock failure does not affect litellm', () => {
    const probe = createConnectivityProbe(dir, 120_000);
    probe.recordOutcome('bedrock', false, 'boom');
    expect(probe.shouldSkip('bedrock')).toBe(true);
    expect(probe.shouldSkip('litellm')).toBe(false);
  });

  it('withConnectivityProbe short-circuits with TransientLLMError when skip applies, without calling the wrapped client', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    let calls = 0;
    const inner = createNoopClient();
    const spyClient = {
      complete: async (...args: Parameters<typeof inner.complete>) => {
        calls++;
        return inner.complete(...args);
      },
      extractStructured: inner.extractStructured,
    };

    const wrapped = withConnectivityProbe(spyClient, 'litellm', config, dir);
    // First call fails for a non-transient reason isn't possible with noop's complete()
    // (it never throws), so seed the cache directly instead.
    const probe = createConnectivityProbe(dir, config.jobs.transientRetry.probeTrustWindowMs);
    probe.recordOutcome('litellm', false, 'boom');

    await expect(wrapped.complete('hi')).rejects.toBeInstanceOf(TransientLLMError);
    expect(calls).toBe(0);
  });

  it('withConnectivityProbe records a real success and clears the skip', async () => {
    // Seed an already-expired failure record directly (probeTrustWindowMs must be a
    // positive integer per the config schema, so we can't use 0 to force expiry —
    // instead we backdate checkedAt, same technique as the "trust window elapsed" test above).
    mkdirSync(dir, { recursive: true });
    const staleTimestamp = new Date(Date.now() - 200_000).toISOString();
    writeFileSync(
      join(dir, 'connectivity-probe.json'),
      JSON.stringify({ litellm: { reachable: false, checkedAt: staleTimestamp, error: 'boom' } }),
    );

    // A 120s trust window is well short of the ~200s-stale record above, so the wrapper
    // attempts for real instead of trusting the expired skip.
    const config2 = KarpathyConfigSchema.parse({ vaultPath: dir, jobs: { transientRetry: { probeTrustWindowMs: 120_000 } } });
    const wrapped = withConnectivityProbe(createNoopClient(), 'litellm', config2, dir);
    await wrapped.complete('hi'); // noop client never throws

    const freshProbe = createConnectivityProbe(dir, 120_000);
    expect(freshProbe.shouldSkip('litellm')).toBe(false);
  });
});
