import { describe, it, expect } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { buildVariants } from '../../eval/run/variants.js';

describe('buildVariants', () => {
  it('defines grep-first (keyword-only, no deps) and as-deployed (hybrid, ollama dep)', () => {
    // profiles are static (independent of config.embeddings.provider), so a
    // deterministic-provider config is enough to verify wiring without Ollama.
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/v', embeddings: { provider: 'deterministic' } });
    const variants = buildVariants(config, '/tmp/root', 10);
    const byName = Object.fromEntries(variants.map((v) => [v.name, v]));

    expect(Object.keys(byName).sort()).toEqual(['as-deployed', 'grep-first']);
    expect(byName['grep-first'].keywordOnly).toBe(true);
    expect(byName['grep-first'].profile.runtimeDeps).toEqual([]);
    expect(byName['as-deployed'].keywordOnly).toBe(false);
    expect(byName['as-deployed'].profile.runtimeDeps).toContain('ollama');
    expect(byName['grep-first'].topK).toBe(10);
    expect(typeof byName['grep-first'].openStore).toBe('function');
  });
});
