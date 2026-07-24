import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../../src/vault/frontmatter.js';
import { migrateConceptGlossaryHandler } from '../../../src/jobs/handlers/migrate-concept-glossary.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(dryRun: boolean): Job {
  return {
    id: 'test-migrate', type: 'migrate-concept-glossary', status: 'running', priority: 50,
    payload: { dryRun }, trigger: 'cli',
    createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 3, debounceMs: 0,
  };
}

describe('migrate-concept-glossary handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir, projectRoot: dir, vault,
      enqueue: async (input: JobCreateInput) => ({
        ...input, id: 'enq', status: 'pending', createdAt: new Date().toISOString(),
        retryCount: 0, maxRetries: 3, debounceMs: 0,
        priority: input.priority ?? 50, payload: input.payload ?? {}, trigger: input.trigger ?? 'cascade',
      } as Job),
      llm: {} as never, config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-migrate-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/decisions');
    await vault.create(
      'wiki/concepts/efficiency.md',
      serializeNote(
        {
          id: 'c1', type: 'concept', title: 'Efficiency', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z',
          source_refs: ['wiki/topics/architectural-best-practices.md'], aliases: [], links: [],
          protected_regions: ['definition'],
        },
        '\n# Efficiency\n\n## Definition\n%% begin:definition %%\nBenchmark for evaluating audit findings.\n%% end:definition %%\n',
      ),
    );
    await vault.create(
      'wiki/decisions/some-decision.md',
      serializeNote(
        { id: 'd1', type: 'decision', title: 'Some Decision', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z', source_refs: [], aliases: [], links: [] },
        '\nSee [[efficiency]] for background.\n',
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dry-run reports what would change without writing anything', async () => {
    const ctx = makeCtx();
    await migrateConceptGlossaryHandler.execute(makeJob(true), ctx);

    // Nothing should have changed on disk.
    expect(await vault.exists('wiki/concepts/efficiency.md')).toBe(true);
    expect(await vault.exists('wiki/concepts/glossary.md')).toBe(false);
    const decisionContent = await vault.read('wiki/decisions/some-decision.md');
    expect(decisionContent).toContain('[[efficiency]]');
  });

  it('real run migrates the page into the glossary, deletes it, and rewrites wikilinks', async () => {
    const ctx = makeCtx();
    await migrateConceptGlossaryHandler.execute(makeJob(false), ctx);

    expect(await vault.exists('wiki/concepts/efficiency.md')).toBe(false);
    const glossary = await vault.read('wiki/concepts/glossary.md');
    expect(glossary).toContain('## Efficiency');
    expect(glossary).toContain('Benchmark for evaluating audit findings.');

    const decisionContent = await vault.read('wiki/decisions/some-decision.md');
    expect(decisionContent).not.toContain('[[efficiency]]');
    expect(decisionContent).toContain('[[glossary#Efficiency]]');
  });

  it('does not self-corrupt the glossary mention for a concept with no recorded source_refs (regression)', async () => {
    // Reproduces the bug: source_refs defaults to [] per the Zod schema, so
    // the handler's `sourceRefs.length > 0 ? sourceRefs : [path]` fallback
    // fires and upsertConceptMention cites the concept's own former slug
    // (e.g. "standalone"). Without excluding glossary.md itself from the
    // wikilink-rewrite scan (which includes the `concepts` folder,
    // glossary.md's own home), that freshly-written citation gets
    // immediately "rewritten" to a self-referential [[glossary#Standalone]],
    // corrupting the very citation the mention was meant to record.
    await vault.create(
      'wiki/concepts/standalone.md',
      serializeNote(
        {
          id: 'c2', type: 'concept', title: 'Standalone', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z',
          source_refs: [], aliases: [], links: [],
          protected_regions: ['definition'],
        },
        '\n# Standalone\n\n## Definition\n%% begin:definition %%\nA concept with no recorded sources.\n%% end:definition %%\n',
      ),
    );

    const ctx = makeCtx();
    await migrateConceptGlossaryHandler.execute(makeJob(false), ctx);

    expect(await vault.exists('wiki/concepts/standalone.md')).toBe(false);
    const glossary = await vault.read('wiki/concepts/glossary.md');
    expect(glossary).toContain('## Standalone');
    // The mention must still cite the concept's own former slug...
    expect(glossary).toContain('[[standalone]]');
    // ...and must NOT have been rewritten into a self-referential glossary
    // anchor link (the corruption this regression test guards against).
    expect(glossary).not.toContain('[[glossary#Standalone]]');
  });
});
