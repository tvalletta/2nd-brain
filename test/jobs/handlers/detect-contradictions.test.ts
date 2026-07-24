import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { detectContradictionsHandler } from '../../../src/jobs/handlers/detect-contradictions.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(): Job {
  return {
    id: 'test-detect-contradictions',
    type: 'detect-contradictions',
    status: 'running',
    priority: 80,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('detect-contradictions handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) =>
        ({
          ...input,
          id: 'enq',
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: 0,
          priority: input.priority ?? 50,
          payload: input.payload ?? {},
          trigger: input.trigger ?? 'cascade',
        }) as Job,
      llm: {} as never,
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-contradictions-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs without error on an empty vault and logs a run entry', async () => {
    const ctx = makeCtx();
    await expect(detectContradictionsHandler.execute(makeJob(), ctx)).resolves.not.toThrow();

    const log = await vault.read('Curated/log.md').catch(() => vault.read('log.md'));
    expect(log).toContain('review:contradictions');
    expect(log).toContain('0 candidates flagged');
  });
});
