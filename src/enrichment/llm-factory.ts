import { createBedrockClient, createLiteLLMClient, createNoopClient, type LLMClient } from './llm-client.js';
import { withConnectivityProbe } from './connectivity-probe.js';
import type { KarpathyConfig } from '../config/schema.js';

/**
 * Single shared factory for constructing the configured LLM client, wrapped
 * with the VPN-aware connectivity probe. Consolidates what used to be four
 * separately-maintained (and drifted) copies in src/bin/karpathy.ts,
 * src/bin/intel-command.ts, src/mcp/context.ts, and src/hooks/dispatch.ts —
 * three of which only ever checked `config.llm.provider === 'bedrock'` and
 * silently fell back to a no-op client for `'litellm'`.
 */
export function createLLMFromConfig(config: KarpathyConfig, stateDir: string): LLMClient {
  if (config.llm.provider === 'litellm') {
    const baseUrl = config.llm.baseUrl;
    const apiKey = config.llm.apiKey;
    if (!baseUrl || !apiKey) throw new Error('LiteLLM provider requires llm.baseUrl and llm.apiKey in config');
    const client = createLiteLLMClient({ baseUrl, apiKey, model: config.llm.model, maxTokens: config.llm.maxTokens });
    return withConnectivityProbe(client, 'litellm', config, stateDir);
  }
  if (config.llm.provider === 'bedrock') {
    const client = createBedrockClient({
      region: config.llm.region,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      bearerToken: config.llm.bearerToken,
    });
    return withConnectivityProbe(client, 'bedrock', config, stateDir);
  }
  return createNoopClient();
}
