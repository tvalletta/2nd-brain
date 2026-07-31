import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('../../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});

import { generateReviewAnalysis } from '../../../src/review/generate-review-analysis.js';
import { TransientLLMError } from '../../../src/shared/errors.js';

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

  it('writes an ambiguous-entity review note with the generated analysis, validating a real matchedPath', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/alex-chen.md',
      serializeNote(
        { id: 'e1', type: 'entity', title: 'Alex Chen', canonical_name: 'Alex Chen', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Chen\n\nBackend engineer.\n',
      ),
    );
    await vault.create(
      'Curated/wiki/entities/alex-park.md',
      serializeNote(
        { id: 'e2', type: 'entity', title: 'Alex Park', canonical_name: 'Alex Park', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Park\n\nProduct manager.\n',
      ),
    );
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'match', matchedPath: 'Curated/wiki/entities/alex-chen.md',
      reasoning: 'The PR-review context fits the backend engineer.', confidence: 0.8, tier: 'fast',
    });

    const summaryPath = 'sources/s1.md';
    await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Alex Chrk', context: 'Chrk reviewed the PR.' }] }),
      ctx,
    );

    const reviewFiles = await vault.listMarkdownFiles('review');
    expect(reviewFiles).toHaveLength(1);
    const content = await vault.read(reviewFiles[0]);
    expect(content).toContain('The PR-review context fits the backend engineer.');
    expect(content).toContain('alex-chen');
    const { data } = parseNote(content);
    expect(data.confidence).toBe('high');
  });

  it('does not trust a matchedPath the model invented outside the real candidate list', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/alex-chen.md',
      serializeNote(
        { id: 'e1', type: 'entity', title: 'Alex Chen', canonical_name: 'Alex Chen', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Chen\n\nBackend engineer.\n',
      ),
    );
    await vault.create(
      'Curated/wiki/entities/alex-park.md',
      serializeNote(
        { id: 'e2', type: 'entity', title: 'Alex Park', canonical_name: 'Alex Park', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Park\n\nProduct manager.\n',
      ),
    );
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'match', matchedPath: 'Curated/wiki/entities/someone-else.md', // not a real candidate
      reasoning: 'Hallucinated match.', confidence: 0.8, tier: 'fast',
    });

    const summaryPath = 'sources/s1.md';
    await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
    const ctx = makeCtx();
    await linkConceptsHandler.execute(
      makeJob(summaryPath, { people: [{ name: 'Alex Chrk', context: 'Chrk reviewed the PR.' }] }),
      ctx,
    );

    const reviewFiles = await vault.listMarkdownFiles('review');
    const content = await vault.read(reviewFiles[0]);
    expect(content).not.toContain('Suggested match');
  });

  it('a TransientLLMError from generateReviewAnalysis during ambiguous-entity resolution propagates instead of being swallowed', async () => {
    await vault.ensureFolder('Curated/wiki/entities');
    await vault.create(
      'Curated/wiki/entities/alex-chen.md',
      serializeNote(
        { id: 'e1', type: 'entity', title: 'Alex Chen', canonical_name: 'Alex Chen', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Chen\n\nBackend engineer.\n',
      ),
    );
    await vault.create(
      'Curated/wiki/entities/alex-park.md',
      serializeNote(
        { id: 'e2', type: 'entity', title: 'Alex Park', canonical_name: 'Alex Park', entity_kind: 'person', aliases: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        '\n# Alex Park\n\nProduct manager.\n',
      ),
    );
    vi.mocked(generateReviewAnalysis).mockRejectedValue(new TransientLLMError('outage'));

    const summaryPath = 'sources/s1.md';
    await vault.create(summaryPath, '---\ntitle: S1\n---\n# S1\n');
    const ctx = makeCtx();

    await expect(
      linkConceptsHandler.execute(
        makeJob(summaryPath, { people: [{ name: 'Alex Chrk', context: 'Chrk reviewed the PR.' }] }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(TransientLLMError);

    // No review item should have been written — the failure aborted before
    // createReviewItem was reached, and the job should be retried whole.
    const reviewFiles = await vault.listMarkdownFiles('review');
    expect(reviewFiles).toHaveLength(0);
  });
});
