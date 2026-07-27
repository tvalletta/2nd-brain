import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

vi.mock('../../src/enrichment/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/enrichment/llm-client.js')>();
  return {
    ...actual,
    createBedrockClient: vi.fn(actual.createBedrockClient),
    createLiteLLMClient: vi.fn(actual.createLiteLLMClient),
  };
});

import { createBedrockClient, createLiteLLMClient } from '../../src/enrichment/llm-client.js';
import { createLLMFromConfig } from '../../src/enrichment/llm-factory.js';

describe('createLLMFromConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-factory-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a LiteLLM client and forwards baseUrl/apiKey/model', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: { provider: 'litellm', baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-haiku-4.5' },
    });
    createLLMFromConfig(config, dir);
    expect(createLiteLLMClient).toHaveBeenCalledWith({
      baseUrl: 'https://proxy.example.com', apiKey: 'k', model: 'claude-haiku-4.5', maxTokens: config.llm.maxTokens,
    });
    expect(createBedrockClient).not.toHaveBeenCalled();
  });

  it('throws a clear error when litellm is selected without baseUrl/apiKey', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, llm: { provider: 'litellm' } });
    expect(() => createLLMFromConfig(config, dir)).toThrow(/requires llm.baseUrl and llm.apiKey/);
  });

  it('builds a Bedrock client and forwards bearerToken', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      llm: { provider: 'bedrock', region: 'us-west-2', model: 'claude-sonnet-4-6', bearerToken: 'tok' },
    });
    createLLMFromConfig(config, dir);
    expect(createBedrockClient).toHaveBeenCalledWith({
      region: 'us-west-2', model: 'claude-sonnet-4-6', maxTokens: config.llm.maxTokens, bearerToken: 'tok',
    });
  });

  it('returns a noop client when no provider matches', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, llm: { provider: 'bedrock' as const } });
    // Force an unrecognized provider via a cast, simulating defensive fallback behavior.
    (config.llm as { provider: string }).provider = 'unknown';
    const client = createLLMFromConfig(config, dir);
    await expect(client.complete('hi')).resolves.toBe('');
  });
});
