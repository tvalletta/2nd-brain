import type { KarpathyConfig, LLMTier } from '../../src/config/schema.js';
import {
  createBedrockClient,
  createLiteLLMClient,
  createNoopClient,
  type LLMClient,
} from '../../src/enrichment/llm-client.js';

/** Resolve which model ID a given tier maps to for this config. */
export function resolveTierModel(config: KarpathyConfig, tier: LLMTier): string {
  return config.llm.models[tier];
}

/**
 * Construct an LLMClient for a specific tier. Mirrors src/bin/karpathy.ts's
 * private createLLMFromConfig provider branching, but resolves
 * config.llm.models[tier] instead of the legacy single config.llm.model
 * field — this is the first call site in this codebase to do so.
 *
 * `maxTokensOverride` lets a caller raise the output-token budget above
 * `config.llm.maxTokens` for calls whose expected output scales with input
 * size (e.g. judging a large candidate pool) without changing the shared
 * global default that other LLM call sites rely on.
 */
export function createLLMForTier(config: KarpathyConfig, tier: LLMTier, maxTokensOverride?: number): LLMClient {
  const model = resolveTierModel(config, tier);
  const maxTokens = maxTokensOverride ?? config.llm.maxTokens;
  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) {
      throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    }
    return createLiteLLMClient({ baseUrl, apiKey, model, maxTokens });
  }
  if (config.llm.provider === 'bedrock') {
    return createBedrockClient({
      region: config.llm.region,
      model,
      maxTokens,
      bearerToken: config.llm.bearerToken,
    });
  }
  return createNoopClient();
}
