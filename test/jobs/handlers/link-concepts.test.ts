import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { linkConceptsHandler } from '../../../src/jobs/handlers/link-concepts.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, entities: Record<string, unknown>): Job {
  return {
    id: 'test-link-concepts',
    type: 'link-concepts',
    status: 'running',
    priority: 50,
    targetPath: summaryPath,
    payload: { entities },
    trigger: 'cascade',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('link-concepts handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      layout: { wiki: 'Curated/wiki' },
      enrichment: { significanceGate: 'off' },
    });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => {
        enqueued.push(input);
        return {
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
        } as Job;
      },
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-link-concepts-'));
    vault = createFsAdapter(dir);
    enqueued = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves an existing entity under a non-default layout instead of creating a duplicate', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/jordan-ellis.md',
      serializeNote(
        {
          id: 'e1',
          type: 'entity',
          title: 'Jordan Ellis',
          canonical_name: 'Jordan Ellis',
          entity_kind: 'person',
          aliases: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        '\n# Jordan Ellis\n\nContent.\n',
      ),
    );
    await vault.ensureFolder('Curated/wiki/sources');
    const summaryPath = 'Curated/wiki/sources/summary-001.md';
    await vault.create(
      summaryPath,
      serializeNote({ id: 's1', type: 'source', title: 'Summary', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' }, '\nBody.\n'),
    );

    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Jordan Ellis' }] }),
      ctx,
    );

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.links).toEqual(['Curated/wiki/entities/jordan-ellis.md']);

    // No duplicate entity file was created under any folder.
    const entityFiles = await vault.listMarkdownFiles('Curated/wiki/entities');
    expect(entityFiles).toEqual(['Curated/wiki/entities/jordan-ellis.md']);
  });
});
