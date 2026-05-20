import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { reEnrichNoteHandler } from '../../../src/jobs/handlers/re-enrich-note.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';
import { OPEN_TAG, CLOSE_TAG } from '../../../src/vault/protected-regions.js';

function makeLLM(entities: unknown): LLMClient {
  return {
    async complete() { return JSON.stringify(entities); },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(entities);
    },
  };
}

function makeJob(notePath: string): Job {
  return {
    id: 'test-re-enrich',
    type: 're-enrich-note',
    status: 'running',
    priority: 55,
    targetPath: notePath,
    payload: { notePath },
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('re-enrich-note handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let enqueued: JobCreateInput[];

  function makeCtx(entities: unknown): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
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
      llm: makeLLM(entities),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-ren-'));
    vault = createFsAdapter(dir);
    enqueued = [];
    await vault.ensureFolder('wiki/entities/people');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when note does not exist', async () => {
    const ctx = makeCtx({});
    await expect(
      reEnrichNoteHandler.execute(makeJob('wiki/nonexistent.md'), ctx),
    ).rejects.toThrow('not found');
  });

  it('no-ops when human text is too short', async () => {
    const notePath = 'wiki/entities/people/alice.md';
    const fm = {
      id: 'alice',
      type: 'entity',
      title: 'Alice',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const body = `${OPEN_TAG('summary')}\nMachine content.\n${CLOSE_TAG('summary')}`;
    await vault.create(notePath, serializeNote(fm, body));

    const ctx = makeCtx({});
    await reEnrichNoteHandler.execute(makeJob(notePath), ctx);

    // No link-concepts enqueued (text too short after stripping)
    expect(enqueued.filter((j) => j.type === 'link-concepts')).toHaveLength(0);

    // But last_verified and updated_at should still be stamped.
    const updated = await vault.read(notePath);
    const { data } = parseNote(updated);
    expect(data.last_verified).toBeDefined();
  });

  it('enqueues link-concepts and update-backlinks when entities found', async () => {
    const notePath = 'wiki/entities/people/bob.md';
    const fm = {
      id: 'bob',
      type: 'entity',
      title: 'Bob',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const body =
      `${OPEN_TAG('summary')}\nMachine content here.\n${CLOSE_TAG('summary')}\n\n` +
      'Bob works closely with Carol on the distributed caching system. ' +
      'He leads the infrastructure team and has deep expertise in Redis and Kafka.';
    await vault.create(notePath, serializeNote(fm, body));

    const fakeEntities = {
      people: [{ name: 'Carol', role: 'Engineer', confidence: 0.8, relationships: [], chunkRefs: [] }],
      projects: [],
      concepts: [{ name: 'Redis', definition: 'In-memory data store', confidence: 0.85, relationships: [], chunkRefs: [] }],
      topics: [],
      decisions: [],
      tools: [],
      organizations: [],
    };
    const ctx = makeCtx(fakeEntities);
    await reEnrichNoteHandler.execute(makeJob(notePath), ctx);

    const linkJobs = enqueued.filter((j) => j.type === 'link-concepts');
    const backlinkJobs = enqueued.filter((j) => j.type === 'update-backlinks');
    expect(linkJobs).toHaveLength(1);
    expect(linkJobs[0].targetPath).toBe(notePath);
    expect(backlinkJobs).toHaveLength(1);
    expect(backlinkJobs[0].targetPath).toBe(notePath);

    // Frontmatter timestamps should be updated.
    const updated = await vault.read(notePath);
    const { data } = parseNote(updated);
    expect(data.last_verified).toBeDefined();
    expect(data.updated_at).toBeDefined();
  });

  it('does not overwrite protected region content', async () => {
    const notePath = 'wiki/entities/people/carol.md';
    const machineContent = 'Machine-generated summary: Carol is a senior engineer.';
    const fm = {
      id: 'carol',
      type: 'entity',
      title: 'Carol',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const body =
      `${OPEN_TAG('summary')}\n${machineContent}\n${CLOSE_TAG('summary')}\n\n` +
      'Carol recently joined the platform team and has been mentoring junior engineers ' +
      'on distributed systems patterns and service mesh configuration.';
    await vault.create(notePath, serializeNote(fm, body));

    const fakeEntities = { people: [], projects: [], concepts: [], topics: [], decisions: [], tools: [], organizations: [] };
    const ctx = makeCtx(fakeEntities);
    await reEnrichNoteHandler.execute(makeJob(notePath), ctx);

    const updated = await vault.read(notePath);
    expect(updated).toContain(machineContent);
  });
});
