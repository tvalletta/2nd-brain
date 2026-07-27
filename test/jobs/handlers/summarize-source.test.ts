import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { summarizeSourceHandler } from '../../../src/jobs/handlers/summarize-source.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

describe('summarizeSourceHandler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let summaryPath: string;
  let rawPath: string;

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
      id: 'job-summarize-source', type: 'summarize-source', status: 'running', priority: 50,
      targetPath: summaryPath, payload: { rawPath }, trigger: 'cascade',
      createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-summarize-source-'));
    vault = createFsAdapter(dir);
    rawPath = 'raw/session.txt';
    await vault.write(rawPath, 'Some raw content to summarize.');
    summaryPath = 'sources/session-summary.md';
    await vault.write(
      summaryPath,
      serializeNote(
        {
          id: 'src1', type: 'source_summary', title: 'Session', created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z', source_type: 'plaintext', source_hash: 'hash1',
        },
        '\nBody.\n',
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects with the original TransientLLMError when summarization fails transiently', async () => {
    const llm: LLMClient = {
      async complete() { throw new TransientLLMError('VPN down'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const ctx = makeCtx(llm);

    await expect(summarizeSourceHandler.execute(makeJob(), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('rejects with a plain Error (not TransientLLMError) on a non-transient summarization failure', async () => {
    const llm: LLMClient = {
      async complete() { throw new Error('model refused'); },
      async extractStructured() { throw new Error('not implemented'); },
    };
    const ctx = makeCtx(llm);

    let caught: unknown;
    try {
      await summarizeSourceHandler.execute(makeJob(), ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransientLLMError);
    expect((caught as Error).message).toContain('Summarization failed');
    expect((caught as Error).message).toContain('model refused');
  });
});
