import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { checkConfidenceDecayHandler } from '../../../src/jobs/handlers/check-confidence-decay.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job',
    type: 'check-confidence-decay',
    status: 'running',
    priority: 85,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
    ...overrides,
  };
}

describe('check-confidence-decay handler', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueuedJobs: JobCreateInput[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-decay-'));
    vault = createFsAdapter(tempDir);
    enqueuedJobs = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeContext(): JobContext {
    return {
      vaultPath: tempDir,
      projectRoot: tempDir,
      vault,
      enqueue: async (input: JobCreateInput) => {
        enqueuedJobs.push(input);
        return { ...input, id: 'enqueued', status: 'pending', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0, priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade' } as Job;
      },
      llm: {} as any,
      config: KarpathyConfigSchema.parse({
        vaultPath: tempDir,
        agent: { enabled: true, incrementalThreshold: 5 },
      }),
    };
  }

  async function writeProjectSpec(
    slug: string,
    specType: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const hubDir = `wiki/projects/${slug}`;
    await vault.ensureFolder(hubDir);

    const fm: Record<string, unknown> = {
      id: `${slug}-${specType}`,
      type: 'project_spec',
      title: `${slug} ${specType}`,
      project_key: slug,
      spec_type: specType,
      status: 'active',
      confidence: 'medium',
      review_state: 'approved',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      last_reinforced: '2026-01-01T00:00:00Z',
      reinforcement_count: 3,
      conversations_since_update: 0,
      stale_threshold: 10,
      source_refs: [],
      derived_from: [],
      aliases: [],
      links: [],
      change_origin: 'extraction',
      protected_regions: ['content'],
      ...overrides,
    };

    const content = serializeNote(fm, `\n# ${slug} ${specType}\n`);
    await vault.atomicWrite(`${hubDir}/${specType}.md`, content);

    // Also write _index.md so the hub is valid
    if (!(await vault.exists(`${hubDir}/_index.md`))) {
      const indexFm: Record<string, unknown> = {
        id: slug,
        type: 'project',
        title: slug,
        project_key: slug,
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        source_refs: [],
        derived_from: [],
        aliases: [],
        links: [],
        change_origin: 'extraction',
        protected_regions: [],
      };
      const indexContent = serializeNote(indexFm, `\n# ${slug}\n`);
      await vault.atomicWrite(`${hubDir}/_index.md`, indexContent);
    }
  }

  it('does nothing when no project specs exist', async () => {
    const context = makeContext();
    await checkConfidenceDecayHandler.execute(makeJob(), context);
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('does nothing when all specs are fresh', async () => {
    const now = new Date().toISOString();
    await writeProjectSpec('my-proj', 'technical', {
      conversations_since_update: 2,
      stale_threshold: 10,
      last_reinforced: now,
    });

    const context = makeContext();
    await checkConfidenceDecayHandler.execute(makeJob(), context);
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('enqueues re-synthesis when conversations_since_update exceeds threshold', async () => {
    await writeProjectSpec('stale-proj', 'technical', {
      conversations_since_update: 15,
      stale_threshold: 10,
    });

    const context = makeContext();
    await checkConfidenceDecayHandler.execute(makeJob(), context);

    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].type).toBe('agent-synthesize-project');
    expect(enqueuedJobs[0].payload!.projectSlug).toBe('stale-proj');
  });

  it('enqueues re-synthesis when last_reinforced is too old', async () => {
    // 60 days ago
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await writeProjectSpec('old-proj', 'technical', {
      conversations_since_update: 0,
      stale_threshold: 10,
      last_reinforced: oldDate,
    });

    const context = makeContext();
    await checkConfidenceDecayHandler.execute(makeJob(), context);

    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].payload!.projectSlug).toBe('old-proj');
  });

  it('deduplicates per project (multiple stale specs in same project)', async () => {
    await writeProjectSpec('multi-spec', 'technical', {
      conversations_since_update: 15,
      stale_threshold: 10,
    });
    await writeProjectSpec('multi-spec', 'product', {
      conversations_since_update: 12,
      stale_threshold: 10,
    });

    const context = makeContext();
    await checkConfidenceDecayHandler.execute(makeJob(), context);

    // Should only enqueue once for the project
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].payload!.projectSlug).toBe('multi-spec');
  });
});
