import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { createDigestCache } from '../../../src/agent/digest-cache.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

vi.mock('../../../src/agent/bedrock-agent-client.js', () => ({
  createAgentClient: vi.fn(() => ({
    runAgentLoop: vi.fn(async () => ({ turns: 1, toolCalls: 0 })),
  })),
}));

import { createAgentClient } from '../../../src/agent/bedrock-agent-client.js';
import { agentSynthesizeProjectHandler } from '../../../src/jobs/handlers/agent-synthesize-project.js';

function makeJob(projectSlug: string): Job {
  return {
    id: 'test-synth', type: 'agent-synthesize-project', status: 'running', priority: 35,
    payload: { projectSlug }, trigger: 'cascade',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('agent-synthesize-project handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-synth-'));
    vault = createFsAdapter(dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(config: ReturnType<typeof KarpathyConfigSchema.parse>): JobContext {
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

  async function writeHub(hubDir: string, slug: string): Promise<void> {
    await vault.ensureFolder(hubDir);
    const indexFm: Record<string, unknown> = {
      id: slug, type: 'project', title: slug, project_key: slug, status: 'active',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: ['overview', 'specs', 'people', 'sessions', 'sources', 'backlinks'],
    };
    await vault.atomicWrite(`${hubDir}/_index.md`, serializeNote(indexFm, `\n# ${slug}\n`));
    const specFm: Record<string, unknown> = {
      id: `${slug}-technical`, type: 'project_spec', title: `${slug} technical`, project_key: slug,
      spec_type: 'technical', status: 'active', confidence: 'medium', review_state: 'approved',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'extraction',
      protected_regions: ['content'],
    };
    await vault.atomicWrite(`${hubDir}/technical.md`, serializeNote(specFm, `\n# ${slug} technical\n`));
  }

  it('reads the hub and specs under a non-default layout.wiki, and runs the agent loop', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      agent: { enabled: true },
    });
    await writeHub('Curated/wiki/projects/my-proj', 'my-proj');

    const digestCache = createDigestCache(join(dir, config.stateDir));
    await digestCache.set({
      sourcePath: 'raw/ai-conversations/my-proj/s1.md',
      sourceHash: 'h1',
      digest: 'Discussed the new ingest pipeline.',
      entities: [], topics: [], decisions: [],
      createdAt: '2026-01-01T00:00:00Z',
    });

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('my-proj'), ctx);

    expect(createAgentClient).toHaveBeenCalledTimes(1);
  });

  it('regression: still finds the hub and specs under the DEFAULT layout (unchanged behavior)', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, agent: { enabled: true } });
    await writeHub('wiki/projects/legacy-proj', 'legacy-proj');

    const digestCache = createDigestCache(join(dir, config.stateDir));
    await digestCache.set({
      sourcePath: 'raw/ai-conversations/legacy-proj/s1.md',
      sourceHash: 'h1',
      digest: 'Discussed onboarding.',
      entities: [], topics: [], decisions: [],
      createdAt: '2026-01-01T00:00:00Z',
    });

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('legacy-proj'), ctx);

    expect(createAgentClient).toHaveBeenCalledTimes(1);
  });

  it('skips (does not call the agent loop) when no hub exists at the configured layout path', async () => {
    // Hub written at the DEFAULT layout path while config declares Curated/wiki — there is
    // genuinely no hub at the configured path, so this must still legitimately no-op.
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      agent: { enabled: true },
    });
    await writeHub('wiki/projects/my-proj', 'my-proj'); // wrong location for this config

    const ctx = makeContext(config);
    await agentSynthesizeProjectHandler.execute(makeJob('my-proj'), ctx);

    expect(createAgentClient).not.toHaveBeenCalled();
  });
});
