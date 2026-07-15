import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { buildVariants, VARIANT_PROFILES } from '../../eval/run/variants.js';

describe('buildVariants', () => {
  it('defines grep-first (keyword-only, no deps), as-deployed (hybrid, ollama dep), and full-cov-hybrid (hybrid, ollama dep, higher storage/jobs)', () => {
    // profiles are static (independent of config.embeddings.provider), so a
    // deterministic-provider config is enough to verify wiring without Ollama.
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/v', embeddings: { provider: 'deterministic' } });
    const variants = buildVariants(config, '/tmp/root', 10);
    const byName = Object.fromEntries(variants.map((v) => [v.name, v]));

    expect(Object.keys(byName).sort()).toEqual(['as-deployed', 'full-cov-hybrid', 'grep-first']);
    expect(byName['grep-first'].keywordOnly).toBe(true);
    expect(byName['grep-first'].profile.runtimeDeps).toEqual([]);
    expect(byName['as-deployed'].keywordOnly).toBe(false);
    expect(byName['as-deployed'].profile.runtimeDeps).toContain('ollama');
    expect(byName['full-cov-hybrid'].keywordOnly).toBe(false);
    expect(byName['full-cov-hybrid'].profile.runtimeDeps).toContain('ollama');
    expect(byName['full-cov-hybrid'].profile.storageGbBeyondFts).toBe(1.27);
    expect(byName['full-cov-hybrid'].profile.maintenanceJobs).toEqual(['embedding-index', 'embedding-sync']);
    expect(byName['grep-first'].topK).toBe(10);
    expect(typeof byName['grep-first'].openStore).toBe('function');
    expect(typeof byName['full-cov-hybrid'].openStore).toBe('function');
  });

  it('exports VARIANT_PROFILES as the single source of truth used by both the harness and the bake-off scorer', () => {
    expect(VARIANT_PROFILES['grep-first'].codeSurface).toBe('low');
    expect(VARIANT_PROFILES['full-cov-hybrid'].codeSurface).toBe('high');
  });
});
