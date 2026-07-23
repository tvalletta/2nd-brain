import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { createEntityTool } from '../../../src/agent/tools/create-entity.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { AgentContext } from '../../../src/agent/tool-registry.js';
import type { LLMClient } from '../../../src/enrichment/llm-client.js';

describe('create_entity tool', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-create-entity-tool-'));
    vault = createFsAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeContext(): AgentContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir, layout: { wiki: 'Curated/wiki' } });
    const llm: LLMClient = {
      async complete() { return ''; },
      async extractStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> { return schema.parse({}); },
    };
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input) => ({
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
      }),
      llm,
      config,
      sourceFilePath: 'Curated/wiki/sources/summary-001.md',
      sourceContent: '',
      contentCategory: 'document',
    };
  }

  it('detects an existing entity under a non-default layout instead of creating a duplicate', async () => {
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

    const result = await createEntityTool.execute({ name: 'Jordan Ellis', kind: 'person' }, makeContext());

    expect(result).toContain('Entity already exists:');
    expect(result).toContain('Curated/wiki/entities/jordan-ellis.md');

    const entityFiles = await vault.listMarkdownFiles('Curated/wiki/entities');
    expect(entityFiles).toEqual(['Curated/wiki/entities/jordan-ellis.md']);
  });
});
