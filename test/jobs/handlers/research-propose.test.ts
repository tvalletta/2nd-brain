import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { researchProposeHandler } from '../../../src/jobs/handlers/research-propose.js';
import { writeResearchQueue } from '../../../src/maintenance/research-queue.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeJob(): Job {
  return {
    id: 'job-1', type: 'research-propose', status: 'pending', priority: 90,
    payload: {}, trigger: 'timer', createdAt: new Date().toISOString(),
    retryCount: 0, maxRetries: 3, debounceMs: 0, transientRetryCount: 0,
  };
}

const noopLLM: LLMClient = {
  async complete() { return '{}'; },
  async extractStructured() { throw new Error('not used in this test'); },
};

describe('research-propose job handler (G1)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rp-handler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/topics');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('threads ctx.enqueue into proposeResearch so autoDrainEnabled candidates actually get drained', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { research: { autoDrainEnabled: true } },
    });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => makeJob());
    const ctx: JobContext = { vaultPath: dir, projectRoot: dir, enqueue, llm: noopLLM, vault, config };

    await researchProposeHandler.execute(makeJob(), ctx);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'research-execute', payload: { slug: 'fsrs', depth: 'medium' } }),
    );
  });

  it('does not drain when autoDrainEnabled is false (default), even though enqueue is available', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    await writeResearchQueue(vault, {
      candidates: [
        { slug: 'fsrs', title: 'FSRS', score: 0.6, reason: 'r', suggested: 'medium', decision: 'medium', status: 'pending', addedAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
    const enqueue = vi.fn(async () => makeJob());
    const ctx: JobContext = { vaultPath: dir, projectRoot: dir, enqueue, llm: noopLLM, vault, config };

    await researchProposeHandler.execute(makeJob(), ctx);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
