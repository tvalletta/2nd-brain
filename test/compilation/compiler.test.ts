import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { compileFromSource, type CompilableEntity } from '../../src/compilation/compiler.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';
import { generateReviewAnalysis } from '../../src/review/generate-review-analysis.js';

vi.mock('../../src/review/generate-review-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/generate-review-analysis.js')>();
  return { ...actual, generateReviewAnalysis: vi.fn() };
});

function makeEntity(overrides: Partial<CompilableEntity> = {}): CompilableEntity {
  return {
    name: 'Zephyr Protocol',
    kind: 'concept',
    context: 'A protocol discussed in the meeting.',
    relationships: [],
    chunkRefs: [],
    ...overrides,
  };
}

function makeLLM(response: unknown): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(response);
    },
  };
}

describe('compileFromSource — significance gate integration', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-compiler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gate off: always creates the page regardless of gate logic', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'off' },
    });
    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'ai' })], // would be dropped by heuristic if the gate were on
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('heuristic mode: confident drop creates no page and no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'heuristic' },
    });
    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'ai' })], // < 3 chars -> heuristic drop, no confidence field
      { vault, llm: makeLLM({}), config, projectRoot: dir },
    );
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(['ai']);
    expect(await vault.listMarkdownFiles('wiki/concepts')).toHaveLength(0);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: confident drop (high confidence) creates no page and no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'generic jargon', confidence: 0.95 });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual(['Zephyr Protocol']);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: uncertain drop (low confidence) still creates the page AND flags it for review', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'keep', reasoning: 'It is a specific term, not generic jargon.', confidence: 0.6, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'maybe jargon', confidence: 0.4 });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(1);
    const reviewFiles = await vault.listMarkdownFiles('review');
    expect(reviewFiles).toHaveLength(1);
    const { data } = parseNote(await vault.read(reviewFiles[0]));
    expect(data.conflict_type).toBe('uncertain_entity_drop');
    expect(data.links).toEqual(result.created);
    const content = await vault.read(reviewFiles[0]);
    expect(content).toContain('It is a specific term, not generic jargon.');
  });

  it('llm mode: uncertain drop whose review-item write fails does not crash — entity still ends up in result.created', async () => {
    vi.mocked(generateReviewAnalysis).mockResolvedValue({
      verdict: 'keep', reasoning: 'Specific term.', confidence: 0.6, tier: 'fast',
    });
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    // Pre-create a real directory at the exact path createReviewItem will try
    // to write the review note to, so the vault's genuine fs write throws
    // (EISDIR) instead of mocking createReviewItem itself — this exercises
    // the real error-containment path, not just a manual mock.
    await mkdir(join(dir, 'review', 'uncertain-drop-zephyr-protocol.md'), { recursive: true });

    const llm = makeLLM({ action: 'drop', reason: 'maybe jargon', confidence: 0.4 });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('a TransientLLMError from generateReviewAnalysis during the uncertain-drop review-item write propagates instead of being swallowed', async () => {
    vi.mocked(generateReviewAnalysis).mockRejectedValue(new TransientLLMError('outage'));
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm', significanceGateDropConfidence: 0.7 },
    });
    const llm = makeLLM({ action: 'drop', reason: 'maybe jargon', confidence: 0.4 });

    await expect(
      compileFromSource('sources/s1.md', [makeEntity()], { vault, llm, config, projectRoot: dir }),
    ).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('llm mode: keep verdict creates the page normally with no review item', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm' },
    });
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm: makeLLM({ action: 'keep' }),
      config,
      projectRoot: dir,
    });
    expect(result.created).toHaveLength(1);
    expect(await vault.listMarkdownFiles('review')).toHaveLength(0);
  });

  it('llm mode: falls back to the heuristic (keep) when the daily budget is exhausted', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm' },
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 0, medium: 50, heavy: 10 } } },
    });
    let called = false;
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        called = true;
        return schema.parse({ action: 'drop', reason: 'x', confidence: 0.99 });
      },
    };
    const result = await compileFromSource('sources/s1.md', [makeEntity()], {
      vault,
      llm,
      config,
      projectRoot: dir,
    });
    expect(called).toBe(false); // budget exhausted -> never reserved -> heuristic path used instead
    expect(result.created).toHaveLength(1); // heuristic keeps non-trivial names
  });

  it('llm mode: a heuristic-dropped entity does not consume a budget slot needed by a later entity', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'llm' },
      intelligence: { budget: { enabled: true, llmCallsPerDay: { fast: 1, medium: 50, heavy: 10 } } },
    });
    let calls = 0;
    const llm: LLMClient = {
      async complete() {
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        calls += 1;
        return schema.parse({ action: 'keep' });
      },
    };
    const result = await compileFromSource(
      'sources/s1.md',
      [
        makeEntity({ name: 'ai' }), // heuristic drop (< 3 chars) -> must not reserve a budget slot
        makeEntity({ name: 'Zephyr Protocol' }), // heuristic keep -> should still get the LLM's judgment
      ],
      { vault, llm, config, projectRoot: dir },
    );
    expect(calls).toBe(1); // only the second entity ever reached the LLM
    expect(result.skipped).toEqual(['ai']);
    expect(result.created).toHaveLength(1); // Zephyr Protocol's llm-mode "keep" verdict created its page
  });
});

describe('compileFromSource — transient error propagation', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-compiler-transient-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('propagates the original TransientLLMError from compileEntityPage instead of swallowing it into result.skipped', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'off' },
    });
    let calls = 0;
    const transientError = new TransientLLMError('VPN down');
    const llm: LLMClient = {
      async complete() {
        calls++;
        throw transientError;
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };

    let caught: unknown;
    let result;
    try {
      result = await compileFromSource(
        'sources/s1.md',
        [makeEntity({ name: 'Entity One' }), makeEntity({ name: 'Entity Two' })],
        { vault, llm, config, projectRoot: dir },
      );
    } catch (err) {
      caught = err;
    }

    expect(result).toBeUndefined();
    expect(caught).toBe(transientError);
    expect(caught).toBeInstanceOf(TransientLLMError);
    // Aborted after the first entity's transient failure — the second
    // entity's compileEntityPage call (which would also call llm.complete)
    // never happened.
    expect(calls).toBe(1);
  });

  it('regression: a plain Error on one entity still results in that entity being skipped and the function returning normally', async () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: dir,
      enrichment: { significanceGate: 'off' },
    });
    let calls = 0;
    const llm: LLMClient = {
      async complete() {
        calls++;
        if (calls === 1) throw new Error('bad model output');
        return '';
      },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };

    const result = await compileFromSource(
      'sources/s1.md',
      [makeEntity({ name: 'Entity One' }), makeEntity({ name: 'Entity Two' })],
      { vault, llm, config, projectRoot: dir },
    );

    expect(result.skipped).toEqual(['Entity One']);
    expect(result.created).toHaveLength(2); // both pages get created; only the compile step failed for Entity One
    expect(calls).toBe(2); // execution continued to the second entity
  });
});
