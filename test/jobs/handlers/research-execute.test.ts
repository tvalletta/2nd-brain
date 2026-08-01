// Reproduces the REAL execution path end-to-end: a job payload shaped
// exactly like the one G1's auto-drain (research-propose.ts) or the CLI
// (`karpathy intel research <slug> <depth>`, intel-command.ts) actually
// enqueues -- `{ slug, depth }`, no `notePath` -- run through the real
// researchExecuteHandler against a post-B1, Curated/-style production vault
// (glossary.md present in concepts/, real pages under topics/).
//
// This is the exact shape of test the reviewer noted was missing: prior
// coverage only ever called `executeResearch` directly with hand-picked
// arguments, never through the handler with the payload real callers send.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { researchExecuteHandler } from '../../../src/jobs/handlers/research-execute.js';
import { parseNote } from '../../../src/vault/frontmatter.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

function fakeLLM(payload: unknown): LLMClient {
  return {
    async complete() {
      return JSON.stringify(payload);
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(payload);
    },
  };
}

function makeJob(slug: string, depth: 'light' | 'medium' | 'heavy'): Job {
  return {
    id: `job-${slug}`,
    type: 'research-execute',
    status: 'pending',
    priority: 80,
    // Exact payload shape research-propose.ts's G1 auto-drain and
    // intel-command.ts's `research` subcommand both actually send --
    // no `notePath`.
    payload: { slug, depth },
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
    transientRetryCount: 0,
  };
}

describe('research-execute job handler — real call path against Curated/ production vault shape', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  const config = KarpathyConfigSchema.parse({
    vaultPath: '/tmp',
    layout: {
      wiki: 'Curated/wiki',
      system: 'Curated/_system',
      sources: 'Curated/sources',
      review: 'Curated/review',
      aiConversations: 'AI Conversations',
      aiSummaries: 'AI Conversations/_summaries',
      aiLegacy: 'AI Conversations/_legacy',
      digests: 'Curated/wiki/digests',
    },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-re-handler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('Curated/wiki/concepts');
    await vault.create(
      'Curated/wiki/concepts/glossary.md',
      `---\ntype: index\ntitle: Concept glossary\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Concept glossary\n`,
    );
    await vault.ensureFolder('Curated/wiki/topics');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(llm: LLMClient): JobContext {
    return {
      vaultPath: dir,
      projectRoot: dir,
      enqueue: async () => makeJob('unused', 'light'),
      llm,
      vault,
      config,
    };
  }

  it('runs a genuinely new (never-yet-researched) topic candidate to completion', async () => {
    await vault.create(
      'Curated/wiki/topics/architectural-best-practices.md',
      `---\ntype: topic\ntitle: Architectural best practices\ncreated_at: 2026-05-01T00:00:00Z\nupdated_at: 2026-05-01T00:00:00Z\n---\n# Architectural best practices\n`,
    );
    const llm = fakeLLM({
      tldr: 'Best practices summary.',
      body: '## What it is\nGuidance.',
      claims: [],
      contradictions: [],
      coverage: { 'what-is': true, 'why-it-matters': false, 'how-it-works': false, alternatives: false, 'recent-changes': false },
    });

    await researchExecuteHandler.execute(makeJob('architectural-best-practices', 'light'), makeCtx(llm));

    const note = await vault.read('Curated/wiki/topics/architectural-best-practices.md');
    const { data } = parseNote(note);
    expect(data.type).toBe('topic');
    expect(data.last_research_depth).toBe('light');
    expect(await vault.exists('Curated/wiki/concepts/architectural-best-practices.md')).toBe(false);
  });

  it('runs an update to an already-researched, existing topic candidate to completion', async () => {
    await vault.create(
      'Curated/wiki/topics/feedback.md',
      `---\ntype: topic\ntitle: Feedback\ncreated_at: 2026-05-01T00:00:00Z\nupdated_at: 2026-05-01T00:00:00Z\nlast_research_depth: light\nlast_research_at: 2026-05-01T00:00:00Z\n---\n# Feedback\n`,
    );
    const llm = fakeLLM({
      tldr: 'Updated feedback summary.',
      body: '## What it is\nUpdated guidance.',
      claims: [],
      contradictions: [],
      coverage: { 'what-is': true, 'why-it-matters': false, 'how-it-works': false, alternatives: false, 'recent-changes': false },
    });

    await researchExecuteHandler.execute(makeJob('feedback', 'medium'), makeCtx(llm));

    const note = await vault.read('Curated/wiki/topics/feedback.md');
    const { data, body } = parseNote(note);
    expect(data.type).toBe('topic');
    expect(data.last_research_depth).toBe('medium');
    expect(body).toContain('Updated feedback summary');
  });
});
