import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote } from '../../src/vault/frontmatter.js';
import { compileFromSource, type CompilableEntity } from '../../src/compilation/compiler.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

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
  });

  it('llm mode: uncertain drop whose review-item write fails does not crash — entity still ends up in result.created', async () => {
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
});
