import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

vi.mock('../../../src/agent/runner.js', () => ({
  runIngestAgent: vi.fn(async () => ({
    completionData: { conversation_intent: 'test-intent' },
    agentResult: { turns: 1, toolCalls: 0 },
  })),
}));

import { agentIngestHandler } from '../../../src/jobs/handlers/agent-ingest.js';

function makeLLM(): LLMClient {
  return {
    async complete() { return ''; },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

function makeJob(summaryPath: string, rawPath: string): Job {
  return {
    id: 'test-agent-ingest',
    type: 'agent-ingest',
    status: 'running',
    priority: 25,
    payload: { sourceSummaryPath: summaryPath, rawPath, contentCategory: 'ai-conversation-claude' },
    trigger: 'cascade',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('agent-ingest handler — draft/archived -> active promotion (Sub-project C, G0/G7, 4th call site)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(overrides: Record<string, unknown> = {}): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, ...overrides });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: makeLLM(),
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-agent-ingest-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('raw');
    await vault.ensureFolder('outputs/source-summaries');
    await vault.create('raw/session.md', 'Raw session content.');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // `id` is threaded through explicitly (rather than a fixed literal) so
  // each note's serialized frontmatter is byte-distinct across test cases
  // in this block — gray-matter caches parsed results keyed by the raw
  // content string, and two notes with identical frontmatter+body would
  // otherwise share a mutable `data` object across unrelated test cases.
  async function makeSummary(path: string, status: string, id: string): Promise<void> {
    await vault.create(
      path,
      serializeNote(
        {
          id, type: 'source_summary', title: 'Session', status,
          source_type: 'transcript', source_path: 'raw/session.md', ingest_status: 'detected',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        },
        'body.',
      ),
    );
  }

  it('promotes a draft source to active once the agent completes', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'draft', 's1');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.ingest_status).toBe('linked');
    expect(data.status).toBe('active');
  });

  it('recovers an archived source to active (G7)', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'archived', 's2');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('active');
    expect(data.archived_at).toBeUndefined();
    expect(data.archived_reason).toBeUndefined();
  });

  it('never overrides an explicit rejected status', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'rejected', 's3');

    await agentIngestHandler.execute(makeJob(summaryPath, 'raw/session.md'), makeCtx());

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('rejected');
  });

  it('does not promote when intelligence.lifecycle.enabled is false', async () => {
    const summaryPath = 'outputs/source-summaries/session.md';
    await makeSummary(summaryPath, 'draft', 's4');

    await agentIngestHandler.execute(
      makeJob(summaryPath, 'raw/session.md'),
      makeCtx({ intelligence: { lifecycle: { enabled: false } } }),
    );

    const { data } = parseNote(await vault.read(summaryPath));
    expect(data.status).toBe('draft');
  });
});
