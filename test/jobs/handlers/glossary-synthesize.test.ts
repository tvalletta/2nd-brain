import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { upsertConceptMention, conceptGlossaryPath } from '../../../src/maintenance/concept-glossary.js';
import { DEFAULT_LAYOUT } from '../../../src/vault/paths.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

vi.mock('../../../src/enrichment/llm-factory.js', () => ({
  createLLMFromConfig: vi.fn(),
}));

import { createLLMFromConfig } from '../../../src/enrichment/llm-factory.js';
import { glossarySynthesizeHandler } from '../../../src/jobs/handlers/glossary-synthesize.js';

function fakeClient(text: string) {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({ synthesis: text });
    },
  };
}

function makeJob(conceptName?: string): Job {
  return {
    id: 'test-glossary-synth', type: 'glossary-synthesize', status: 'running', priority: 40,
    payload: conceptName ? { conceptName } : {}, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('glossary-synthesize handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-synth-'));
    vault = createFsAdapter(dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, projectRoot: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as any,
      config,
    };
  }

  it('does nothing when conceptName is missing from the payload', async () => {
    await glossarySynthesizeHandler.execute(makeJob(), makeContext());
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('does nothing when intelligence.richness.enabled is false', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    const ctx = makeContext({ intelligence: { richness: { enabled: false } } });
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('skips without constructing an LLM client when the fast-tier budget is exhausted', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    const ctx = makeContext({ intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 0, heavy: 0 } } } });
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('synthesizes and writes the rollup line when everything is enabled', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue(fakeClient('A recurring audit benchmark.') as never);

    const ctx = makeContext();
    await glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx);

    expect(createLLMFromConfig).toHaveBeenCalledWith(ctx.config, expect.any(String), 'fast');
    const content = await vault.read(conceptGlossaryPath(DEFAULT_LAYOUT));
    expect(content).toContain('A recurring audit benchmark. (as of 1 mentions)');
  });

  it('lets a TransientLLMError from the synthesis call propagate out of execute()', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue({
      async complete() { return ''; },
      async extractStructured() { throw new TransientLLMError('outage'); },
    } as never);

    const ctx = makeContext();
    await expect(glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('logs and swallows a non-transient synthesis failure instead of throwing', async () => {
    await upsertConceptMention(vault, DEFAULT_LAYOUT, { name: 'Efficiency', gloss: 'g1', sourceRef: 'a.md' });
    vi.mocked(createLLMFromConfig).mockReturnValue({
      async complete() { return ''; },
      async extractStructured() { throw new Error('malformed JSON'); },
    } as never);

    const ctx = makeContext();
    await expect(glossarySynthesizeHandler.execute(makeJob('Efficiency'), ctx)).resolves.toBeUndefined();
  });
});
