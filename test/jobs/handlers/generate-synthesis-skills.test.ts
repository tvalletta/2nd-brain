import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { generateSynthesisSkillsHandler } from '../../../src/jobs/handlers/generate-synthesis-skills.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

describe('generateSynthesisSkillsHandler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(llm: LLMClient): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm,
      config,
    };
  }

  function makeJob(): Job {
    return {
      id: 'job-generate-synthesis-skills', type: 'generate-synthesis-skills', status: 'running', priority: 50,
      payload: {}, trigger: 'scheduled',
      createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-gen-skills-'));
    vault = createFsAdapter(dir);
    // An unmatched conversation snippet so the handler reaches the LLM call
    // (no existing skills means matchSkill() always returns null).
    await vault.ensureFolder('raw/ai-conversations/claude/_general');
    await vault.write(
      'raw/ai-conversations/claude/_general/session1.md',
      'A conversation about something novel that matches no existing skill.',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects with the original TransientLLMError when skill generation fails transiently', async () => {
    const llm: LLMClient = {
      async complete() { throw new TransientLLMError('VPN down'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const ctx = makeCtx(llm);

    await expect(generateSynthesisSkillsHandler.execute(makeJob(), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('regression: swallows a plain Error and resolves normally (existing behavior, unchanged)', async () => {
    const llm: LLMClient = {
      async complete() { throw new Error('model refused'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const ctx = makeCtx(llm);

    await expect(generateSynthesisSkillsHandler.execute(makeJob(), ctx)).resolves.toBeUndefined();
  });
});
