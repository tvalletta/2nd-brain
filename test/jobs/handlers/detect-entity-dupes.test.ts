import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import { serializeNote } from '../../../src/vault/frontmatter.js';
import { detectEntityDupesHandler } from '../../../src/jobs/handlers/detect-entity-dupes.js';
import { readReconciliationQueue } from '../../../src/maintenance/reconciliation-queue.js';
import { KarpathyConfigSchema } from '../../../src/config/schema.js';
import type { Job, JobContext, JobCreateInput } from '../../../src/jobs/types.js';

function makeJob(): Job {
  return {
    id: 'test-detect-dupes',
    type: 'detect-entity-dupes',
    status: 'running',
    priority: 80,
    payload: {},
    trigger: 'cli',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    debounceMs: 0,
  };
}

describe('detect-entity-dupes handler', () => {
  let dir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  function makeCtx(): JobContext {
    const config = KarpathyConfigSchema.parse({ vaultPath: dir });
    return {
      vaultPath: dir,
      projectRoot: dir,
      vault,
      enqueue: async (input: JobCreateInput) => ({
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
      } as Job),
      llm: {} as never,
      config,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-ded-'));
    vault = createFsAdapter(dir);
    await vault.ensureFolder('wiki/entities/people');
    await vault.ensureFolder('wiki/_system');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs without error on empty vault', async () => {
    const ctx = makeCtx();
    await expect(detectEntityDupesHandler.execute(makeJob(), ctx)).resolves.not.toThrow();
  });

  it('writes candidates to reconciliation queue', async () => {
    // Create two similar entity files that share a source ref
    const shared = 'outputs/source-summaries/source1.md';
    const fmA = {
      id: 'alice1',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Alice',
      title: 'Alice',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    const fmB = {
      id: 'alice2',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Alise',
      title: 'Alise',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    await vault.create('wiki/entities/people/alice.md', serializeNote(fmA, ''));
    await vault.create('wiki/entities/people/alise.md', serializeNote(fmB, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);

    // Should have detected Alice/Alise as candidates (Levenshtein distance 1 with shared source)
    expect(queue.entries.length).toBeGreaterThan(0);
    const alicePair = queue.entries.find(
      (e) =>
        (e.sourceName === 'Alice' || e.targetName === 'Alice') &&
        (e.sourceName === 'Alise' || e.targetName === 'Alise'),
    );
    expect(alicePair).toBeDefined();
  });

  it('is idempotent — running twice does not duplicate queue entries', async () => {
    const shared = 'outputs/source-summaries/source2.md';
    const fmX = { id: 'x1', type: 'entity', entity_kind: 'person', canonical_name: 'Dave', title: 'Dave', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_refs: [shared], aliases: [] };
    const fmY = { id: 'y1', type: 'entity', entity_kind: 'person', canonical_name: 'Daev', title: 'Daev', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_refs: [shared], aliases: [] };
    await vault.create('wiki/entities/people/dave.md', serializeNote(fmX, ''));
    await vault.create('wiki/entities/people/daev.md', serializeNote(fmY, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);

    // All entries should be unique pairs
    const pairKeys = new Set(
      queue.entries.map((e) => [e.sourcePath, e.targetPath].sort().join('||')),
    );
    expect(pairKeys.size).toBe(queue.entries.length);
  });

  it('auto-merges candidates at or above the 0.85 confidence threshold', async () => {
    // Alias-overlap match scores confidence 0.95 in entity-merger.ts, well above threshold.
    const shared = 'outputs/source-summaries/source3.md';
    const fmA = {
      id: 'p1',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Patricia Vaughn',
      title: 'Patricia Vaughn',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: ['Pat Vaughn'],
    };
    const fmB = {
      id: 'p2',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Pat Vaughn',
      title: 'Pat Vaughn',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    await vault.create('wiki/entities/people/patricia-vaughn.md', serializeNote(fmA, ''));
    await vault.create('wiki/entities/people/pat-vaughn.md', serializeNote(fmB, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    // One of the two pages should have been deleted by the auto-merge.
    const remaining = await vault.listMarkdownFiles('wiki/entities/people');
    expect(remaining).toHaveLength(1);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);
    // The auto-merged pair should NOT also be sitting in the manual-review queue.
    expect(queue.entries).toHaveLength(0);
  });

  it('queues candidates below the auto-merge threshold instead of merging them', async () => {
    // Levenshtein distance 2, 1 shared source -> confidence 0.8, below threshold.
    const shared = 'outputs/source-summaries/source4.md';
    const fmA = {
      id: 'q1',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Dave',
      title: 'Dave',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    const fmB = {
      id: 'q2',
      type: 'entity',
      entity_kind: 'person',
      canonical_name: 'Daev',
      title: 'Daev',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_refs: [shared],
      aliases: [],
    };
    await vault.create('wiki/entities/people/dave.md', serializeNote(fmA, ''));
    await vault.create('wiki/entities/people/daev.md', serializeNote(fmB, ''));

    const ctx = makeCtx();
    await detectEntityDupesHandler.execute(makeJob(), ctx);

    // Neither page should have been deleted (below auto-merge threshold).
    const remaining = await vault.listMarkdownFiles('wiki/entities/people');
    expect(remaining).toHaveLength(2);

    const layout = KarpathyConfigSchema.parse({ vaultPath: dir }).layout;
    const queue = await readReconciliationQueue(vault, layout);
    expect(queue.entries.length).toBeGreaterThan(0);
  });
});
