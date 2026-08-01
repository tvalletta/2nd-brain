import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { compileEntitiesHandler } from '../../../src/jobs/handlers/compile-entities.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, entities: Record<string, unknown>): Job {
  return {
    id: 'test-compile-entities', type: 'compile-entities', status: 'running', priority: 50,
    targetPath: summaryPath, payload: { entities }, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('compile-entities handler — self-reference filtering', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(), config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-selfref-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips entity creation when project_slug matches the tool\'s own project root', async () => {
    // dir's basename is the "self" project slug for this test run.
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-session.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's1', type: 'source_summary', title: 'Self session', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug },
        '\nBody.\n',
      ),
    );

    const ctx = makeCtx();
    await compileEntitiesHandler.execute(
      makeJob(summaryPath, { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(false);
    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
  });

  it('does not skip entity creation for a different project_slug', async () => {
    const summaryPath = 'sources/other-session.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's2', type: 'source_summary', title: 'Other session', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: 'some-other-project' },
        '\nBody.\n',
      ),
    );

    const ctx = makeCtx();
    await compileEntitiesHandler.execute(
      makeJob(summaryPath, { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(true);
  });

  it('promotes a draft self-referential source to active on the early-return path (Sub-project C, G0)', async () => {
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-draft.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        { id: 's3', type: 'source_summary', title: 'Self session', status: 'draft', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug },
        '\nBody.\n',
      ),
    );

    await compileEntitiesHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });

  it('recovers an archived self-referential source to active on the early-return path (G7)', async () => {
    const { slugify } = await import('../../../src/vault/paths.js');
    const selfSlug = slugify(dir.split('/').pop()!);

    const summaryPath = 'sources/self-archived.md';
    await vault.ensureFolder('sources');
    await vault.create(
      summaryPath,
      serializeNote(
        {
          id: 's4', type: 'source_summary', title: 'Self session', status: 'archived',
          archived_at: '2026-04-01T00:00:00Z', archived_reason: 'stale-draft (40d at ingest_status: detected)',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: selfSlug,
        },
        '\nBody.\n',
      ),
    );

    await compileEntitiesHandler.execute(makeJob(summaryPath, {}), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });
});

describe('compile-entities handler — glossary synthesis threshold', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => {
        enqueued.push(input);
        return {
          ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
          retryCount: 0, maxRetries: 3, debounceMs: 0,
          priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
        } as Job;
      },
      llm: makeLLM(), config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-glossary-threshold-'));
    vault = createFsAdapter(dir);
    enqueued = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeSummary(path: string): Promise<void> {
    await vault.ensureFolder('sources');
    await vault.create(
      path,
      serializeNote(
        { id: 's1', type: 'source_summary', title: 'S', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', project_slug: 'some-project' },
        '\nBody.\n',
      ),
    );
  }

  it('enqueues glossary-synthesize once a concept mention crosses the configured threshold', async () => {
    const ctx = makeCtx({ intelligence: { richness: { glossarySynthesisThreshold: 2 } } });
    await makeSummary('sources/s1.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s1.md', { concepts: [{ name: 'Efficiency', definition: 'first', confidence: 0.9 }] }),
      ctx,
    );
    await makeSummary('sources/s2.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s2.md', { concepts: [{ name: 'Efficiency', definition: 'second', confidence: 0.9 }] }),
      ctx,
    );

    const glossaryJobs = enqueued.filter((j) => j.type === 'glossary-synthesize');
    expect(glossaryJobs).toHaveLength(1);
    expect(glossaryJobs[0].payload).toEqual({ conceptName: 'Efficiency' });
    expect(glossaryJobs[0].dedupeKey).toBe('glossary-synthesize:efficiency');
  });

  it('does not enqueue glossary-synthesize when the threshold is not crossed', async () => {
    const ctx = makeCtx({ intelligence: { richness: { glossarySynthesisThreshold: 5 } } });
    await makeSummary('sources/s1.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/s1.md', { concepts: [{ name: 'Efficiency', definition: 'first', confidence: 0.9 }] }),
      ctx,
    );

    expect(enqueued.filter((j) => j.type === 'glossary-synthesize')).toHaveLength(0);
  });

  it('promotes a draft source to active on the normal completion path (Sub-project C, G0)', async () => {
    const ctx = makeCtx();
    await makeSummary('sources/normal-draft.md');
    await compileEntitiesHandler.execute(
      makeJob('sources/normal-draft.md', { concepts: [{ name: 'Some Concept', definition: 'x', confidence: 0.9 }] }),
      ctx,
    );

    const { data } = parseNote(await vault.read('sources/normal-draft.md'));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });
});
