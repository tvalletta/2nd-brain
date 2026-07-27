import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { extractEntitiesHandler, extractEntitiesRichHandler } from '../../../src/jobs/handlers/extract-entities.js';
import { compileEntitiesHandler } from '../../../src/jobs/handlers/compile-entities.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { slugify } from '../../../src/vault/paths.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

// Raw LLM-shaped response: uses the snake_case "action_items" key exactly as
// the real LLM would (see extractEntitiesRichPrompt) — this exercises the
// action_items -> actionItems preprocess rename in entity-extractor-rich.ts
// as well as the serializer this test targets.
const RAW_LLM_RESPONSE = {
  people: [],
  projects: [],
  concepts: [],
  topics: [],
  decisions: [],
  tools: [],
  organizations: [],
  action_items: [
    {
      task: 'Send follow-up email to client',
      owner: 'Tom',
      dueDate: '2026-08-01',
      status: 'open',
      confidence: 0.9,
      chunkRefs: [],
    },
  ],
  open_questions: [],
};

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      return schema.parse(RAW_LLM_RESPONSE);
    },
  };
}

describe('extract-entities-rich -> compile-entities integration (action_items)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueuedJobs: Job[];

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => {
        const job: Job = {
          ...input,
          id: `enq-${enqueuedJobs.length}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
          debounceMs: input.debounceMs ?? 0,
          priority: input.priority ?? 50,
          payload: input.payload ?? {},
          trigger: input.trigger ?? 'cascade',
        } as Job;
        enqueuedJobs.push(job);
        return job;
      },
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-extract-compile-'));
    vault = createFsAdapter(dir);
    enqueuedJobs = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries action_items all the way from rich extraction through to the rollup checklist', async () => {
    // A project_slug that does NOT match the tool's own project root, so the
    // self-referential filter in compile-entities.ts doesn't short-circuit.
    const projectSlug = 'client-project';
    expect(projectSlug).not.toBe(slugify(dir.split('/').pop()!));

    const rawPath = 'raw/session.txt';
    await vault.write(rawPath, 'Tom: I will send a follow-up email to the client tomorrow.');

    const summaryPath = 'sources/session-summary.md';
    await vault.write(
      summaryPath,
      serializeNote(
        {
          id: 'src1',
          type: 'source_summary',
          title: 'Client session',
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
          source_type: 'plaintext',
          source_hash: 'hash1',
          project_slug: projectSlug,
        },
        '\nBody.\n',
      ),
    );

    const extractJob: Job = {
      id: 'job-extract-rich',
      type: 'extract-entities-rich',
      status: 'running',
      priority: 50,
      targetPath: summaryPath,
      payload: { rawPath },
      trigger: 'cascade',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      debounceMs: 0,
    };

    const ctx = makeCtx();
    await extractEntitiesRichHandler.execute(extractJob, ctx);

    // 1. The extract-entities-rich handler must have cascaded a
    // compile-entities job whose payload actually carries actionItems.
    const compileJob = enqueuedJobs.find((j) => j.type === 'compile-entities');
    expect(compileJob).toBeDefined();
    const entitiesPayload = compileJob!.payload.entities as Record<string, unknown>;
    expect(Array.isArray(entitiesPayload.actionItems)).toBe(true);
    const actionItems = entitiesPayload.actionItems as Array<Record<string, unknown>>;
    expect(actionItems).toHaveLength(1);
    expect(actionItems[0]).toMatchObject({ task: 'Send follow-up email to client', owner: 'Tom', status: 'open' });

    // 2. Running compile-entities with that exact payload must produce a real
    // rollup checklist file — this is the artifact the original bug prevented
    // from ever being created in the real pipeline.
    await compileEntitiesHandler.execute(compileJob!, ctx);

    const rollupPath = 'wiki/_system/action-items.md';
    expect(await vault.exists(rollupPath)).toBe(true);
    const rollupContent = await vault.read(rollupPath);
    expect(rollupContent).toContain('Send follow-up email to client');
    expect(rollupContent).toContain(`\`project:${projectSlug}\``);

    // Bonus: the per-project checklist should also have been created.
    const projectPath = `wiki/projects/${projectSlug}/action-items.md`;
    expect(await vault.exists(projectPath)).toBe(true);
    expect(await vault.read(projectPath)).toContain('Send follow-up email to client');
  });
});

describe('extractEntitiesHandler / extractEntitiesRichHandler — transient error propagation', () => {
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

  function makeJob(type: 'extract-entities' | 'extract-entities-rich'): Job {
    return {
      id: `job-${type}`, type, status: 'running', priority: 50,
      targetPath: summaryPath, payload: { rawPath }, trigger: 'cascade',
      createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-extract-transient-'));
    vault = createFsAdapter(dir);
    rawPath = 'raw/session.txt';
    await vault.write(rawPath, 'Some raw content to extract entities from.');
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

  it('extractEntitiesHandler rejects with the original TransientLLMError on a transient extraction failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new TransientLLMError('VPN down'); },
    };
    const ctx = makeCtx(llm);
    await expect(extractEntitiesHandler.execute(makeJob('extract-entities'), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('extractEntitiesHandler rejects with a plain Error (not TransientLLMError) on a non-transient failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new Error('bad output'); },
    };
    const ctx = makeCtx(llm);
    let caught: unknown;
    try {
      await extractEntitiesHandler.execute(makeJob('extract-entities'), ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransientLLMError);
    expect((caught as Error).message).toContain('Entity extraction failed');
  });

  it('extractEntitiesRichHandler rejects with the original TransientLLMError on a transient extraction failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new TransientLLMError('VPN down'); },
    };
    const ctx = makeCtx(llm);
    await expect(extractEntitiesRichHandler.execute(makeJob('extract-entities-rich'), ctx)).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('extractEntitiesRichHandler rejects with a plain Error (not TransientLLMError) on a non-transient failure', async () => {
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured() { throw new Error('bad output'); },
    };
    const ctx = makeCtx(llm);
    let caught: unknown;
    try {
      await extractEntitiesRichHandler.execute(makeJob('extract-entities-rich'), ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransientLLMError);
    expect((caught as Error).message).toContain('Rich entity extraction failed');
  });
});
