// A2: Pick an embedding provider + open a store from a KarpathyConfig.
// Centralizes the provider-selection policy so callers don't repeat it.

import { join } from 'node:path';
import type { KarpathyConfig } from '../config/schema.js';
import {
  type EmbeddingProvider,
  type EmbeddingStore,
  createBedrockTitanProvider,
  createDeterministicProvider,
  createOllamaProvider,
  openEmbeddingStore,
} from './index.js';

export function createProviderFromConfig(config: KarpathyConfig): EmbeddingProvider {
  switch (config.embeddings.provider) {
    case 'bedrock-titan':
      return createBedrockTitanProvider({
        region: config.embeddings.region ?? config.llm.region,
        modelId: config.embeddings.model,
        dimensions: config.embeddings.dimensions as 256 | 512 | 1024 | undefined,
      });
    case 'ollama':
      return createOllamaProvider({
        baseUrl: config.embeddings.baseUrl,
        model: config.embeddings.model ?? 'nomic-embed-text',
        dimensions: config.embeddings.dimensions ?? 768,
        timeoutMs: config.embeddings.timeoutMs,
      });
    case 'deterministic':
    default:
      return createDeterministicProvider();
  }
}

export function openStoreFromConfig(
  config: KarpathyConfig,
  projectRoot: string,
): EmbeddingStore {
  const provider = createProviderFromConfig(config);
  const dbPath = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  return openEmbeddingStore({ dbPath, provider });
}
