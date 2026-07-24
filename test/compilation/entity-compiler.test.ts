import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { parseNote, serializeNote } from '../../src/vault/frontmatter.js';
import { compileEntityPage } from '../../src/compilation/entity-compiler.js';
import type { CompilableEntity } from '../../src/compilation/compiler.js';
import type { LLMClient } from '../../src/enrichment/llm-client.js';

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
