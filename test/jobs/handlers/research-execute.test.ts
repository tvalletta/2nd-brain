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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import { parseNote } from '../../../src/vault/frontmatter.js';
import { TransientLLMError } from '../../../src/shared/errors.js';
import type { Job, JobContext } from '../../../src/jobs/types.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

// G2: the handler now constructs a fresh, tier-selected LLM client via
// createLLMFromConfig(config, stateDir, tier) instead of using ctx.llm
// directly (same pattern as glossary-synthesize.ts). Mock it so tests never
// attempt a real Bedrock call; each test wires the mock to return whichever
// fake client it wants the handler to actually use.
vi.mock('../../../src/enrichment/llm-factory.js', () => ({
  createLLMFromConfig: vi.fn(),
}));
import { createLLMFromConfig } from '../../../src/enrichment/llm-factory.js';
import { researchExecuteHandler } from '../../../src/jobs/handlers/research-execute.js';

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
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(llm: LLMClient): JobContext {
    // G2: the handler ignores ctx.llm and builds its own via
    // createLLMFromConfig — wire the mock to hand back this test's fake so
    // these (pre-existing, Task 6) assertions keep exercising the same
    // canned synthesis payload as before.
    vi.mocked(createLLMFromConfig).mockReturnValue(llm as never);
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

const SYNTHESIS_PAYLOAD = {
  tldr: 'A tiny test summary.',
  body: '## What it is\nSomething.',
  claims: [],
  contradictions: [],
  coverage: {
    'what-is': true,
    'why-it-matters': false,
    'how-it-works': false,
    alternatives: false,
    'recent-changes': false,
  },
};

describe('research-execute job handler — budget gate + tier selection (G2)', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-rx-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(config: ReturnType<typeof KarpathyConfigSchema.parse>): JobContext {
    return {
      vaultPath: dir,
      projectRoot: dir,
      enqueue: async () => makeJob('unused', 'light'),
      llm: fakeLLM(SYNTHESIS_PAYLOAD),
      vault,
      config,
    };
  }

  it('skips execution when the light-depth (fast-tier) budget is exhausted, even though medium/heavy have plenty', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 200, heavy: 200 } } },
    });

    await researchExecuteHandler.execute(makeJob('fsrs', 'light'), makeCtx(config));

    // If the handler had incorrectly reserved from 'medium' or 'heavy'
    // instead of 'fast' for a light-depth job, execution would have
    // succeeded (both have plenty of budget) and created the note.
    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(false);
    // The budget check must short-circuit before any LLM client is even
    // constructed for the skipped job.
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it('executes when the medium-depth (medium-tier) budget is available even though fast is exhausted', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 200, heavy: 200 } } },
    });
    vi.mocked(createLLMFromConfig).mockReturnValue(fakeLLM(SYNTHESIS_PAYLOAD) as never);

    await researchExecuteHandler.execute(makeJob('fsrs', 'medium'), makeCtx(config));

    // Proves medium-depth reserves from 'medium', not 'fast' (which is 0),
    // and that the client is built for the 'medium' tier specifically.
    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(true);
    expect(createLLMFromConfig).toHaveBeenCalledWith(config, expect.any(String), 'medium');
  });

  it('skips execution when the heavy-depth (heavy-tier) budget is exhausted, even though fast/medium have plenty', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 200, medium: 200, heavy: 0 } } },
    });

    await researchExecuteHandler.execute(makeJob('raptor', 'heavy'), makeCtx(config));

    expect(await vault.exists('wiki/concepts/raptor.md')).toBe(false);
    expect(createLLMFromConfig).not.toHaveBeenCalled();
  });

  it("executes normally under default budget limits (a single job is well within any tier's daily allowance)", async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    vi.mocked(createLLMFromConfig).mockReturnValue(fakeLLM(SYNTHESIS_PAYLOAD) as never);

    await researchExecuteHandler.execute(makeJob('fsrs', 'heavy'), makeCtx(config));

    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(true);
    // Proves heavy-depth reserves from and builds against the 'heavy' tier,
    // not whatever ctx.llm/config.llm.model would've defaulted to.
    expect(createLLMFromConfig).toHaveBeenCalledWith(config, expect.any(String), 'heavy');
  });

  it('propagates a TransientLLMError from the LLM call unmodified — never caught or downgraded to a skip/fallback', async () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    vi.mocked(createLLMFromConfig).mockReturnValue({
      async complete() {
        throw new TransientLLMError('bedrock unreachable');
      },
      async extractStructured() {
        throw new TransientLLMError('bedrock unreachable');
      },
    } as never);

    await expect(
      researchExecuteHandler.execute(makeJob('fsrs', 'medium'), makeCtx(config)),
    ).rejects.toBeInstanceOf(TransientLLMError);

    // The job aborted rather than silently completing or recording a
    // (nonexistent) synthesis — no note and no queue-completion side effect.
    expect(await vault.exists('wiki/concepts/fsrs.md')).toBe(false);
  });
});
