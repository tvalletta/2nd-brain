import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote, serializeNote } from '../../src/vault/frontmatter.js';
import { compileEntityPage } from '../../src/compilation/entity-compiler.js';
import type { CompilableEntity } from '../../src/compilation/compiler.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { TransientLLMError } from '../../src/shared/errors.js';

function makeLLM(): LLMClient {
  return {
    async complete(prompt: string) {
      if (prompt.includes('CONTEXT:') && prompt.includes('OUTCOME:')) {
        // Prompt is asking for the fixed section shape.
        return `CONTEXT:
We decided to use Bedrock because it integrates with existing AWS infra.

OUTCOME:
Deployed successfully in Q2.

PEOPLE:
(none)

SOURCES:
- source1.md`;
      }
      // Prompt is still asking for the old/buggy section shape
      // (SUMMARY/PROJECTS/TOPICS) — respond in that shape too. Since
      // KIND_SECTIONS.decision is ['context','outcome','people','sources'],
      // "SUMMARY" won't match either 'context' or 'outcome', reproducing
      // the pre-fix bug where those two regions never get populated.
      return `SUMMARY:
We decided to use Bedrock because it integrates with existing AWS infra.

PEOPLE:
(none)

PROJECTS:
(none)

TOPICS:
(none)

SOURCES:
- source1.md`;
    },
    async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
      return schema.parse({});
    },
  };
}

describe('compileEntityPage — decision section labels', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-entity-compiler-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/decisions');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes CONTEXT and OUTCOME sections into the context/outcome protected regions', async () => {
    const path = 'wiki/decisions/some-decision.md';
    await vault.create(
      path,
      serializeNote(
        {
          id: 'd1', type: 'decision', title: 'Some Decision', decision_status: 'proposed',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          source_refs: [], aliases: [], links: [],
          protected_regions: ['context', 'outcome', 'people', 'sources'],
        },
        `
# Some Decision

## Context
%% begin:context %%
Pending enrichment.
%% end:context %%

## Outcome
%% begin:outcome %%
%% end:outcome %%

## Key People
%% begin:people %%
%% end:people %%

## Source References
%% begin:sources %%
%% end:sources %%
`,
      ),
    );

    const entity: CompilableEntity = {
      name: 'Some Decision',
      kind: 'decision',
      context: 'We decided to use Bedrock.',
      relationships: [],
      chunkRefs: [],
    };

    await compileEntityPage(entity, path, 'sources/source1.md', { vault, llm: makeLLM() });

    const { body } = parseNote(await vault.read(path));
    expect(body).toContain('We decided to use Bedrock because it integrates with existing AWS infra.');
    expect(body).toContain('Deployed successfully in Q2.');
  });
});

describe('compileEntityPage — web enrichment transient error propagation', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let path: string;
  let entity: CompilableEntity;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-entity-compiler-web-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/topics');

    path = 'wiki/topics/some-topic.md';
    await vault.create(
      path,
      serializeNote(
        {
          id: 't1', type: 'topic', title: 'Some Topic',
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
          source_refs: [], aliases: [], links: [],
          protected_regions: ['definition', 'projects', 'people', 'related-concepts', 'discussions', 'sources'],
        },
        `
# Some Topic

## Definition
%% begin:definition %%
Pending enrichment.
%% end:definition %%

## Projects
%% begin:projects %%
%% end:projects %%

## Key People
%% begin:people %%
%% end:people %%

## Related Concepts
%% begin:related-concepts %%
%% end:related-concepts %%

## Discussions
%% begin:discussions %%
%% end:discussions %%

## Source References
%% begin:sources %%
%% end:sources %%
`,
      ),
    );

    entity = {
      name: 'Some Topic',
      kind: 'topic',
      context: 'Discussed at length in the source material.',
      relationships: [],
      chunkRefs: [],
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('propagates TransientLLMError raised inside the web-enrichment step instead of completing normally', async () => {
    const transientError = new TransientLLMError('VPN down');
    const llm: LLMClient = {
      async complete(prompt: string) {
        // The main compile-page prompt: return a response that leaves
        // the definition region unpopulated (so it stays thin and
        // web-enrichment still fires), matching no expected sections.
        if (prompt.includes('encyclopedia writer')) {
          throw transientError;
        }
        return 'NOOP:\n(nothing to see here)';
      },
      async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };

    let caught: unknown;
    try {
      await compileEntityPage(entity, path, 'sources/source1.md', { vault, llm });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(transientError);
    expect(caught).toBeInstanceOf(TransientLLMError);

    // The page must not have been written — the write happens after the
    // web-enrichment step, so a propagated error means no atomicWrite.
    // (Asserting on the raw string, not a re-parsed object: gray-matter's
    // internal parse cache returns the same, in-place-mutated `data` object
    // for byte-identical input, which would mask a real write vs. an
    // in-memory-only mutation that never reached disk.)
    const raw = await vault.read(path);
    expect(raw).toContain("updated_at: '2025-01-01T00:00:00Z'");
  });

  it('regression: a plain Error inside the web-enrichment step still writes the page normally without enrichment', async () => {
    const llm: LLMClient = {
      async complete(prompt: string) {
        if (prompt.includes('encyclopedia writer')) {
          throw new Error('model unavailable');
        }
        return 'NOOP:\n(nothing to see here)';
      },
      async extractStructured<T>(_p: string, schema: import('zod').ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };

    const result = await compileEntityPage(entity, path, 'sources/source1.md', { vault, llm });

    expect(result).toBe(path);
    const { body, data } = parseNote(await vault.read(path));
    // Definition region remains untouched (still thin/pending) — enrichment
    // failed but the page write still completed normally.
    expect(body).toContain('Pending enrichment.');
    expect(data.updated_at).not.toBe('2025-01-01T00:00:00Z');
  });
});
