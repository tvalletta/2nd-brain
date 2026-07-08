import { describe, it, expect, vi, afterEach } from 'vitest';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import { resolveTierModel, createLLMForTier } from '../../eval/pool/llm.js';

describe('resolveTierModel', () => {
  it('resolves the configured model id for a given tier', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { models: { medium: 'us.anthropic.claude-sonnet-4-6' } },
    });
    expect(resolveTierModel(config, 'medium')).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('resolves different tiers to their own configured models', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { models: { fast: 'fast-model', medium: 'medium-model', heavy: 'heavy-model' } },
    });
    expect(resolveTierModel(config, 'fast')).toBe('fast-model');
    expect(resolveTierModel(config, 'heavy')).toBe('heavy-model');
  });
});

describe('createLLMForTier', () => {
  it('constructs a usable LLMClient for the bedrock provider without making a network call', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { provider: 'bedrock', region: 'us-west-2', maxTokens: 4096, models: { medium: 'us.anthropic.claude-sonnet-4-6' } },
    });
    const client = createLLMForTier(config, 'medium');
    expect(typeof client.complete).toBe('function');
    expect(typeof client.extractStructured).toBe('function');
  });

  it('throws a clear error for litellm provider missing baseUrl/apiKey', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/v',
      llm: { provider: 'litellm', models: { medium: 'medium-model' } },
    });
    expect(() => createLLMForTier(config, 'medium')).toThrow('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
  });

  describe('maxTokensOverride (I13)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends config.llm.maxTokens when no override is given', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: 'ok' }] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const config = KarpathyConfigSchema.parse({
        vaultPath: '/tmp/v',
        llm: { provider: 'bedrock', region: 'us-west-2', maxTokens: 4096, bearerToken: 'fake-token', models: { medium: 'model-id' } },
      });
      await createLLMForTier(config, 'medium').complete('prompt');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(4096);
    });

    it('sends the override value instead of config.llm.maxTokens when given', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: 'ok' }] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const config = KarpathyConfigSchema.parse({
        vaultPath: '/tmp/v',
        llm: { provider: 'bedrock', region: 'us-west-2', maxTokens: 4096, bearerToken: 'fake-token', models: { heavy: 'model-id' } },
      });
      await createLLMForTier(config, 'heavy', 8192).complete('prompt');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(8192);
    });
  });
});
